import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { issueTaskLease, verifyTaskLease } from "./taskLease.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = new Date("2026-08-12T09:00:00Z");
const leaseInput = {
  privateKey,
  taskId: "a0d701e3-bae6-427a-bc22-35d885915da3",
  repositoryUrl: "https://github.com/pi-cloud/example",
  revision: "0123456789abcdef0123456789abcdef01234567",
  issuer: "pi-cloud-control-plane",
  audience: "runner-pool/local",
  ttlSeconds: 60,
  now,
  leaseId: "43ed6e17-88eb-4a46-8c78-8392fce54244",
} as const;

const verification = { publicKey, issuer: leaseInput.issuer, audience: leaseInput.audience, now };

test("task lease binds one task and runner audience", () => {
  const claims = verifyTaskLease(issueTaskLease(leaseInput), verification);

  assert.deepEqual(claims, {
    version: 1,
    leaseId: leaseInput.leaseId,
    taskId: leaseInput.taskId,
    repositoryUrl: leaseInput.repositoryUrl,
    revision: leaseInput.revision,
    issuer: leaseInput.issuer,
    audience: leaseInput.audience,
    issuedAt: 1_786_525_200,
    expiresAt: 1_786_525_260,
  });
});

test("task lease rejects tampering", () => {
  const token = issueTaskLease(leaseInput);
  const [payload, signature] = token.split(".");
  const tamperedPayload = `${payload?.slice(0, -1)}${payload?.endsWith("A") ? "B" : "A"}`;

  assert.throws(() => verifyTaskLease(`${tamperedPayload}.${signature}`, verification), /signature/);
});

test("task lease rejects expiry, issuer, and audience mismatches", () => {
  const token = issueTaskLease(leaseInput);

  assert.throws(
    () => verifyTaskLease(token, { ...verification, now: new Date("2026-08-12T09:01:01Z") }),
    /expired/,
  );
  assert.throws(
    () => verifyTaskLease(token, { ...verification, issuer: "another-control-plane" }),
    /issuer/,
  );
  assert.throws(
    () => verifyTaskLease(token, { ...verification, audience: "runner-pool/hosted" }),
    /audience/,
  );
});

test("task lease rejects malformed tokens and future issue times", () => {
  const token = issueTaskLease(leaseInput);

  assert.throws(() => verifyTaskLease("not-a-token", verification), /malformed/);
  assert.throws(() => verifyTaskLease(`!invalid.${token.split(".")[1]}`, verification));
  assert.throws(() =>
    verifyTaskLease(token, { ...verification, now: new Date("2026-08-12T08:59:29Z") }),
  );
});

test("task lease rejects unsupported signed versions", () => {
  const validToken = issueTaskLease(leaseInput);
  const [payload] = validToken.split(".");
  assert.ok(payload);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.version = 2;
  const unsupportedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsupportedSignature = sign(null, Buffer.from(unsupportedPayload), privateKey).toString(
    "base64url",
  );

  assert.throws(() => verifyTaskLease(`${unsupportedPayload}.${unsupportedSignature}`, verification));
});

test("task lease rejects lifetimes over five minutes", () => {
  assert.throws(() => issueTaskLease({ ...leaseInput, ttlSeconds: 301 }));

  const validToken = issueTaskLease(leaseInput);
  const [payload] = validToken.split(".");
  assert.ok(payload);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.expiresAt = claims.issuedAt + 301;
  const extendedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const extendedSignature = sign(null, Buffer.from(extendedPayload), privateKey).toString("base64url");

  assert.throws(
    () => verifyTaskLease(`${extendedPayload}.${extendedSignature}`, verification),
    /lifetime/,
  );
});
