import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Server-generated absolute filesystem locations derived from configured roots and identifiers. The
 * API never mounts or reads these paths; it only computes and lexically validates their strings so
 * the runner's independently configured authority is the sole filesystem boundary that matters.
 */

/** Deterministic per-workspace root the API assigns at workspace creation. */
export function workspaceRootFor(runtimeWorkspaceRoot: string, workspaceId: string): string {
  return join(runtimeWorkspaceRoot, workspaceId, "repository");
}

/** Deterministic native-session root nested under one workspace's root. */
export function sessionRootFor(workspaceRoot: string): string {
  return join(dirname(workspaceRoot), "native-sessions");
}

/** Deterministic new-session directory the API assigns the first time a hosted session launches. */
export function newSessionDirectoryFor(workspaceRoot: string, hostedSessionId: string): string {
  return join(sessionRootFor(workspaceRoot), hostedSessionId);
}

/** Lexical containment check only; the runner independently re-validates through its own real paths. */
export function isContainedPath(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}
