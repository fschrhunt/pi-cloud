import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { ApiConfig } from "./config.js";
import { ControlPlane } from "./controlPlane.js";
import type { Principal } from "./domain.js";

const { privateKey } = generateKeyPairSync("ed25519");
const config: ApiConfig = {
  dispatcherToken: "development-dispatcher-token-32-characters",
  taskLeasePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  taskLeaseIssuer: "pi-cloud-test",
  databasePath: ":memory:",
  apiCredentials: [
    {
      token: "test-user-token-that-is-at-least-32-characters",
      subjectId: "user-1",
      type: "user",
      displayName: "Test User",
    },
  ],
};
const principal: Principal = { id: "user-1", type: "user", displayName: "Test User" };
const revision = "0123456789abcdef0123456789abcdef01234567";

test("finite follow-up runs serialize mutations and permanent deletion fails closed", () => {
  const controlPlane = new ControlPlane(config);
  const initial = controlPlane.createAgent(
    principal,
    {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision,
      prompt: "Inspect the repository.",
    },
    "agent-create-0001",
  );
  controlPlane.cancelRun(principal, initial.run.id);
  const followUp = controlPlane.createFollowUp(
    principal,
    initial.agent.id,
    { prompt: "Now inspect the tests." },
    "follow-up-create-0001",
  );
  const retry = controlPlane.createFollowUp(
    principal,
    initial.agent.id,
    { prompt: "This body is ignored for the same idempotency key." },
    "follow-up-create-0001",
  );

  assert.equal(followUp.number, 2);
  assert.equal(retry.id, followUp.id);
  assert.throws(() => controlPlane.deleteAgent(principal, initial.agent.id), /Active agents/);

  controlPlane.cancelRun(principal, followUp.id);
  assert.equal(controlPlane.archiveAgent(principal, initial.agent.id, true).status, "archived");
  assert.equal(controlPlane.archiveAgent(principal, initial.agent.id, false).status, "active");
  controlPlane.deleteAgent(principal, initial.agent.id);
  assert.throws(() => controlPlane.getAgent(principal, initial.agent.id), /not found/);
  controlPlane.close();
});
