import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkoutExactRevision } from "./checkout.js";
import { readRunnerConfig, readTaskLease } from "./config.js";
import { ControlPlaneClient, type RunnerControlPlaneClient } from "./controlPlaneClient.js";

export type RunnerDependencies = {
  checkoutExactRevision: typeof checkoutExactRevision;
  createWorkspace: (workspaceRoot: string, taskId: string) => Promise<string>;
  removeWorkspace: (workspacePath: string) => Promise<void>;
  createControlPlaneClient: (controlPlaneUrl: string, taskLease: string) => RunnerControlPlaneClient;
  log: (message: string) => void;
};

/** Redeems a leased task, performs the hardened checkout, reports provenance, and scrubs the workspace. */
export async function runRunner(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<RunnerDependencies> = {},
): Promise<void> {
  const config = readRunnerConfig(env);
  const lease = readTaskLease(config);
  const runner = {
    checkoutExactRevision,
    createWorkspace,
    removeWorkspace,
    createControlPlaneClient,
    log: (message: string) => console.log(message),
    ...dependencies,
  } satisfies RunnerDependencies;

  const controlPlane = runner.createControlPlaneClient(config.controlPlaneUrl, config.taskLease);
  const redeemed = await controlPlane.redeemLease(config.runnerId);
  if (redeemed.taskId !== lease.taskId) {
    throw new Error(`Control plane redeemed task ${redeemed.taskId} for lease ${lease.taskId}`);
  }
  const workspacePath = await runner.createWorkspace(config.workspaceRoot, lease.taskId);

  try {
    const provenance = await runner.checkoutExactRevision({
      checkoutPath: join(workspacePath, "repository"),
      revision: lease.revision,
      source: { kind: "https-url", repositoryUrl: lease.repositoryUrl },
      scratchRoot: workspacePath,
    });
    await controlPlane.reportCheckoutProvenance(redeemed.runId, provenance);
    runner.log(`Runner ${config.runnerId} checked out ${lease.revision} for task ${lease.taskId}`);
  } finally {
    await runner.removeWorkspace(workspacePath);
  }
}

/** Creates the production control-plane client bound to one signed task lease. */
export function createControlPlaneClient(controlPlaneUrl: string, taskLease: string): RunnerControlPlaneClient {
  return new ControlPlaneClient(new URL(controlPlaneUrl), taskLease);
}

async function createWorkspace(workspaceRoot: string, taskId: string): Promise<string> {
  await fs.mkdir(workspaceRoot, { recursive: true });
  return fs.mkdtemp(join(workspaceRoot, `${taskId}-`));
}

async function removeWorkspace(workspacePath: string): Promise<void> {
  await fs.rm(workspacePath, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runRunner();
  } catch (error: unknown) {
    console.error("Runner execution failed.");
    console.error(error);
    process.exitCode = 1;
  }
}
