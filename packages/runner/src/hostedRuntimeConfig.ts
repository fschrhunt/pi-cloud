import { delimiter, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { parseControlPlaneUrl } from "./config.js";
import { HostedRuntimeDispatcherClient, runHostedRuntimeWorker } from "./hostedRuntimeWorker.js";

const piExecutableSchema = z.string().min(1).refine(
  (value) => isAbsolute(value) || (!value.includes("/") && !value.includes("\\")),
  "Pi executable must be a PATH command name or an absolute trusted path",
);
const hostedWorkerConfigSchema = z.object({
  dispatcherUrl: z.string().min(1),
  dispatcherToken: z.string().min(1),
  runnerId: z.string().min(1).max(200),
  workspaceRoots: z.string().min(1),
  sessionRoots: z.string().min(1),
  agentRoots: z.string().min(1),
  processIsolation: z.enum(["workspace_uid", "inherit"]).default("workspace_uid"),
  piExecutable: piExecutableSchema.optional(),
});

/** Validates that Pi resolves only through trusted PATH or an absolute image path, never the workspace. */
export function parseHostedPiExecutable(value: unknown): string | undefined {
  return piExecutableSchema.optional().parse(value);
}

/** Reads production hosted-worker authority separately from the leased one-shot runner configuration. */
export async function runHostedRuntimeWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<boolean> {
  const config = hostedWorkerConfigSchema.parse({
    dispatcherUrl: env.PI_CLOUD_HOSTED_DISPATCHER_URL,
    dispatcherToken: env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN,
    runnerId: env.PI_CLOUD_RUNNER_ID,
    workspaceRoots: env.PI_CLOUD_HOSTED_WORKSPACE_ROOTS,
    sessionRoots: env.PI_CLOUD_HOSTED_SESSION_ROOTS,
    agentRoots: env.PI_CLOUD_HOSTED_AGENT_ROOTS,
    processIsolation: env.PI_CLOUD_HOSTED_PROCESS_ISOLATION,
    piExecutable: env.PI_CLOUD_PI_EXECUTABLE,
  });
  const dispatcherUrl = parseControlPlaneUrl(config.dispatcherUrl);

  return runHostedRuntimeWorker({
    dispatcher: new HostedRuntimeDispatcherClient(dispatcherUrl, config.dispatcherToken),
    runnerId: config.runnerId,
    authorizedRoots: {
      workspaceRoots: parseRoots(config.workspaceRoots),
      sessionRoots: parseRoots(config.sessionRoots),
      agentRoots: parseRoots(config.agentRoots),
    },
    piExecutable: config.piExecutable,
    processIsolation: config.processIsolation,
    signal,
  });
}

function parseRoots(value: string): string[] {
  return value.split(delimiter).filter(Boolean).map((root) => resolve(root));
}
