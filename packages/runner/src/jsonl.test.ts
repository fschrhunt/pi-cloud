import assert from "node:assert/strict";
import test from "node:test";
import type { PiRpcRecord } from "@pi-cloud/contracts";
import { StrictJsonlParser } from "./jsonl.js";
import { BoundedStderrDiagnostic, redactRecord } from "./redaction.js";

const limits = { maxPartialBytes: 100, maxRecordBytes: 100, maxCumulativeBytes: 200 };

test("strict parser handles chunked UTF-8, CRLF, and Unicode separators without splitting", () => {
  const records: PiRpcRecord[] = [];
  const parser = new StrictJsonlParser(limits, (record) => records.push(record));
  const wire = Buffer.from('{"type":"event","text":"é\u2028next\u2029end"}\r\n');
  parser.push(wire.subarray(0, 25));
  parser.push(wire.subarray(25, 26));
  parser.push(wire.subarray(26));
  parser.finish();
  assert.deepEqual(records, [{ type: "event", text: "é next end" }]);
});

test("strict parser rejects partial, oversized, malformed, and non-object records", () => {
  assert.throws(() => new StrictJsonlParser({ ...limits, maxPartialBytes: 3 }, () => undefined).push(Buffer.from("abcd")), /partial/);
  assert.throws(() => new StrictJsonlParser({ ...limits, maxRecordBytes: 5 }, () => undefined).push(Buffer.from('{"type":"x"}\n')), /record/);
  assert.throws(() => new StrictJsonlParser(limits, () => undefined).push(Buffer.from("not-json\n")), /malformed/);
  assert.throws(() => new StrictJsonlParser(limits, () => undefined).push(Buffer.from("[]\n")), /JSON object/);
  const partial = new StrictJsonlParser(limits, () => undefined);
  partial.push(Buffer.from('{"type":"x"}'));
  assert.throws(() => partial.finish(), /unterminated/);
});

test("complete stdout records and stderr diagnostics redact secrets split across chunks", () => {
  const records: PiRpcRecord[] = [];
  const secret = "split-secret-token";
  const parser = new StrictJsonlParser(limits, (record) => records.push(redactRecord(record, [secret])));
  const stdout = Buffer.from(`{"type":"event","nested":{"${secret}":"before ${secret} after"}}\n`);
  const split = stdout.indexOf("secret");
  parser.push(stdout.subarray(0, split));
  parser.push(stdout.subarray(split));

  const stderr = new BoundedStderrDiagnostic([secret], 100);
  stderr.push(Buffer.from("failure: split-sec"));
  stderr.push(Buffer.from("ret-token details"));
  assert.deepEqual(records, [{ type: "event", nested: { "[REDACTED]": "before [REDACTED] after" } }]);
  assert.equal(stderr.finish(), "failure: [REDACTED] details");

  const unicode = new BoundedStderrDiagnostic([], 1);
  unicode.push(Buffer.from("é"));
  assert.equal(Buffer.byteLength(unicode.finish()), 0);
});

test("bounded stderr redacts a secret prefix cut after an earlier redaction shrinks the retained head", () => {
  const secret = "abcdefghijklmnopqrstuvwxyz1234";
  const stderr = new BoundedStderrDiagnostic([secret], 20);
  stderr.push(Buffer.from(secret + secret));
  const diagnostic = stderr.finish();
  assert.equal(diagnostic, "[REDACTED][REDACTED]");
  assert.doesNotMatch(diagnostic, /abcdefghij/u);
});

test("strict parser enforces cumulative record bytes", () => {
  const line = Buffer.from('{"type":"x"}\n');
  const parser = new StrictJsonlParser({ maxPartialBytes: 20, maxRecordBytes: 20, maxCumulativeBytes: 20 }, () => undefined);
  parser.push(line);
  assert.throws(() => parser.push(line), /maxCumulativeBytes/);
});
