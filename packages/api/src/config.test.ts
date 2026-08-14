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

const hostedEnv = {
  PI_CLOUD_PUBLIC_BASE_URL: "https://pi-cloud.example.com",
  PI_CLOUD_RUNTIME_WORKSPACE_ROOT: "/srv/pi-cloud/workspaces",
  PI_CLOUD_RUNTIME_AGENT_DIRECTORY: "/srv/pi-cloud/agent",
};

test("API config accepts durable storage, identities, and Ed25519 lease authority", () => {
  assert.deepEqual(
    readApiConfig({
      PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
      PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
      PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
      ...hostedEnv,
    }),
    {
      dispatcherToken,
      taskLeasePrivateKey: encodedPrivateKey,
      taskLeaseIssuer: "pi-cloud-control-plane",
      databasePath: "./data/pi-cloud.sqlite",
      apiCredentials,
      publicBaseUrl: "https://pi-cloud.example.com",
      runtimeWorkspaceRoot: "/srv/pi-cloud/workspaces",
      runtimeAgentDirectory: "/srv/pi-cloud/agent",
      hostedLaunchLimits: {
        wallTimeSeconds: 3_600,
        idleTimeSeconds: 300,
        terminationGraceSeconds: 5,
        maxRecordBytes: 65_536,
        maxCumulativeBytes: 10_000_000,
      },
      hostedCredentialReferences: [],
      hostedCredentialValues: {},
    },
  );
});

test("API config accepts loopback and Docker-host HTTP URLs for local development", () => {
  const config = readApiConfig({
    PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
    PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
    PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
    ...hostedEnv,
    PI_CLOUD_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  });
  assert.equal(config.publicBaseUrl, "http://127.0.0.1:3000");
  const dockerConfig = readApiConfig({
    PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
    PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
    PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
    ...hostedEnv,
    PI_CLOUD_PUBLIC_BASE_URL: "http://host.docker.internal:3000",
  });
  assert.equal(dockerConfig.publicBaseUrl, "http://host.docker.internal:3000");
});

test("API config requires values for exactly the configured hosted credential references", () => {
  const reference = [{ name: "provider", reference: "vault://provider/key", environmentVariable: "ANTHROPIC_API_KEY" }];
  const base = {
    PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
    PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
    PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
    PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES: JSON.stringify(reference),
    ...hostedEnv,
  };
  assert.throws(() => readApiConfig(base), /has no value/);
  assert.throws(() => readApiConfig({
    ...base,
    PI_CLOUD_HOSTED_CREDENTIALS: JSON.stringify({ "vault://other/key": "wrong" }),
  }));
  assert.deepEqual(
    readApiConfig({
      ...base,
      PI_CLOUD_HOSTED_CREDENTIALS: JSON.stringify({ "vault://provider/key": "scoped-secret" }),
    }).hostedCredentialValues,
    { "vault://provider/key": "scoped-secret" },
  );
});

test("API config rejects a non-local HTTP public base URL", () => {
  assert.throws(
    () =>
      readApiConfig({
        PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
        PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
        PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
        ...hostedEnv,
        PI_CLOUD_PUBLIC_BASE_URL: "http://pi-cloud.example.com",
      }),
    /HTTPS/,
  );
});

test("API config rejects relative runtime workspace and agent roots", () => {
  assert.throws(() =>
    readApiConfig({
      PI_CLOUD_DISPATCHER_TOKEN: dispatcherToken,
      PI_CLOUD_TASK_LEASE_PRIVATE_KEY: encodedPrivateKey,
      PI_CLOUD_API_CREDENTIALS: JSON.stringify(apiCredentials),
      ...hostedEnv,
      PI_CLOUD_RUNTIME_WORKSPACE_ROOT: "relative/workspaces",
    }),
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
        ...hostedEnv,
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
        ...hostedEnv,
      }),
    /Ed25519/,
  );
});
