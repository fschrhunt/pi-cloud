import { TextDecoder } from "node:util";
import { piRpcRecordSchema, type PiRpcRecord } from "@pi-cloud/contracts";

export type JsonlLimits = {
  maxPartialBytes: number;
  maxRecordBytes: number;
  maxCumulativeBytes: number;
};

/** Incrementally parses strict LF-delimited UTF-8 Pi records and enforces byte limits before JSON parsing. */
export class StrictJsonlParser {
  private pending = Buffer.alloc(0);
  private cumulativeBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly limits: JsonlLimits,
    private readonly onRecord: (record: PiRpcRecord) => void,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  /** Adds arbitrary subprocess chunks; only byte 0x0a terminates a record. */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);

    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      this.parseLine(line);
    }

    if (this.pending.byteLength > this.limits.maxPartialBytes) {
      throw new Error("Pi RPC partial record exceeds maxPartialBytes");
    }
  }

  /** Rejects EOF in the middle of a record; Pi RPC records must end in LF. */
  finish(): void {
    if (this.pending.byteLength > 0) throw new Error("Pi RPC output ended with an unterminated record");
  }

  get bytesRead(): number {
    return this.cumulativeBytes;
  }

  private parseLine(line: Buffer): void {
    if (line.byteLength > this.limits.maxRecordBytes) throw new Error("Pi RPC record exceeds maxRecordBytes");
    this.cumulativeBytes += line.byteLength;
    if (this.cumulativeBytes > this.limits.maxCumulativeBytes) {
      throw new Error("Pi RPC output exceeds maxCumulativeBytes");
    }

    let decoded: string;
    try {
      decoded = this.decoder.decode(line);
    } catch {
      throw new Error("Pi RPC record is not valid UTF-8");
    }

    let value: unknown;
    try {
      value = JSON.parse(decoded);
    } catch {
      throw new Error("Pi RPC output contains malformed JSON");
    }
    const parsed = piRpcRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error("Pi RPC output is not a JSON object record with a type string");
    this.onRecord(parsed.data);
  }
}
