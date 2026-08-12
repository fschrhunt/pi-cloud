import { createPrivateKey } from "node:crypto";
import { z } from "zod";

const apiCredentialSchema = z.object({
  token: z.string().min(32),
  subjectId: z.string().min(1).max(200),
  type: z.enum(["user", "service"]),
  displayName: z.string().min(1).max(200),
});
export type ApiCredential = z.infer<typeof apiCredentialSchema>;

const apiConfigSchema = z.object({
  dispatcherToken: z.string().min(32),
  taskLeasePrivateKey: z.string().min(1),
  taskLeaseIssuer: z.string().min(1).default("pi-cloud-control-plane"),
  databasePath: z.string().min(1).default("./data/pi-cloud.sqlite"),
  apiCredentials: z.array(apiCredentialSchema).min(1),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

/** Reads and validates durable storage, API identities, and Ed25519 lease authority. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  let apiCredentials: unknown;
  try {
    apiCredentials = JSON.parse(env.PI_CLOUD_API_CREDENTIALS ?? "[]") as unknown;
  } catch {
    throw new Error("PI_CLOUD_API_CREDENTIALS must be a JSON array");
  }

  const config = apiConfigSchema.parse({
    dispatcherToken: env.PI_CLOUD_DISPATCHER_TOKEN,
    taskLeasePrivateKey: env.PI_CLOUD_TASK_LEASE_PRIVATE_KEY,
    taskLeaseIssuer: env.PI_CLOUD_TASK_LEASE_ISSUER,
    databasePath: env.PI_CLOUD_DATABASE_PATH,
    apiCredentials,
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
