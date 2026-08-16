import { StringDecoder } from "node:string_decoder";
import type { JsonValue, PiRpcRecord } from "@pi-cloud/contracts";

export const redactionMarker = "[REDACTED]";

/** Recursively redacts exact configured secret substrings from complete parsed JSON records. */
export function redactRecord(record: PiRpcRecord, configuredSecrets: readonly string[]): PiRpcRecord {
  const secrets = normalizeSecrets(configuredSecrets);
  return redactValue(record, secrets) as PiRpcRecord;
}

/** Buffers stderr across chunks so split secrets are redacted before a bounded diagnostic is exposed. */
export class BoundedStderrDiagnostic {
  private readonly decoder = new StringDecoder("utf8");
  private readonly chunks: string[] = [];
  private readonly secrets: string[];
  private storedBytes = 0;
  private finished = false;

  constructor(
    configuredSecrets: readonly string[],
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("stderr maxBytes must be a positive integer");
    this.secrets = normalizeSecrets(configuredSecrets);
  }

  push(chunk: Uint8Array): void {
    if (this.finished || chunk.byteLength === 0) return;
    const allowance = this.maxBytes + this.longestSecretBytes - this.storedBytes;
    if (allowance <= 0) return;
    const kept = Buffer.from(chunk).subarray(0, allowance);
    this.storedBytes += kept.byteLength;
    this.chunks.push(this.decoder.write(kept));
  }

  finish(): string {
    if (!this.finished) {
      this.chunks.push(this.decoder.end());
      this.finished = true;
    }
    return truncateUtf8(redactString(this.chunks.join(""), this.secrets), this.maxBytes);
  }

  private get longestSecretBytes(): number {
    return this.secrets.reduce((largest, secret) => Math.max(largest, Buffer.byteLength(secret)), 0);
  }
}

function redactValue(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [redactString(key, secrets), redactValue(child, secrets)]),
    );
  }
  return value;
}

function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length > 0))].sort((left, right) => right.length - left.length);
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join(redactionMarker);
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxBytes) return value;
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
    } catch {
      // At most three trailing bytes need removal to end on a UTF-8 code-point boundary.
    }
  }
  return "";
}
