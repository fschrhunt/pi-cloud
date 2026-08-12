import { createPublicKey } from "node:crypto";
import { verifyTaskLease, type TaskLeaseClaims } from "@pi-cloud/contracts";
import { z } from "zod";

const runnerConfigSchema = z.object({
  controlPlaneUrl: z.url(),
  taskLease: z.string().min(1),
  taskLeasePublicKey: z.string().min(1),
  taskLeaseIssuer: z.string().min(1).default("pi-cloud-control-plane"),
  runnerAudience: z.string().min(1),
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
