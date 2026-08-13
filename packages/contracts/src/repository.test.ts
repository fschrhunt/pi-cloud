import assert from "node:assert/strict";
import test from "node:test";
import { immutableRevisionSchema, parseRepositoryUrl, repositoryUrlSchema } from "./repository.js";

const sha1Revision = "0123456789abcdef0123456789abcdef01234567";

test("repository identity requires full immutable SHA-1 commit names", () => {
  assert.equal(immutableRevisionSchema.parse(sha1Revision.toUpperCase()), sha1Revision);
  assert.throws(() => immutableRevisionSchema.parse(sha1Revision.slice(0, -1)), /full immutable Git SHA-1 commit/);
  assert.throws(() => immutableRevisionSchema.parse(`${sha1Revision}0`), /full immutable Git SHA-1 commit/);
  assert.throws(() =>
    immutableRevisionSchema.parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
  );
});

test("repository URLs are plain HTTPS remotes without credentials or query data", () => {
  assert.equal(repositoryUrlSchema.parse("https://github.com/pi-cloud/example.git"), "https://github.com/pi-cloud/example.git");
  assert.equal(repositoryUrlSchema.parse("https://GitHub.com:443/pi-cloud/example"), "https://github.com/pi-cloud/example");
  assert.equal(parseRepositoryUrl("https://github.com/pi-cloud/example").hostname, "github.com");
  assert.throws(() => repositoryUrlSchema.parse("http://github.com/pi-cloud/example"), /HTTPS/);
  assert.throws(() => parseRepositoryUrl("https://token@github.com/pi-cloud/example"), /credentials/);
  assert.throws(() => parseRepositoryUrl("https://github.com/pi-cloud/example?token=secret"), /query or fragment/);
});
