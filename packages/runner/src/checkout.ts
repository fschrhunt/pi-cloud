import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  checkoutProvenanceSchema,
  immutableRevisionSchema,
  parseRepositoryUrl,
  type CheckoutProvenance,
} from "@pi-cloud/contracts";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const gitCommandTimeoutMs = 60_000;
const gitmodulesSizeLimitBytes = 128 * 1024;
const checkoutSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("https-url"),
    repositoryUrl: z.string(),
    credentials: z
      .object({
        repositoryUrl: z.string(),
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("local-fixture"),
    repositoryUrl: z.string(),
    fixturePath: z.string().min(1),
  }),
]);
const checkoutInputSchema = z.object({
  checkoutPath: z.string().min(1),
  revision: immutableRevisionSchema,
  source: checkoutSourceSchema,
  gitBinary: z.string().min(1).default("git"),
  scratchRoot: z.string().min(1).default(tmpdir()),
});

export type CheckoutExactRevisionInput = z.input<typeof checkoutInputSchema>;
export type CheckoutExecutionOptions = { processIdentity?: { uid: number; gid: number }; signal?: AbortSignal };
export type CheckoutSource = z.infer<typeof checkoutSourceSchema>;

/** Checks out one exact revision into a clean workspace without hooks, helpers, or submodules. */
export async function checkoutExactRevision(
  input: CheckoutExactRevisionInput,
  options: CheckoutExecutionOptions = {},
): Promise<CheckoutProvenance> {
  const parsed = checkoutInputSchema.parse(input);
  const revision = parsed.revision.toLowerCase();
  const checkoutPath = resolve(parsed.checkoutPath);
  const scratchRoot = resolve(parsed.scratchRoot);
  const source = normalizeSource(parsed.source);
  const startedAt = new Date().toISOString();
  const gitEnvironment = await createIsolatedGitEnvironment({
    scratchRoot,
    repositoryUrl: source.repositoryUrl,
    credentials: source.kind === "https-url" ? source.credentials : undefined,
    allowFileProtocol: source.kind === "local-fixture",
    processIdentity: options.processIdentity,
    signal: options.signal,
  });

  let checkoutPrepared = false;
  try {
    await createCleanCheckoutDirectory(checkoutPath);
    checkoutPrepared = true;
    if (options.processIdentity) await applyProcessIdentity(checkoutPath, options.processIdentity);
    await runGit(parsed.gitBinary, ["init", checkoutPath], gitEnvironment);
    await runGit(parsed.gitBinary, ["-C", checkoutPath, "remote", "add", "origin", source.fetchTarget], gitEnvironment);
    await runGit(
      parsed.gitBinary,
      ["-C", checkoutPath, "fetch", "--no-tags", "--depth=1", "--recurse-submodules=no", "origin", revision],
      gitEnvironment,
    );
    await runGit(parsed.gitBinary, ["-C", checkoutPath, "checkout", "--detach", "--force", "FETCH_HEAD"], gitEnvironment);

    const resolvedCommit = await gitOutput(parsed.gitBinary, ["-C", checkoutPath, "rev-parse", "HEAD"], gitEnvironment);
    if (resolvedCommit !== revision) {
      throw new Error(`Checked out ${resolvedCommit} instead of requested revision ${revision}`);
    }

    const headName = await gitOutput(parsed.gitBinary, ["-C", checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"], gitEnvironment);
    if (headName !== "HEAD") {
      throw new Error("Checkout did not leave the repository in detached HEAD state");
    }

    await rejectUnsafeGitmodules(checkoutPath);
    const completedAt = new Date().toISOString();
    return checkoutProvenanceSchema.parse({
      repositoryUrl: source.repositoryUrl,
      revision,
      resolvedCommit,
      transport: source.kind === "https-url" ? "https" : "local-fixture",
      credentialSource:
        source.kind === "local-fixture"
          ? "local-fixture"
          : source.credentials
            ? "short-lived-repository-token"
            : "anonymous",
      credentialScrubbed: true,
      submodulesInitialized: false,
      hooksDisabled: true,
      startedAt,
      completedAt,
    });
  } catch (error: unknown) {
    if (checkoutPrepared) await fs.rm(checkoutPath, { recursive: true, force: true });
    throw error;
  } finally {
    await gitEnvironment.scrub();
  }
}

/** Creates a short-lived askpass helper that answers only for one expected repository URL. */
export async function createAskPassCredentialHelper(input: {
  scratchRoot: string;
  repositoryUrl: string;
  username: string;
  password: string;
}): Promise<{ scriptPath: string; secretPath: string; scrub: () => Promise<void> }> {
  const repositoryUrl = parseRepositoryUrl(input.repositoryUrl).toString();
  const scratchRoot = resolve(input.scratchRoot);
  await fs.mkdir(scratchRoot, { recursive: true });
  const helperDirectory = await fs.mkdtemp(join(scratchRoot, "pi-cloud-askpass-"));
  const secretPath = join(helperDirectory, "credential.json");
  const scriptPath = join(helperDirectory, "askpass.mjs");
  await fs.writeFile(secretPath, JSON.stringify({ repositoryUrl, username: input.username, password: input.password }), {
    mode: 0o600,
  });
  await fs.writeFile(scriptPath, askPassProgram, { mode: 0o700 });

  let scrubbed = false;
  return {
    scriptPath,
    secretPath,
    scrub: async () => {
      if (scrubbed) return;
      scrubbed = true;
      await fs.rm(helperDirectory, { recursive: true, force: true });
    },
  };
}

type NormalizedCheckoutSource =
  | {
      kind: "https-url";
      repositoryUrl: string;
      fetchTarget: string;
      credentials?: { repositoryUrl: string; username: string; password: string };
    }
  | {
      kind: "local-fixture";
      repositoryUrl: string;
      fetchTarget: string;
    };

type GitEnvironment = {
  env: NodeJS.ProcessEnv;
  allowFileProtocol: boolean;
  processIdentity?: { uid: number; gid: number };
  signal?: AbortSignal;
  scrub: () => Promise<void>;
};

async function createIsolatedGitEnvironment(input: {
  scratchRoot: string;
  repositoryUrl: string;
  credentials?: { repositoryUrl: string; username: string; password: string };
  allowFileProtocol: boolean;
  processIdentity?: { uid: number; gid: number };
  signal?: AbortSignal;
}): Promise<GitEnvironment> {
  await fs.mkdir(input.scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(join(input.scratchRoot, "pi-cloud-git-"));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const hooks = join(root, "hooks-disabled");
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(xdg, { recursive: true }), fs.mkdir(hooks, { recursive: true })]);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    PI_CLOUD_GIT_HOOKS_PATH: hooks,
  };

  let askPass: Awaited<ReturnType<typeof createAskPassCredentialHelper>> | undefined;
  if (input.credentials) {
    if (parseRepositoryUrl(input.credentials.repositoryUrl).toString() !== parseRepositoryUrl(input.repositoryUrl).toString()) {
      throw new Error("Checkout credentials must be bound to the exact repository URL");
    }
    askPass = await createAskPassCredentialHelper({
      scratchRoot: root,
      repositoryUrl: input.repositoryUrl,
      username: input.credentials.username,
      password: input.credentials.password,
    });
    env.GIT_ASKPASS = askPass.scriptPath;
    env.PI_CLOUD_ASKPASS_SECRET = askPass.secretPath;
  }
  if (input.processIdentity) await applyProcessIdentity(root, input.processIdentity);

  return {
    env,
    allowFileProtocol: input.allowFileProtocol,
    processIdentity: input.processIdentity,
    signal: input.signal,
    scrub: async () => {
      await askPass?.scrub();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function normalizeSource(source: CheckoutSource): NormalizedCheckoutSource {
  if (source.kind === "https-url") {
    const repositoryUrl = parseRepositoryUrl(source.repositoryUrl).toString();
    const credentials = source.credentials
      ? {
          ...source.credentials,
          repositoryUrl: parseRepositoryUrl(source.credentials.repositoryUrl).toString(),
        }
      : undefined;
    return { kind: "https-url", repositoryUrl, fetchTarget: repositoryUrl, credentials };
  }

  const repositoryUrl = parseRepositoryUrl(source.repositoryUrl).toString();
  if (!isAbsolute(source.fixturePath)) {
    throw new Error("Local checkout fixtures must use an absolute path");
  }
  return { kind: "local-fixture", repositoryUrl, fetchTarget: resolve(source.fixturePath) };
}

async function runGit(gitBinary: string, args: string[], environment: GitEnvironment): Promise<void> {
  await execFileAsync(gitBinary, gitArgs(args, environment), {
    env: environment.env,
    shell: false,
    timeout: gitCommandTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    signal: environment.signal,
    ...(environment.processIdentity ?? {}),
  });
}

async function gitOutput(gitBinary: string, args: string[], environment: GitEnvironment): Promise<string> {
  const { stdout } = await execFileAsync(gitBinary, gitArgs(args, environment), {
    env: environment.env,
    shell: false,
    timeout: gitCommandTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    signal: environment.signal,
    ...(environment.processIdentity ?? {}),
  });
  return stdout.trim();
}

function gitArgs(args: string[], environment: GitEnvironment): string[] {
  const fileProtocol = environment.allowFileProtocol ? "always" : "never";
  const base = [
    "-c",
    `core.hooksPath=${environment.env.PI_CLOUD_GIT_HOOKS_PATH}`,
    "-c",
    "credential.helper=",
    "-c",
    "credential.interactive=never",
    "-c",
    "credential.useHttpPath=true",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    `protocol.file.allow=${fileProtocol}`,
    "-c",
    "http.followRedirects=false",
  ];
  return base.concat(args);
}

async function applyProcessIdentity(path: string, identity: { uid: number; gid: number }): Promise<void> {
  const stats = await fs.lstat(path);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const entry of await fs.readdir(path)) await applyProcessIdentity(join(path, entry), identity);
  }
  await fs.lchown(path, identity.uid, identity.gid);
}

async function createCleanCheckoutDirectory(checkoutPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(checkoutPath);
    if (entries.length > 0) throw new Error("Checkout path must be empty");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(checkoutPath, { recursive: true });
  }
}

