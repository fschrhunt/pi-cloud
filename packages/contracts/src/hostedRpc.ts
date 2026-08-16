import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const requestIdBaseSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("pi-cloud-internal-"), "request ID uses a reserved Pi Cloud prefix");
const requestIdSchema = requestIdBaseSchema.optional();
const requiredRequestIdSchema = requestIdBaseSchema;
const imageSchema = z
  .object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string().min(1),
  })
  .catchall(jsonValueSchema);
const messageCommandFields = {
  id: requestIdSchema,
  message: z.string(),
  images: z.array(imageSchema).optional(),
};

/** Native Pi records stay open to protocol additions but must be JSON objects with a type. */
export const piRpcRecordSchema = z
  .object({ type: z.string().min(1) })
  .catchall(jsonValueSchema);

/** Client commands whose safety-relevant native fields are validated without dropping extensions. */
export const piRpcClientCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("prompt"),
      ...messageCommandFields,
      streamingBehavior: z.enum(["steer", "followUp"]).optional(),
    })
    .catchall(jsonValueSchema),
  z.object({ type: z.literal("steer"), ...messageCommandFields }).catchall(jsonValueSchema),
  z.object({ type: z.literal("follow_up"), ...messageCommandFields }).catchall(jsonValueSchema),
  z.object({ type: z.literal("abort"), id: requestIdSchema }).catchall(jsonValueSchema),
  z.object({ type: z.literal("get_state"), id: requestIdSchema }).catchall(jsonValueSchema),
  z
    .object({ type: z.literal("get_entries"), id: requestIdSchema, since: z.string().min(1).optional() })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("extension_ui_response"),
      id: requiredRequestIdSchema,
      value: z.string().optional(),
      confirmed: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    })
    .catchall(jsonValueSchema)
    .superRefine((record, context) => {
      const resultFields = [record.value !== undefined, record.confirmed !== undefined, record.cancelled === true];
      if (resultFields.filter(Boolean).length !== 1) {
        context.addIssue({
          code: "custom",
          message: "extension_ui_response must contain exactly one value, confirmed, or cancelled result",
        });
      }
    }),
]);

const envelopeFields = {
  version: z.literal(1),
  hostedSessionId: z.uuid(),
  sequence: z.number().int().positive(),
};

/** Versioned transport envelope for one complete native Pi JSON record. */
export const hostedRpcEnvelopeSchema = z
  .object({
    ...envelopeFields,
    direction: z.enum(["client_to_pi", "pi_to_client"]),
    record: piRpcRecordSchema,
  })
  .strict();

/** Inbound envelope variant that applies the stricter supported client-command schemas. */
export const hostedRpcClientEnvelopeSchema = z
  .object({
    ...envelopeFields,
    direction: z.literal("client_to_pi"),
    record: piRpcClientCommandSchema,
  })
  .strict();

export const hostedRpcEnvelopeBoundsSchema = z
  .object({
    maxRecordBytes: z.number().int().positive(),
    maxCumulativeBytes: z.number().int().positive(),
    cumulativeBytes: z.number().int().nonnegative().default(0),
  })
  .strict();

export type PiRpcRecord = z.infer<typeof piRpcRecordSchema>;
export type PiRpcClientCommand = z.infer<typeof piRpcClientCommandSchema>;
export type HostedRpcEnvelope = z.infer<typeof hostedRpcEnvelopeSchema>;
export type HostedRpcClientEnvelope = z.infer<typeof hostedRpcClientEnvelopeSchema>;
export type HostedRpcEnvelopeBounds = z.input<typeof hostedRpcEnvelopeBoundsSchema>;

/**
 * Validates an envelope and accounts for its original UTF-8 wire size against caller-owned bounds.
 * The byte count is required because parsing loses insignificant whitespace and duplicate-key data.
 */
export function parseBoundedHostedRpcEnvelope(
  value: unknown,
  bounds: HostedRpcEnvelopeBounds,
  wireBytes: number,
): { envelope: HostedRpcEnvelope; cumulativeBytes: number } {
  const parsedBounds = hostedRpcEnvelopeBoundsSchema.parse(bounds);
  const envelope = hostedRpcEnvelopeSchema.parse(value);
  const bytes = boundedEnvelopeBytes(wireBytes);
  if (bytes > parsedBounds.maxRecordBytes) throw new Error("RPC envelope exceeds maxRecordBytes");
  const cumulativeBytes = parsedBounds.cumulativeBytes + bytes;
  if (cumulativeBytes > parsedBounds.maxCumulativeBytes) throw new Error("RPC envelopes exceed maxCumulativeBytes");
  return { envelope, cumulativeBytes };
}

/** Applies client-command validation and the same explicit transport bounds. */
export function parseBoundedHostedRpcClientEnvelope(
  value: unknown,
  bounds: HostedRpcEnvelopeBounds,
  wireBytes: number,
): { envelope: HostedRpcClientEnvelope; cumulativeBytes: number } {
  const parsedBounds = hostedRpcEnvelopeBoundsSchema.parse(bounds);
  const envelope = hostedRpcClientEnvelopeSchema.parse(value);
  const bytes = boundedEnvelopeBytes(wireBytes);
  if (bytes > parsedBounds.maxRecordBytes) throw new Error("RPC envelope exceeds maxRecordBytes");
  const cumulativeBytes = parsedBounds.cumulativeBytes + bytes;
  if (cumulativeBytes > parsedBounds.maxCumulativeBytes) throw new Error("RPC envelopes exceed maxCumulativeBytes");
  return { envelope, cumulativeBytes };
}

function boundedEnvelopeBytes(wireBytes: number): number {
  if (!Number.isSafeInteger(wireBytes) || wireBytes <= 0) {
    throw new Error("wireBytes must be a positive safe integer");
  }
  return wireBytes;
}
