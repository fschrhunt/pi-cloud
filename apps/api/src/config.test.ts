import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { readApiConfig } from "./config.js";

const { privateKey } = generateKeyPairSync("ed25519");
const encodedPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const dispatcherToken = "development-dispatcher-token-32-characters";

test("API config accepts an Ed25519 task lease signing key", () => {
  assert.deepEqual(
    readApiConfig({
      PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
      PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
    }),
    {
      dispatcherToken,
      taskLeasePrivateKey: encodedPrivateKey,
      taskLeaseIssuer: "pi-cloud-control-plane",
    },
  );
});

test("API config rejects missing or non-Ed25519 signing keys", () => {
  assert.throws(() => readApiConfig({}));

  const { privateKey: rsaKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encodedRsaKey = rsaKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.throws(
    () =>
      readApiConfig({
        PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
        PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedRsaKey,
      }),
    /Ed25519/,
  );
  assert.throws(() =>
    readApiConfig({
      PI_CLOUD_DISPATCHER_TOKEN: "short",
      PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
    }),
  );
});
