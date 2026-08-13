import assert from "node:assert/strict";
import test from "node:test";
import { checkoutProvenanceSchema } from "./checkout.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const provenance = {
  repositoryUrl: "https://github.com/pi-cloud/example",
  revision,
  resolvedCommit: revision,
  transport: "https",
  credentialSource: "anonymous",
  credentialScrubbed: true,
  submodulesInitialized: false,
  hooksDisabled: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
} as const;

test("checkout provenance binds the resolved commit and orders its timestamps", () => {
  assert.equal(checkoutProvenanceSchema.parse(provenance).resolvedCommit, revision);
  assert.throws(() =>
    checkoutProvenanceSchema.parse({
      ...provenance,
      resolvedCommit: "ffffffffffffffffffffffffffffffffffffffff",
    }),
  );
  assert.throws(() =>
    checkoutProvenanceSchema.parse({
      ...provenance,
      completedAt: "2025-12-31T23:59:59.000Z",
    }),
  );
});

test("checkout provenance keeps fixture evidence separate from HTTPS evidence", () => {
  assert.throws(() =>
    checkoutProvenanceSchema.parse({ ...provenance, credentialSource: "local-fixture" }),
  );
  assert.throws(() =>
    checkoutProvenanceSchema.parse({
      ...provenance,
      transport: "local-fixture",
      credentialSource: "anonymous",
    }),
  );
});
