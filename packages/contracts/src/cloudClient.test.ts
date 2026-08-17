import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudClientConfigSchema,
  cloudServerCapabilitiesSchema,
  cloudServerUrlSchema,
} from "./cloudClient.js";

test("cloud client configuration accepts HTTPS and bounded localhost development URLs", () => {
  assert.equal(cloudServerUrlSchema.parse("https://pi.example.test/base/"), "https://pi.example.test/base");
  assert.equal(cloudServerUrlSchema.parse("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.throws(() => cloudServerUrlSchema.parse("http://pi.example.test"), /HTTPS/);
  assert.throws(() => cloudServerUrlSchema.parse("https://user:secret@pi.example.test"), /credentials/);

  assert.deepEqual(
    cloudClientConfigSchema.parse({
      version: 1,
      serverUrl: "https://pi.example.test/",
      token: "t".repeat(32),
    }),
    {
      version: 1,
      serverUrl: "https://pi.example.test",
      token: "t".repeat(32),
    },
  );
});

test("server capabilities reject incompatible protocol versions and unknown fields", () => {
  const capabilities = {
    service: "pi-cloud-api",
    protocolVersion: 1,
    hostedRpcVersion: 1,
    features: {
      hostedSessions: true,
      reconnect: true,
      nativeSessionResume: true,
    },
  };

  assert.deepEqual(cloudServerCapabilitiesSchema.parse(capabilities), capabilities);
  assert.equal(
    cloudServerCapabilitiesSchema.safeParse({ ...capabilities, protocolVersion: 2 }).success,
    false,
  );
  assert.equal(cloudServerCapabilitiesSchema.safeParse({ ...capabilities, extra: true }).success, false);
});