async function rejectUnsafeGitmodules(checkoutPath: string): Promise<void> {
  const gitmodulesPath = join(checkoutPath, ".gitmodules");
  try {
    const stats = await fs.lstat(gitmodulesPath);
    if (!stats.isFile()) throw new Error(".gitmodules must be a regular file");
    if (stats.size > gitmodulesSizeLimitBytes) throw new Error(".gitmodules exceeds the supported size limit");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  // Submodules are never initialized in this slice. Reject Git's executable update form while
  // allowing ordinary metadata so repositories that declare dormant submodules still check out.
  const content = await fs.readFile(gitmodulesPath, "utf8");
  if (/^\s*update\s*=\s*!/imu.test(content)) {
    throw new Error(".gitmodules contains an executable update command");
  }
}

const askPassProgram = `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const secretPath = process.env.PI_CLOUD_ASKPASS_SECRET;
const prompt = process.argv[2] ?? "";
if (!secretPath) process.exit(1);

const secret = JSON.parse(readFileSync(secretPath, "utf8"));
const match = /^(Username|Password) for '([^']+)':$/u.exec(prompt.trim());
if (!match) process.exit(1);

const expected = new URL(secret.repositoryUrl);
const prompted = new URL(match[2]);
const expectedPath = expected.pathname.endsWith("/") ? expected.pathname.slice(0, -1) : expected.pathname;
const promptedPath = prompted.pathname.endsWith("/") ? prompted.pathname.slice(0, -1) : prompted.pathname;
if (
  expected.protocol !== prompted.protocol ||
  expected.hostname !== prompted.hostname ||
  expected.port !== prompted.port ||
  expectedPath !== promptedPath ||
  (prompted.username !== "" && prompted.username !== secret.username)
) {
  process.exit(1);
}

process.stdout.write(match[1] === "Username" ? secret.username + "\\n" : secret.password + "\\n");
`;
