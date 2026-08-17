import { createPrivateKey } from "node:crypto";
import { isAbsolute } from "node:path";
import { hostedCredentialReferencesSchema, hostedRuntimeLimitsSchema } from "@pi-cloud/contracts";
import { z } from "zod";

const apiCredentialSchema = z.object({
  token: z.string().min(32),
  subjectId: z.string().min(1).max(200),
  type: z.enum(["user", "service"]),
  displayName: z.string().min(1).max(200),
});
export type ApiCredential = z.infer<typeof apiCredentialSchema>;

const absolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");

const defaultHostedLaunchLimits = {
  wallTimeSeconds: 3_600,
  idleTimeSeconds: 300,
  terminationGraceSeconds: 5,
  maxRecordBytes: 65_536,
  maxCumulativeBytes: 10_000_000,
};

/**
 * A hosted runtime tunnel URL is derived from this base, never from an inbound request header, so
 * a spoofed Host cannot redirect a runner's scoped bearer credential to an attacker-controlled origin.
 */
const publicBaseUrlSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "publicBaseUrl must be an absolute URL" });
      return z.NEVER;
    }
    const localDevelopmentHost = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|host\.docker\.internal)$/u.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && localDevelopmentHost)) {
      context.addIssue({ code: "custom", message: "publicBaseUrl must use HTTPS except for local development hosts" });
      return z.NEVER;
    }
    return url.toString().replace(/\/+$/u, "");
  });

const hostedCredentialValuesSchema = z.record(z.string().min(1).max(1_024), z.string().min(1).max(65_536));

const apiConfigSchema = z
  .object({
    dispatcherToken: z.string().min(32),
    taskLeasePrivateKey: z.string().min(1),
    taskLeaseIssuer: z.string().min(1).default("pi-cloud-control-plane"),
    databasePath: z.string().min(1).default("./data/pi-cloud.sqlite"),
    apiCredentials: z.array(apiCredentialSchema).min(1),
    publicBaseUrl: publicBaseUrlSchema,
    runtimeWorkspaceRoot: absolutePathSchema,
    runtimeAgentDirectory: absolutePathSchema,
    hostedLaunchLimits: hostedRuntimeLimitsSchema.default(defaultHostedLaunchLimits),
    hostedCredentialReferences: hostedCredentialReferencesSchema.default([]),
    hostedCredentialValues: hostedCredentialValuesSchema.default({}),
  })
  .superRefine((config, context) => {
    const configuredReferences = new Set(config.hostedCredentialReferences.map((credential) => credential.reference));
    const credentialBytes = Object.values(config.hostedCredentialValues)
      .reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    if (credentialBytes > 65_536) {
      context.addIssue({ code: "custom", message: "credential values exceed 65536 UTF-8 bytes", path: ["hostedCredentialValues"] });
    }
    for (const [index, credential] of config.hostedCredentialReferences.entries()) {
      if (!Object.hasOwn(config.hostedCredentialValues, credential.reference)) {
        context.addIssue({
          code: "custom",
          message: "configured credential reference has no value",
          path: ["hostedCredentialReferences", index, "reference"],
        });
      }
    }
    for (const reference of Object.keys(config.hostedCredentialValues)) {
      if (!configuredReferences.has(reference)) {
        context.addIssue({
          code: "custom",
          message: "credential value has no configured reference",
          path: ["hostedCredentialValues", reference],
        });
      }
    }
  });

export type ApiConfig = z.infer<typeof apiConfigSchema>;

/** Reads and validates durable storage, API identities, Ed25519 lease authority, and hosted runtime defaults. */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  let apiCredentials: unknown;
  try {
    apiCredentials = JSON.parse(env.PI_CLOUD_API_CREDENTIALS ?? "[]") as unknown;
  } catch {
    throw new Error("PI_CLOUD_API_CREDENTIALS must be a JSON array");
  }
  let hostedLaunchLimits: unknown;
  try {
    hostedLaunchLimits = env.PI_CLOUD_HOSTED_LAUNCH_LIMITS ? JSON.parse(env.PI_CLOUD_HOSTED_LAUNCH_LIMITS) : undefined;
  } catch {
    throw new Error("PI_CLOUD_HOSTED_LAUNCH_LIMITS must be a JSON object");
  }
  let hostedCredentialReferences: unknown;
  try {
    hostedCredentialReferences = JSON.parse(env.PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES ?? "[]") as unknown;
  } catch {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES must be a JSON array");
  }
  let hostedCredentialValues: unknown;
  try {
    hostedCredentialValues = JSON.parse(env.PI_CLOUD_HOSTED_CREDENTIALS ?? "{}") as unknown;
  } catch {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIALS must be a JSON object");
  }

  const config = apiConfigSchema.parse({
    dispatcherToken: env.PI_CLOUD_DISPATCHER_TOKEN,
    taskLeasePrivateKey: env.PI_CLOUD_TASK_LEASE_PRIVATE_KEY,
    taskLeaseIssuer: env.PI_CLOUD_TASK_LEASE_ISSUER,
    databasePath: env.PI_CLOUD_DATABASE_PATH,
    apiCredentials,
    publicBaseUrl: env.PI_CLOUD_PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PORT ?? "3000"}`,
    runtimeWorkspaceRoot: env.PI_CLOUD_RUNTIME_WORKSPACE_ROOT ?? "/var/lib/pi-cloud/workspaces",
    runtimeAgentDirectory: env.PI_CLOUD_RUNTIME_AGENT_DIRECTORY ?? "/var/lib/pi-cloud/agent",
    hostedLaunchLimits,
    hostedCredentialReferences,
    hostedCredentialValues,
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
