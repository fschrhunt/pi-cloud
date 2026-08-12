import { z } from "zod";
import { immutableRevisionSchema, repositoryUrlSchema } from "./repository.js";

/**
 * Credential-free evidence that a runner materialized exactly the leased revision. The schema is
 * strict so a runner cannot append a token, header, or command line to a durable record, and every
 * safety-relevant field is a literal so a weaker checkout cannot be reported as a hardened one.
 */
export const checkoutProvenanceSchema = z
  .object({
    repositoryUrl: repositoryUrlSchema,
    revision: immutableRevisionSchema,
    resolvedCommit: immutableRevisionSchema,
    transport: z.enum(["https", "local-fixture"]),
    credentialSource: z.enum(["anonymous", "short-lived-repository-token", "local-fixture"]),
    credentialScrubbed: z.literal(true),
    submodulesInitialized: z.literal(false),
    hooksDisabled: z.literal(true),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resolvedCommit !== value.revision) {
      context.addIssue({
        code: "custom",
        message: "resolvedCommit must equal the authorized revision",
        path: ["resolvedCommit"],
      });
    }
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must not precede startedAt",
        path: ["completedAt"],
      });
    }
    if (value.transport === "local-fixture" && value.credentialSource !== "local-fixture") {
      context.addIssue({
        code: "custom",
        message: "local-fixture transport must report local-fixture credentials",
        path: ["credentialSource"],
      });
    }
    if (value.transport === "https" && value.credentialSource === "local-fixture") {
      context.addIssue({
        code: "custom",
        message: "HTTPS transport cannot report local-fixture credentials",
        path: ["credentialSource"],
      });
    }
  });

export type CheckoutProvenance = z.infer<typeof checkoutProvenanceSchema>;
