import type { CloudHostedSession, CloudWorkspace } from "@pi-cloud/contracts";
import type { CloudApiClient } from "./api.js";
import { CloudRpcConnection, type CloudSocketFactory } from "./rpc.js";
import type { CloudRepository } from "./repository.js";
import { resolveCloudSession, waitForCloudSessionRunning, type CloudSessionIntent } from "./lifecycle.js";

/** Everything a terminal client needs to start exchanging Pi RPC records with a remote session. */
export type CloudSessionAttachment = {
  workspace: CloudWorkspace;
  session: CloudHostedSession;
  rpc: CloudRpcConnection;
};

export type StartCloudSessionOptions = {
  /** Override the default ~30s wait for a runner to connect. */
  startTimeoutMs?: number;
  /** Override the default 500ms poll interval. */
  pollIntervalMs?: number;
  /** Inject a WebSocket factory for testing. */
  socketFactory?: CloudSocketFactory;
  /** Abort the entire startup flow. */
  signal?: AbortSignal;
};

/**
 * Orchestrates the full client startup path: resolve or create the hosted session, wait for its
 * runtime to connect, mint a single-use ticket, and open the ordered RPC WebSocket. The caller
 * owns the returned connection and is responsible for closing it.
 */
export async function startCloudSession(
  api: CloudApiClient,
  repository: CloudRepository,
  intent: CloudSessionIntent,
  options: StartCloudSessionOptions = {},
): Promise<CloudSessionAttachment> {
  const { workspace, session } = await resolveCloudSession(api, repository, intent);
  const running = await waitForCloudSessionRunning(api, session.id, {
    timeoutMs: options.startTimeoutMs,
    intervalMs: options.pollIntervalMs,
    signal: options.signal,
  });
  const { ticket } = await api.issueRpcTicket(running.id);
  const rpc = await CloudRpcConnection.connect({
    serverUrl: api.serverUrl,
    sessionId: running.id,
    ticket,
    socketFactory: options.socketFactory,
  });
  return { workspace, session: running, rpc };
}
