import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HostedRuntimeLaunch } from "@pi-cloud/contracts";

export type HostedRuntimeAuthorizedRoots = {
  workspaceRoots: readonly string[];
  sessionRoots: readonly string[];
  agentRoots: readonly string[];
};

/** Rejects launch paths outside the runner's independently configured filesystem authority. */
export function authorizeHostedRuntimePaths(
  launch: HostedRuntimeLaunch,
  authorizedRoots: HostedRuntimeAuthorizedRoots,
): void {
  authorizePath("workspaceRoot", launch.workspaceRoot, authorizedRoots.workspaceRoots);
  authorizePath(
    launch.nativeSession.kind === "new" ? "sessionDirectory" : "sessionFile",
    launch.nativeSession.kind === "new" ? launch.nativeSession.sessionDirectory : launch.nativeSession.sessionFile,
    authorizedRoots.sessionRoots,
  );
  authorizePath("piAgentDirectory", launch.piAgentDirectory, authorizedRoots.agentRoots);
}

function authorizePath(name: string, candidate: string, roots: readonly string[]): void {
  if (!isAbsolute(candidate)) throw new Error(`${name} must be absolute`);
  if (roots.length === 0 || !roots.some((root) => contains(root, candidate))) {
    throw new Error(`${name} escapes its authorized roots`);
  }
}

function contains(root: string, candidate: string): boolean {
  if (!isAbsolute(root)) throw new Error("Authorized roots must be absolute");
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function authorizeRealPath(name: string, candidate: string, roots: readonly string[]): Promise<void> {
  const realCandidate = await resolveThroughExistingAncestor(candidate);
  for (const root of roots) {
    const realRoot = await fs.realpath(root);
    if (contains(realRoot, realCandidate)) return;
  }
  throw new Error(`${name} escapes its authorized roots through a symbolic link`);
}

async function authorizeRealDescendant(name: string, candidate: string, root: string): Promise<void> {
  const [realCandidate, realRoot] = await Promise.all([
    resolveThroughExistingAncestor(candidate),
    resolveThroughExistingAncestor(root),
  ]);
  if (!contains(realRoot, realCandidate)) {
    throw new Error(`${name} escapes its session through a symbolic link`);
  }
}

async function resolveThroughExistingAncestor(candidate: string): Promise<string> {
  let existing = resolve(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      const realExisting = await fs.realpath(existing);
      return resolve(realExisting, ...missing.reverse());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(existing.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
      existing = parent;
    }
  }
}

/** Rechecks existing path ancestors through realpath so symlink traversal cannot escape a mount. */
export async function authorizeHostedRuntimeRealPaths(
  launch: HostedRuntimeLaunch,
  authorizedRoots: HostedRuntimeAuthorizedRoots,
): Promise<void> {
  authorizeHostedRuntimePaths(launch, authorizedRoots);
  await Promise.all([
    authorizeRealPath("workspaceRoot", launch.workspaceRoot, authorizedRoots.workspaceRoots),
    authorizeRealPath(
      launch.nativeSession.kind === "new" ? "sessionDirectory" : "sessionFile",
      launch.nativeSession.kind === "new" ? launch.nativeSession.sessionDirectory : launch.nativeSession.sessionFile,
      authorizedRoots.sessionRoots,
    ),
    authorizeRealPath("piAgentDirectory", launch.piAgentDirectory, authorizedRoots.agentRoots),
    authorizeRealDescendant("runtimeHomeDirectory", runtimeHomeDirectory(launch), nativeSessionDirectory(launch)),
  ]);
}

/** Returns the persistent session directory represented by either native target variant. */
export function nativeSessionDirectory(launch: HostedRuntimeLaunch): string {
  return launch.nativeSession.kind === "new"
    ? launch.nativeSession.sessionDirectory
    : dirname(launch.nativeSession.sessionFile);
}

/** Returns the per-session writable home, isolated from the shared read-only Pi agent directory. */
export function runtimeHomeDirectory(launch: HostedRuntimeLaunch): string {
  return resolve(nativeSessionDirectory(launch), "runtime-home");
}
