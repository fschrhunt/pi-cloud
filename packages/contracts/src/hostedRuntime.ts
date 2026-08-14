import { isAbsolute } from "node:path";
import { z } from "zod";
import { immutableRevisionSchema, repositoryUrlSchema } from "./repository.js";

const absolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");

/** A reference to a credential that the runner resolves without putting its value on the wire. */
export const hostedCredentialReferenceSchema = z
  .object({
    name: z.string().min(1).max(200),
    reference: z.string().min(1).max(1_024),
    environmentVariable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
  })
  .strict();

export const hostedCredentialReferencesSchema = z.array(hostedCredentialReferenceSchema).max(100).superRefine((references, context) => {
  const names = new Set<string>();
  const environmentVariables = new Set<string>();
  for (const [index, reference] of references.entries()) {
    if (names.has(reference.name)) {
      context.addIssue({ code: "custom", message: "credential reference names must be unique", path: [index, "name"] });
    }
    if (environmentVariables.has(reference.environmentVariable)) {
      context.addIssue({
        code: "custom",
        message: "credential environment variables must be unique",
        path: [index, "environmentVariable"],
      });
    }
    names.add(reference.name);
    environmentVariables.add(reference.environmentVariable);
  }
});

export const hostedRuntimeLimitsSchema = z
  .object({
    wallTimeSeconds: z.number().int().positive(),
    idleTimeSeconds: z.number().int().positive(),
    terminationGraceSeconds: z.number().int().nonnegative(),
    maxRecordBytes: z.number().int().positive(),
    maxCumulativeBytes: z.number().int().positive(),
  })
  .strict()
  .refine((limits) => limits.maxCumulativeBytes >= limits.maxRecordBytes, {
    message: "maxCumulativeBytes must be at least maxRecordBytes",
    path: ["maxCumulativeBytes"],
  });

export const nativePiSessionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new"),
      sessionDirectory: absolutePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resume"),
      sessionFile: absolutePathSchema,
    })
    .strict(),
]);

/** Version 1 authority and process inputs for one persistent hosted Pi runtime. */
export const hostedRuntimeLaunchSchema = z
  .object({
    version: z.literal(1),
    hostedSessionId: z.uuid(),
    workspaceId: z.uuid(),
    workspaceRoot: absolutePathSchema,
    repository: z
      .object({
        repositoryUrl: repositoryUrlSchema,
        revision: immutableRevisionSchema,
      })
      .strict(),
    nativeSession: nativePiSessionTargetSchema,
    piAgentDirectory: absolutePathSchema,
    credentialReferences: hostedCredentialReferencesSchema,
    limits: hostedRuntimeLimitsSchema,
    projectTrust: z.enum(["trusted", "untrusted"]),
  })
  .strict();

export type HostedCredentialReference = z.infer<typeof hostedCredentialReferenceSchema>;
export type HostedRuntimeLimits = z.infer<typeof hostedRuntimeLimitsSchema>;
export type NativePiSessionTarget = z.infer<typeof nativePiSessionTargetSchema>;
export type HostedRuntimeLaunch = z.infer<typeof hostedRuntimeLaunchSchema>;
