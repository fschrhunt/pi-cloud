import { createPrivateKey } from "node:crypto";
import { z } from "zod";

const apiConfigSchema = z.object({
  dispatcherToken: z.string().min(32),
  taskLeasePrivateKey: z.string().min(1),
  taskLeaseIssuer: z.string().min(1).default("pi-cloud-control-plane"),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

/** Reads and validates the control plane's Ed25519 lease-signing configuration. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const config = apiConfigSchema.parse({
    dispatcherToken: env.PI_CLOUD_DISPATCHER_TOKEN,
    taskLeasePrivateKey: env.PI_CLOUD_TASK_LEASE_PRIVATE_KEY,
    taskLeaseIssuer: env.PI_CLOUD_TASK_LEASE_ISSUER,
  });
  let key;
  try {
    key = createPrivateKey({
      key: Buffer.from(config.taskLeasePrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("PI_CLOUD_TASK_LEASE_PRIVATE_KEY must contain a valid Ed25519 PKCS8 key");
  }

  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("PI_CLOUD_TASK_LEASE_PRIVATE_KEY must contain an Ed25519 PKCS8 key");
  }

  return config;
}
