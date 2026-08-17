import type { JsonValue, PiRpcRecord } from "@pi-cloud/contracts";

export const redactionMarker = "[REDACTED]";

/** Recursively redacts exact configured secret substrings from complete parsed JSON records. */
export function redactRecord(record: PiRpcRecord, configuredSecrets: readonly string[]): PiRpcRecord {
  const secrets = normalizeSecrets(configuredSecrets);
  return redactValue(record, secrets) as PiRpcRecord;
}

/** Buffers stderr across chunks so split secrets are redacted before a bounded diagnostic is exposed. */
export class BoundedStderrDiagnostic {
  private readonly chunks: Buffer[] = [];
  private readonly secrets: string[];
  private storedBytes = 0;
  private finished = false;
  private truncated = false;

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
    if (allowance <= 0) {
      this.truncated = true;
      return;
    }
    const kept = Buffer.from(chunk).subarray(0, allowance);
    if (kept.byteLength < chunk.byteLength) this.truncated = true;
    this.storedBytes += kept.byteLength;
    this.chunks.push(kept);
  }

  finish(): string {
    this.finished = true;
    const retained = Buffer.concat(this.chunks, this.storedBytes);
    const boundarySafe = this.truncated ? redactSecretPrefixBytesAtEnd(retained, this.secrets) : retained;
    return truncateUtf8(redactString(boundarySafe.toString("utf8"), this.secrets), this.maxBytes);
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

/** Redacts a UTF-8 secret prefix cut at any byte of the diagnostic's retained-head boundary. */
function redactSecretPrefixBytesAtEnd(value: Buffer, secrets: readonly string[]): Buffer {
  let matchedBytes = 0;
  for (const secret of secrets) {
    const encoded = Buffer.from(secret);
    for (let length = Math.min(encoded.byteLength - 1, value.byteLength); length > matchedBytes; length -= 1) {
      if (value.subarray(value.byteLength - length).equals(encoded.subarray(0, length))) {
        matchedBytes = length;
        break;
      }
    }
  }
  return matchedBytes === 0
    ? value
    : Buffer.concat([value.subarray(0, value.byteLength - matchedBytes), Buffer.from(redactionMarker)]);
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
