import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalHttpsOrigin,
  discoverCloudRepository,
  type GitExecutor,
} from "./repository.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function executor(outputs: Readonly<Record<string, string>>): GitExecutor {
  return async (args) => {
    const key = args.join(" ");
    const stdout = outputs[key];
    return stdout === undefined
      ? { code: 1, stdout: "", stderr: "missing fixture" }
      : { code: 0, stdout, stderr: "" };
  };
}

test("repository discovery canonicalizes a GitHub SSH origin and requires a clean tree", async () => {
  const repository = await discoverCloudRepository("/repo/subdir", executor({
    "rev-parse --show-toplevel": "/repo\n",
    "remote get-url origin": "git@github.com:owner/project.git\n",
    "rev-parse HEAD": `${revision}\n`,
    "status --porcelain=v1": "",
  }));

  assert.deepEqual(repository, {
    root: "/repo",
    repositoryUrl: "https://github.com/owner/project.git",
    revision,
  });
});

test("repository discovery refuses dirty local state", async () => {
  await assert.rejects(
    discoverCloudRepository("/repo", executor({
      "rev-parse --show-toplevel": "/repo",
      "remote get-url origin": "https://github.com/owner/project.git",
      "rev-parse HEAD": revision,
      "status --porcelain=v1": " M src/index.ts",
    })),
    /clean local working tree/,
  );
});

test("origin canonicalization only rewrites supported GitHub SSH forms", () => {
  assert.equal(
    canonicalHttpsOrigin("ssh://git@github.com/owner/project.git"),
    "https://github.com/owner/project.git",
  );
  assert.equal(
    canonicalHttpsOrigin("https://git.example.test/owner/project.git"),
    "https://git.example.test/owner/project.git",
  );
  assert.throws(() => canonicalHttpsOrigin("git@gitlab.com:owner/project.git"), /HTTPS URL or a GitHub SSH URL/);
});
