import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { HostedRuntimeLaunch } from "@pi-cloud/contracts";
import { nativeSessionDirectory, runtimeHomeDirectory } from "./pathAuthorization.js";

export type RuntimeProcessIdentity = { uid: number; gid: number };

/** Derives a stable high-numbered Linux identity for one workspace UUID. */
export function workspaceProcessIdentity(workspaceId: string): RuntimeProcessIdentity {
  const value = createHash("sha256").update(workspaceId).digest().readUInt32BE(0);
  const uid = 100_000 + (value % 1_000_000_000);
  return { uid, gid: uid };
}

/** Gives one workspace identity exclusive ownership of its repository, session data, and runtime home. */
export async function prepareIsolatedWorkspace(launch: HostedRuntimeLaunch): Promise<RuntimeProcessIdentity> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("workspace_uid isolation requires a root Linux runner supervisor");
  }

  const storageRoot = dirname(launch.workspaceRoot);
  if (basename(storageRoot) !== launch.workspaceId || basename(launch.workspaceRoot) !== "repository") {
    throw new Error("Hosted workspace layout does not match its workspace identity");
  }
  const sessionDirectory = nativeSessionDirectory(launch);
  if (!isDescendant(storageRoot, sessionDirectory)) {
    throw new Error("Native session directory must stay inside its workspace storage root");
  }

  const identity = workspaceProcessIdentity(launch.workspaceId);
  await rejectIdentityCollision(dirname(storageRoot), basename(storageRoot), identity.uid);
  await Promise.all([
    fs.mkdir(launch.workspaceRoot, { recursive: true }),
    fs.mkdir(sessionDirectory, { recursive: true }),
    fs.mkdir(runtimeHomeDirectory(launch), { recursive: true, mode: 0o700 }),
  ]);
  await fs.chmod(storageRoot, 0o700);
  await chownTree(storageRoot, identity.uid, identity.gid);
  return identity;
}

function isDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function rejectIdentityCollision(parent: string, workspaceDirectory: string, uid: number): Promise<void> {
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === workspaceDirectory) continue;
    const stats = await fs.lstat(join(parent, entry.name));
    if (stats.uid === uid) throw new Error("Derived workspace process identity collides with an existing workspace");
  }
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const stats = await fs.lstat(path);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const entry of await fs.readdir(path)) await chownTree(join(path, entry), uid, gid);
  }
  await fs.lchown(path, uid, gid);
}
