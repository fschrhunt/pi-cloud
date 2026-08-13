import { randomUUID, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { immutableRevisionSchema, repositoryUrlSchema } from "./repository.js";

const encodedPartSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const maximumLeaseLifetimeSeconds = 300;

export const taskLeaseClaimsSchema = z.object({
  version: z.literal(1),
  leaseId: z.uuid(),
  taskId: z.uuid(),
  repositoryUrl: repositoryUrlSchema,
  revision: immutableRevisionSchema,
  issuer: z.string().min(1),
  audience: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

export type TaskLeaseClaims = z.infer<typeof taskLeaseClaimsSchema>;

export type IssueTaskLeaseInput = Pick<
  TaskLeaseClaims,
  "taskId" | "repositoryUrl" | "revision" | "issuer" | "audience"
> & {
  privateKey: KeyObject;
  ttlSeconds: number;
  now?: Date;
  leaseId?: string;
};

export type VerifyTaskLeaseInput = {
  publicKey: KeyObject;
  issuer: string;
  audience: string;
  now?: Date;
};

/** Issues a compact, versioned Ed25519 token granting one runner authority over one task. */
export function issueTaskLease(input: IssueTaskLeaseInput): string {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims = taskLeaseClaimsSchema.parse({
    version: 1,
    leaseId: input.leaseId ?? randomUUID(),
    taskId: input.taskId,
    repositoryUrl: input.repositoryUrl,
    revision: input.revision,
    issuer: input.issuer,
    audience: input.audience,
    issuedAt,
    expiresAt:
      issuedAt + z.number().int().min(1).max(maximumLeaseLifetimeSeconds).parse(input.ttlSeconds),
  });
  const payload = encode(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(payload), toPrivateKey(input.privateKey));

  return `${payload}.${encode(signature)}`;
}

/** Verifies a task lease fail-closed and returns only schema-validated claims. */
export function verifyTaskLease(token: string, input: VerifyTaskLeaseInput): TaskLeaseClaims {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra !== undefined) {
    throw new Error("Task lease is malformed");
  }

  encodedPartSchema.parse(payload);
  encodedPartSchema.parse(encodedSignature);
  const signature = Buffer.from(encodedSignature, "base64url");
  const validSignature = verify(null, Buffer.from(payload), toPublicKey(input.publicKey), signature);
  if (!validSignature) {
    throw new Error("Task lease signature is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Task lease payload is invalid");
  }

  const claims = taskLeaseClaimsSchema.parse(decoded);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);

  if (!constantTimeEqual(claims.issuer, input.issuer)) {
    throw new Error("Task lease issuer is invalid");
  }
  if (!constantTimeEqual(claims.audience, input.audience)) {
    throw new Error("Task lease audience is invalid");
  }
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt <= now) {
    throw new Error("Task lease has expired");
  }
  if (claims.expiresAt - claims.issuedAt > maximumLeaseLifetimeSeconds) {
    throw new Error("Task lease lifetime exceeds the maximum");
  }
  if (claims.issuedAt > now + 30) {
    throw new Error("Task lease was issued in the future");
  }

  return claims;
}

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function toPrivateKey(key: KeyObject): KeyObject {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Task lease signing key must be an Ed25519 private key");
  }
  return key;
}

function toPublicKey(key: KeyObject): KeyObject {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Task lease verification key must be an Ed25519 public key");
  }
  return key;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
