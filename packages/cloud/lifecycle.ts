import { randomUUID } from "node:crypto";
import type {
  CloudHostedSession,
  CloudWorkspace,
} from "@pi-cloud/contracts";
import type { CloudApiClient } from "./api.js";
import type { CloudRepository } from "./repository.js";

export type CloudSessionIntent = "new" | "continue";

/** Maps local repository intent to one durable hosted workspace and session. */
export async function resolveCloudSession(
  api: Pick<CloudApiClient,
    | "capabilities"
    | "listWorkspaces"
    | "createWorkspace"
    | "listHostedSessions"
    | "createHostedSession"
    | "startHostedSession">,
  repository: CloudRepository,
  intent: CloudSessionIntent,
  options: {
    projectTrust?: "trusted" | "untrusted";
    credentialReferenceNames?: string[];
    idempotencyKey?: () => string;
  } = {},
): Promise<{ workspace: CloudWorkspace; session: CloudHostedSession }> {
  await api.capabilities();
  const repositoryWorkspaces = (await listAllWorkspaces((cursor) => api.listWorkspaces(cursor)))
    .filter((candidate) => candidate.repositoryUrl === repository.repositoryUrl);
  let workspace = intent === "continue"
    ? repositoryWorkspaces.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    : repositoryWorkspaces.find((candidate) => candidate.revision === repository.revision);
  const nextKey = options.idempotencyKey ?? randomUUID;
  workspace ??= await api.createWorkspace({
    repositoryUrl: repository.repositoryUrl,
    revision: repository.revision,
    projectTrust: options.projectTrust,
    credentialReferenceNames: options.credentialReferenceNames,
    idempotencyKey: nextKey(),
  });

  if (intent === "new") {
    return {
      workspace,
      session: await api.createHostedSession(workspace.id, nextKey()),
    };
  }

  const sessions = await api.listHostedSessions(workspace.id);
  const resumable = sessions.items
    .filter((session) => session.state !== "archived")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!resumable) {
    return {
      workspace,
      session: await api.createHostedSession(workspace.id, nextKey()),
    };
  }
  return {
    workspace,
    session: resumable.state === "stopped"
      ? await api.startHostedSession(resumable.id)
      : resumable,
  };
}

/** Polls durable lifecycle state until a runner has connected or the bounded wait expires. */
export async function waitForCloudSessionRunning(
  api: Pick<CloudApiClient, "getHostedSession">,
  sessionId: string,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<CloudHostedSession> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    options.signal?.throwIfAborted();
    const session = await api.getHostedSession(sessionId);
    if (session.state === "running") return session;
    if (session.state === "stopped" || session.state === "archived") {
      throw new Error(`Hosted session entered ${session.state} before its runtime connected`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for hosted session ${sessionId} to start`);
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), options.signal);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Collects every owned workspace across pages, rejecting a server that fails to advance. */
async function listAllWorkspaces(
  list: (cursor: string | undefined) => Promise<{ items: CloudWorkspace[]; nextCursor: string | null }>,
): Promise<CloudWorkspace[]> {
  const workspaces: CloudWorkspace[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error("Pi Cloud workspace lookup made no progress");
      seenCursors.add(cursor);
    }
    const page = await list(cursor);
    workspaces.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return workspaces;
}
