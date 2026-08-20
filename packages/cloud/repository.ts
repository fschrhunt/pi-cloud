import {
  immutableRevisionSchema,
  repositoryUrlSchema,
} from "@pi-cloud/contracts";

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type GitExecutor = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

export type CloudRepository = {
  root: string;
  repositoryUrl: string;
  revision: string;
};

/** Discovers the clean local Git identity used to create or resume a remote workspace. */
export async function discoverCloudRepository(cwd: string, execute: GitExecutor): Promise<CloudRepository> {
  const root = await gitOutput(execute, cwd, ["rev-parse", "--show-toplevel"], "not a Git repository");
  const origin = await gitOutput(execute, root, ["remote", "get-url", "origin"], "Git remote 'origin' is required");
  const revision = immutableRevisionSchema.parse(
    await gitOutput(execute, root, ["rev-parse", "HEAD"], "Git HEAD cannot be resolved"),
  );
  const status = await gitOutput(execute, root, ["status", "--porcelain=v1"], "Git status cannot be read");
  if (status !== "") {
    throw new Error("pi --cloud requires a clean local working tree; commit and push local changes first");
  }

  return {
    root,
    repositoryUrl: repositoryUrlSchema.parse(canonicalHttpsOrigin(origin)),
    revision,
  };
}

/** Converts the common GitHub SSH origin forms used on Macs into the server's HTTPS identity. */
export function canonicalHttpsOrigin(value: string): string {
  const origin = value.trim();
  const scpMatch = /^git@github\.com:([^/\s]+\/[^/\s]+)$/u.exec(origin);
  if (scpMatch) return `https://github.com/${scpMatch[1]}`;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("Git origin must be an HTTPS URL or a GitHub SSH URL");
  }
  if (url.protocol === "ssh:" && url.hostname === "github.com" && url.username === "git") {
    if (url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new Error("GitHub SSH origin must not contain credentials, a query, or a fragment");
    }
    return `https://github.com${url.pathname}`;
  }
  return origin;
}

async function gitOutput(
  execute: GitExecutor,
  cwd: string,
  args: readonly string[],
  failure: string,
): Promise<string> {
  const result = await execute(args, { cwd });
  if (result.code !== 0) throw new Error(failure);
  return result.stdout.trim();
}
