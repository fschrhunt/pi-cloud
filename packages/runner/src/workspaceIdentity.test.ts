import assert from "node:assert/strict";
import test from "node:test";
import { workspaceProcessIdentity } from "./workspaceIdentity.js";

test("workspace process identities are stable and separated", () => {
  const first = workspaceProcessIdentity("66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9");
  const same = workspaceProcessIdentity("66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9");
  const other = workspaceProcessIdentity("a0d701e3-bae6-427a-bc22-35d885915da3");
  assert.deepEqual(first, same);
  assert.notEqual(first.uid, other.uid);
  assert.ok(first.uid >= 100_000);
  assert.equal(first.uid, first.gid);
});
