import assert from "node:assert/strict";
import test from "node:test";
import { clearSupplementaryGroups, workspaceProcessIdentity } from "./workspaceIdentity.js";

test("workspace isolation clears inherited supplementary groups before child launches", () => {
  let groups: readonly (string | number)[] | undefined;
  clearSupplementaryGroups((value) => { groups = value; });
  assert.deepEqual(groups, []);
});

test("workspace process identities are stable and separated", () => {
  const first = workspaceProcessIdentity("66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9");
  const same = workspaceProcessIdentity("66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9");
  const other = workspaceProcessIdentity("a0d701e3-bae6-427a-bc22-35d885915da3");
  assert.deepEqual(first, same);
  assert.notEqual(first.uid, other.uid);
  assert.ok(first.uid >= 100_000);
  assert.equal(first.uid, first.gid);
});
