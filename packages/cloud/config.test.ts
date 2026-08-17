import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCloudConfig, writeCloudConfig } from "./config.js";

const config = {
  version: 1 as const,
  serverUrl: "https://pi.example.test",
  token: "t".repeat(32),
};

test("cloud configuration round trips with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-config-"));
  const path = join(root, "nested", "config.json");
  try {
    assert.equal(await readCloudConfig(path), undefined);
    await writeCloudConfig(config, path);

    assert.deepEqual(await readCloudConfig(path), config);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "nested"))).mode & 0o777, 0o700);
    assert.match(await readFile(path, "utf8"), /"version": 1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud configuration refuses files readable by another user", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-config-mode-"));
  const path = join(root, "config.json");
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o644 });
    await chmod(path, 0o644);
    await assert.rejects(readCloudConfig(path), /permissions must be 0600/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
