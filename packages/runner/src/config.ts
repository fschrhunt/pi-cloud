import { createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyTaskLease, type TaskLeaseClaims } from "@pi-cloud/contracts";
import { z } from "zod";

const runnerIdentifierSchema = z.string().min(1).max(200);
const controlPlaneUrlSchema = z.string().superRefine((value, context) => {
  try {
    parseControlPlaneUrl(value);
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "PI_CLOUD_CONTROL_PLANE_URL is invalid",
    });
  }
});
const workspaceRootSchema = z.string().min(1).transform((value) => resolve(value));
const runnerConfigSchema = z.object({
  controlPlaneUrl: controlPlaneUrlSchema,
  taskLease: z.string().min(1),
  taskLeasePublicKey: z.string().min(1),
  taskLeaseIssuer: z.string().min(1).default("pi-cloud-control-plane"),
  runnerAudience: z.string().min(1),
  runnerId: runnerIdentifierSchema,
  workspaceRoot: workspaceRootSchema.default(join(tmpdir(), "pi-cloud-runner")),
});

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

/** Reads the signed single-task lease configuration required by a runner. */
export function readRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const config = runnerConfigSchema.parse({
    controlPlaneUrl: env.PI_CLOUD_CONTROL_PLANE_URL,
    taskLease: env.PI_CLOUD_TASK_LEASE,
    taskLeasePublicKey: env.PI_CLOUD_TASK_LEASE_PUBLIC_KEY,
    taskLeaseIssuer: env.PI_CLOUD_TASK_LEASE_ISSUER,
    runnerAudience: env.PI_CLOUD_RUNNER_AUDIENCE,
    runnerId: env.PI_CLOUD_RUNNER_ID,
    workspaceRoot: env.PI_CLOUD_WORKSPACE_ROOT,
  });

  readPublicKey(config.taskLeasePublicKey);
  return config;
}

/** Verifies that this runner was granted short-lived authority for exactly one task. */
export function readTaskLease(config: RunnerConfig, now?: Date): TaskLeaseClaims {
  return verifyTaskLease(config.taskLease, {
    publicKey: readPublicKey(config.taskLeasePublicKey),
    issuer: config.taskLeaseIssuer,
    audience: config.runnerAudience,
    now,
  });
}

/** Parses a control-plane URL, allowing HTTPS everywhere and HTTP only for loopback development. */
export function parseControlPlaneUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PI_CLOUD_CONTROL_PLANE_URL must be an absolute URL");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new Error("PI_CLOUD_CONTROL_PLANE_URL must use HTTPS or loopback HTTP");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function readPublicKey(encodedKey: string) {
  let key;
  try {
    key = createPublicKey({
      key: Buffer.from(encodedKey, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("PI_CLOUD_TASK_LEASE_PUBLIC_KEY must contain a valid Ed25519 SPKI key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("PI_CLOUD_TASK_LEASE_PUBLIC_KEY must contain an Ed25519 SPKI key");
  }
  return key;
}
