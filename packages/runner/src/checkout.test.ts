import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkoutExactRevision, createAskPassCredentialHelper } from "./checkout.js";

const execFileAsync = promisify(execFile);
const repositoryUrl = "https://github.com/pi-cloud/example";

/** Creates a local bare Git repository fixture for checkout tests. */
async function createRepositoryFixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-cloud-checkout-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await execFileAsync("git", ["init", source], { shell: false });
  await execFileAsync("git", ["-C", source, "config", "user.name", "Pi Cloud Tests"], { shell: false });
  await execFileAsync("git", ["-C", source, "config", "user.email", "tests@pi-cloud.invalid"], { shell: false });

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(source, relativePath);
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }

  await execFileAsync("git", ["-C", source, "add", "."], { shell: false });
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"], { shell: false });
  const { stdout } = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"], { shell: false });
  await execFileAsync("git", ["clone", "--bare", source, remote], { shell: false });
  return { root, remote, revision: stdout.trim() };
}

test("checkoutExactRevision materializes the exact detached commit from a local fixture", async () => {
  const fixture = await createRepositoryFixture({ "README.md": "fixture\n" });
  const checkoutRoot = await fs.mkdtemp(join(tmpdir(), "pi-cloud-worktree-"));
  try {
    const provenance = await checkoutExactRevision({
      checkoutPath: join(checkoutRoot, "repository"),
      revision: fixture.revision,
      source: { kind: "local-fixture", repositoryUrl, fixturePath: fixture.remote },
      scratchRoot: checkoutRoot,
    });
    const { stdout } = await execFileAsync("git", ["-C", join(checkoutRoot, "repository"), "rev-parse", "--abbrev-ref", "HEAD"], {
      shell: false,
    });

    assert.equal(stdout.trim(), "HEAD");
    assert.equal(provenance.resolvedCommit, fixture.revision);
    assert.equal(provenance.transport, "local-fixture");
    assert.equal(provenance.credentialSource, "local-fixture");
  } finally {
    await fs.rm(checkoutRoot, { recursive: true, force: true });
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("checkoutExactRevision rejects executable submodule update metadata", async () => {
  const fixture = await createRepositoryFixture({
    ".gitmodules": '[submodule "evil"]\n\tpath = deps/evil\n\turl = https://github.com/pi-cloud/evil\n\tupdate = !echo owned\n',
  });
  const checkoutRoot = await fs.mkdtemp(join(tmpdir(), "pi-cloud-worktree-"));
  try {
    await assert.rejects(
      checkoutExactRevision({
        checkoutPath: join(checkoutRoot, "repository"),
        revision: fixture.revision,
        source: { kind: "local-fixture", repositoryUrl, fixturePath: fixture.remote },
        scratchRoot: checkoutRoot,
      }),
      /executable update command/,
    );
  } finally {
    await fs.rm(checkoutRoot, { recursive: true, force: true });
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("checkoutExactRevision allows ordinary dormant submodule metadata without expanding it", async () => {
  const fixture = await createRepositoryFixture({
    ".gitmodules": '[submodule "ordinary"]\n\tpath = deps/ordinary\n\turl = https://github.com/pi-cloud/ordinary\n\tbranch = main\n',
  });
  const checkoutRoot = await fs.mkdtemp(join(tmpdir(), "pi-cloud-worktree-"));
  try {
    const provenance = await checkoutExactRevision({
      checkoutPath: join(checkoutRoot, "repository"),
      revision: fixture.revision,
      source: { kind: "local-fixture", repositoryUrl, fixturePath: fixture.remote },
      scratchRoot: checkoutRoot,
    });
    assert.equal(provenance.submodulesInitialized, false);
  } finally {
    await fs.rm(checkoutRoot, { recursive: true, force: true });
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("checkoutExactRevision refuses the wrong immutable revision", async () => {
  const fixture = await createRepositoryFixture({ "README.md": "fixture\n" });
  const checkoutRoot = await fs.mkdtemp(join(tmpdir(), "pi-cloud-worktree-"));
  try {
    await assert.rejects(
      checkoutExactRevision({
        checkoutPath: join(checkoutRoot, "repository"),
        revision: "ffffffffffffffffffffffffffffffffffffffff",
        source: { kind: "local-fixture", repositoryUrl, fixturePath: fixture.remote },
        scratchRoot: checkoutRoot,
      }),
    );
  } finally {
    await fs.rm(checkoutRoot, { recursive: true, force: true });
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("checkoutExactRevision refuses a non-empty checkout path", async () => {
  const fixture = await createRepositoryFixture({ "README.md": "fixture\n" });
  const checkoutRoot = await fs.mkdtemp(join(tmpdir(), "pi-cloud-worktree-"));
  const checkoutPath = join(checkoutRoot, "repository");
  try {
    await fs.mkdir(checkoutPath);
    await fs.writeFile(join(checkoutPath, "leftover.txt"), "untrusted leftover\n");
    await assert.rejects(
      checkoutExactRevision({
        checkoutPath,
        revision: fixture.revision,
        source: { kind: "local-fixture", repositoryUrl, fixturePath: fixture.remote },
        scratchRoot: checkoutRoot,
      }),
      /must be empty/,
    );
  } finally {
    await fs.rm(checkoutRoot, { recursive: true, force: true });
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("askpass credentials are repository-bound and scrubbed after use", async () => {
  const scratchRoot = await fs.mkdtemp(join(tmpdir(), "pi-cloud-askpass-test-"));
  const helper = await createAskPassCredentialHelper({
    scratchRoot,
    repositoryUrl,
    username: "oauth2",
    password: "secret-token",
  });

  try {
    const username = await execFileAsync(process.execPath, [helper.scriptPath, `Username for '${repositoryUrl}':`], {
      env: { ...process.env, PI_CLOUD_ASKPASS_SECRET: helper.secretPath },
      shell: false,
    });
    const password = await execFileAsync(process.execPath, [helper.scriptPath, "Password for 'https://oauth2@github.com/pi-cloud/example':"], {
      env: { ...process.env, PI_CLOUD_ASKPASS_SECRET: helper.secretPath },
      shell: false,
    });

    assert.equal(username.stdout.trim(), "oauth2");
    assert.equal(password.stdout.trim(), "secret-token");
    await assert.rejects(
      execFileAsync(process.execPath, [helper.scriptPath, "Password for 'https://github.com/pi-cloud/another':"], {
        env: { ...process.env, PI_CLOUD_ASKPASS_SECRET: helper.secretPath },
        shell: false,
      }),
    );
  } finally {
    await helper.scrub();
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }

  await assert.rejects(fs.access(helper.secretPath));
  await assert.rejects(fs.access(helper.scriptPath));
});
