import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { readApiConfig } from "./config.js";

const { privateKey } = generateKeyPairSync("ed25519");
const encodedPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const dispatcherToken = "development-dispatcher-token-32-characters";
const apiCredentials = [
  {
    token: "development-user-token-at-least-32-characters",
    subjectId: "local-user",
    type: "user",
    displayName: "Local User",
  },
];

test("API config accepts durable storage, identities, and Ed25519 lease authority", () => {
  assert.deepEqual(
    readApiConfig({
      PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
      PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
      PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
    }),
    {
      dispatcherToken,
      taskLeasePrivateKey: encodedPrivateKey,
      taskLeaseIssuer: "pi-cloud-control-plane",
      databasePath: "./data/pi-cloud.sqlite",
      apiCredentials,
    },
  );
});

test("API config rejects missing identities and malformed or non-Ed25519 keys", () => {
  assert.throws(() => readApiConfig({}));
  assert.throws(
    () =>
      readApiConfig({
        PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
        PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
        PI_CLOUD_API_CREDENTIALS: "not-json",
      }),
    /JSON array/,
  );

  const { privateKey: rsaKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      readApiConfig({
        PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
        PI_CLOUD_TASK_LEASE_PRIVATE_KEY: rsaKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
        PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
      }),
    /Ed25519/,
  );
});
