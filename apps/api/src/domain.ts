import { checkoutProvenanceSchema, immutableRevisionSchema, repositoryUrlSchema, type CheckoutProvenance } from "@pi-cloud/contracts";
import { z } from "zod";

export const revisionSchema = immutableRevisionSchema;

export const runStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "canceling",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const terminalRunStatuses = new Set<RunStatus>(["succeeded", "failed", "canceled"]);
export const activeRunStatuses = new Set<RunStatus>([
  "queued",
  "assigned",
  "running",
  "canceling",
  "waiting",
]);

export const runBudgetsSchema = z
  .object({
    wallTimeSeconds: z.number().int().min(30).max(86_400).default(3_600),
    idleTimeSeconds: z.number().int().min(15).max(3_600).default(120),
    cpuSeconds: z.number().nonnegative().max(86_400).default(3_600),
    memoryMb: z.number().int().min(128).max(65_536).default(4_096),
    artifactBytes: z.number().int().nonnegative().max(1_000_000_000).default(50_000_000),
    eventCount: z.number().int().min(1).max(100_000).default(10_000),
    eventBytes: z.number().int().min(1_024).max(100_000_000).default(10_000_000),
    eventPayloadBytes: z.number().int().min(256).max(65_536).default(16_384),
    providerUsage: z.number().nonnegative().optional(),
    maxRetries: z.number().int().min(0).max(5).default(2),
  })
  .default({
    wallTimeSeconds: 3_600,
    idleTimeSeconds: 120,
    cpuSeconds: 3_600,
    memoryMb: 4_096,
    artifactBytes: 50_000_000,
    eventCount: 10_000,
    eventBytes: 10_000_000,
    eventPayloadBytes: 16_384,
    maxRetries: 2,
  });
export type RunBudgets = z.infer<typeof runBudgetsSchema>;

export const consumedBudgetSchema = z.object({
  cpuSeconds: z.number().nonnegative().default(0),
  memoryPeakMb: z.number().nonnegative().default(0),
  artifactBytes: z.number().int().nonnegative().default(0),
  providerUsage: z.number().nonnegative().optional(),
});
export type ConsumedBudget = z.infer<typeof consumedBudgetSchema>;

export const createAgentSchema = z.object({
  repositoryUrl: repositoryUrlSchema,
  revision: revisionSchema,
  environmentTarget: z.string().min(1).max(200).default("local"),
  runnerPool: z.string().min(1).max(200).default("runner-pool/local"),
  prompt: z.string().min(1).max(20_000),
  origin: z
    .object({
      type: z.literal("api").default("api"),
      externalId: z.string().min(1).max(500).optional(),
    })
    .default({ type: "api" }),
  budgets: runBudgetsSchema,
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createFollowUpSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  budgets: runBudgetsSchema,
});

export const heartbeatSchema = z.object({
  consumed: consumedBudgetSchema.default({ cpuSeconds: 0, memoryPeakMb: 0, artifactBytes: 0 }),
});

const eventMessageSchema = z.object({ message: z.string().min(1).max(4_000) }).strict();
export const ingestRunEventSchema = z.discriminatedUnion("kind", [
  z.object({
    runnerEventId: z.uuid(),
    runnerSequence: z.number().int().positive(),
    kind: z.literal("run.started"),
    payload: z.object({ message: z.string().min(1).max(1_000).optional() }).strict(),
  }),
  z.object({
    runnerEventId: z.uuid(),
    runnerSequence: z.number().int().positive(),
    kind: z.literal("run.progress"),
    payload: eventMessageSchema,
  }),
  z.object({
    runnerEventId: z.uuid(),
    runnerSequence: z.number().int().positive(),
    kind: z.literal("run.waiting"),
    payload: eventMessageSchema,
  }),
  z.object({
    runnerEventId: z.uuid(),
    runnerSequence: z.number().int().positive(),
    kind: z.literal("run.warning"),
    payload: eventMessageSchema,
  }),
  z.object({
    runnerEventId: z.uuid(),
    runnerSequence: z.number().int().positive(),
    kind: z.literal("run.result"),
    payload: z
      .object({
        outcome: z.enum(["succeeded", "failed", "canceled"]),
        summary: z.string().min(1).max(10_000),
        terminalReason: z.string().min(1).max(500).optional(),
      })
      .strict(),
  }),
]);
export type IngestRunEvent = z.infer<typeof ingestRunEventSchema>;

export type Principal = {
  id: string;
  type: "user" | "service";
  displayName: string;
};

export type Agent = {
  id: string;
  creator: Principal;
  requester: Principal;
  origin: { type: string; externalId?: string };
  repositoryUrl: string;
  revision: string;
  environmentTarget: string;
  runnerPool: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type Run = {
  id: string;
  agentId: string;
  taskId: string;
  number: number;
  kind: "initial" | "follow_up";
  prompt: string;
  status: RunStatus;
  budgets: RunBudgets;
  consumed: ConsumedBudget & { eventCount: number; eventBytes: number };
  retryCount: number;
  cancelRequestedAt: string | null;
  lastHeartbeatAt: string | null;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  checkoutProvenance: CheckoutProvenance | null;
};

export type RunEvent = {
  cursor: string;
  runId: string;
  sequence: number;
  runnerEventId: string;
  runnerSequence: number;
  timestamp: string;
  kind: IngestRunEvent["kind"];
  payload: Record<string, unknown>;
};

export { checkoutProvenanceSchema };
