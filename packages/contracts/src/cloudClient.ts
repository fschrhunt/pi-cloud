import { z } from "zod";
import { repositoryUrlSchema } from "./repository.js";

/** Protocol version shared by the Mac extension and the self-hosted API. */
export const cloudClientProtocolVersion = 1 as const;

const localDevelopmentHostPattern = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/** Validates a configured Pi Cloud API origin without accepting embedded credentials or URL data. */
export const cloudServerUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "serverUrl must be an absolute URL" });
      return z.NEVER;
    }
    const localDevelopment = localDevelopmentHostPattern.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && localDevelopment)) {
      context.addIssue({ code: "custom", message: "serverUrl must use HTTPS except for local development" });
      return z.NEVER;
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      context.addIssue({ code: "custom", message: "serverUrl must not contain credentials, a query, or a fragment" });
      return z.NEVER;
    }
    return url.toString().replace(/\/+$/u, "");
  });

/** Versioned local configuration read by the Pi Cloud extension on a client Mac. */
export const cloudClientConfigSchema = z
  .object({
    version: z.literal(cloudClientProtocolVersion),
    serverUrl: cloudServerUrlSchema,
    token: z.string().min(32).max(4_096),
  })
  .strict();

/** Safe unauthenticated capability document used before a hosted session is created. */
export const cloudServerCapabilitiesSchema = z
  .object({
    service: z.literal("pi-cloud-api"),
    protocolVersion: z.literal(cloudClientProtocolVersion),
    hostedRpcVersion: z.literal(1),
    features: z
      .object({
        hostedSessions: z.literal(true),
        reconnect: z.literal(true),
        nativeSessionResume: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Public workspace fields consumed by the extension; server filesystem paths are intentionally absent. */
export const cloudWorkspaceSchema = z.object({
  id: z.uuid(),
  repositoryUrl: repositoryUrlSchema,
  revision: z.string().regex(/^[0-9a-f]{40}$/u),
  projectTrust: z.enum(["trusted", "untrusted"]),
  status: z.literal("active"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const cloudHostedSessionSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  state: z.enum(["queued", "starting", "running", "stopped", "archived"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});

export const cloudWorkspaceListSchema = z
  .object({
    items: z.array(cloudWorkspaceSchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const cloudHostedSessionListSchema = z
  .object({
    items: z.array(cloudHostedSessionSchema).max(1_000),
  })
  .strict();

export const cloudRpcTicketSchema = z
  .object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type CloudClientConfig = z.infer<typeof cloudClientConfigSchema>;
export type CloudServerCapabilities = z.infer<typeof cloudServerCapabilitiesSchema>;
export type CloudWorkspace = z.infer<typeof cloudWorkspaceSchema>;
export type CloudHostedSession = z.infer<typeof cloudHostedSessionSchema>;
