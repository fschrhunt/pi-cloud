import { delimiter, resolve } from "node:path";
import { z } from "zod";
import { parseControlPlaneUrl } from "./config.js";
import { HostedRuntimeDispatcherClient, runHostedRuntimeWorker, type ResolvedHostedCredentials } from "./hostedRuntimeWorker.js";

const hostedWorkerConfigSchema = z.object({
  dispatcherUrl: z.string().min(1),
  dispatcherToken: z.string().min(1),
  runnerId: z.string().min(1).max(200),
  workspaceRoots: z.string().min(1),
  sessionRoots: z.string().min(1),
  agentRoots: z.string().min(1),
  piExecutable: z.string().min(1).optional(),
});

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
    resolveCredentials: async (references) => resolveCredentialEnvironment(references, env),
    signal,
  });
}

function parseRoots(value: string): string[] {
  return value.split(delimiter).filter(Boolean).map((root) => resolve(root));
}

function resolveCredentialEnvironment(
  references: readonly { reference: string; environmentVariable: string }[],
  env: NodeJS.ProcessEnv,
): ResolvedHostedCredentials {
  const encoded = env.PI_CLOUD_HOSTED_CREDENTIALS;
  delete env.PI_CLOUD_HOSTED_CREDENTIALS;
  if (references.length === 0) return { environment: {}, secrets: [] };
  if (!encoded) throw new Error("PI_CLOUD_HOSTED_CREDENTIALS is required by the claimed launch");

  const values = z.record(z.string(), z.string().min(1)).parse(JSON.parse(encoded));
  const environment: Record<string, string> = {};
  for (const reference of references) {
    const value = values[reference.reference];
    if (!value) throw new Error(`Credential reference ${reference.reference} is unavailable`);
    environment[reference.environmentVariable] = value;
  }
  const secrets = Object.values(values);
  for (const key of Object.keys(values)) values[key] = "";
  return { environment, secrets };
}
