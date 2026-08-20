import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const installer = new URL("./install.sh", import.meta.url).pathname;

test("macOS installer adds the pinned extension through Pi without replacing the pi executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-install-"));
  const log = join(root, "pi.log");
  try {
    await executable(join(root, "uname"), `#!/bin/sh\nif [ "\${1:-}" = "-s" ]; then echo Darwin; else echo arm64; fi\n`);
    await executable(join(root, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}"\n`);

    const result = await runInstaller({ PATH: root, PI_CLOUD_VERSION: "1.2.3" });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(log, "utf8"), "install npm:@pi-cloud/extension@1.2.3\n");
    assert.match(result.stdout, /Run pi --cloud/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer refuses to configure a server or unsupported client platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-install-platform-"));
  try {
    await executable(join(root, "uname"), "#!/bin/sh\necho Linux\n");
    const result = await runInstaller({ PATH: root });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /supports macOS only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function executable(path, content) {
  await writeFile(path, content, { mode: 0o700 });
  await chmod(path, 0o700);
}

function runInstaller(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [installer], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
