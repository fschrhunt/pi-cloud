import {
  cloudHostedSessionListSchema,
  cloudHostedSessionSchema,
  cloudRpcTicketSchema,
  cloudServerCapabilitiesSchema,
  cloudWorkspaceListSchema,
  cloudWorkspaceSchema,
  type CloudClientConfig,
  type CloudHostedSession,
  type CloudServerCapabilities,
  type CloudWorkspace,
} from "@pi-cloud/contracts";
import { z } from "zod";

const maxResponseBytes = 1_048_576;
const apiErrorSchema = z.object({
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(4_000),
});

type Fetch = typeof fetch;

/** Minimal authenticated HTTP client for hosted workspace and session lifecycle. */
export class CloudApiClient {
  constructor(
    private readonly config: CloudClientConfig,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  capabilities(): Promise<CloudServerCapabilities> {
    return this.request("v1/capabilities", cloudServerCapabilitiesSchema, { authenticated: false });
  }

  listWorkspaces(cursor?: string): Promise<{ items: CloudWorkspace[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return this.request(`v1/workspaces?${query.toString()}`, cloudWorkspaceListSchema);
  }

  createWorkspace(input: {
    repositoryUrl: string;
    revision: string;
    projectTrust?: "trusted" | "untrusted";
    credentialReferenceNames?: string[];
    idempotencyKey: string;
  }): Promise<CloudWorkspace> {
    return this.request("v1/workspaces", cloudWorkspaceSchema, {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        repositoryUrl: input.repositoryUrl,
        revision: input.revision,
        projectTrust: input.projectTrust ?? "untrusted",
        credentialReferenceNames: input.credentialReferenceNames ?? [],
      },
    });
  }

  listHostedSessions(workspaceId: string): Promise<{ items: CloudHostedSession[] }> {
    return this.request(
      `v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
      cloudHostedSessionListSchema,
    );
  }

  createHostedSession(workspaceId: string, idempotencyKey: string): Promise<CloudHostedSession> {
    return this.request(`v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`, cloudHostedSessionSchema, {
      method: "POST",
      idempotencyKey,
      body: {},
    });
  }

  getHostedSession(sessionId: string): Promise<CloudHostedSession> {
    return this.request(`v1/hosted-sessions/${encodeURIComponent(sessionId)}`, cloudHostedSessionSchema);
  }

  startHostedSession(sessionId: string): Promise<CloudHostedSession> {
    return this.request(`v1/hosted-sessions/${encodeURIComponent(sessionId)}/start`, cloudHostedSessionSchema, {
      method: "POST",
      body: {},
    });
  }

  issueRpcTicket(sessionId: string): Promise<{ ticket: string; expiresAt: string }> {
    return this.request(`v1/hosted-sessions/${encodeURIComponent(sessionId)}/rpc-ticket`, cloudRpcTicketSchema, {
      method: "POST",
      body: {},
    });
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      authenticated?: boolean;
      method?: "GET" | "POST";
      idempotencyKey?: string;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (options.authenticated !== false) headers.set("authorization", `Bearer ${this.config.token}`);
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    if (options.body !== undefined) headers.set("content-type", "application/json");

    const response = await this.fetchImplementation(apiUrl(this.config.serverUrl, path), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
    });
    const bytes = await readBoundedResponse(response);

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error: unknown) {
      throw new Error(`Pi Cloud API returned invalid JSON (${response.status})`, { cause: error });
    }
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(value);
      throw new Error(parsed.success
        ? `Pi Cloud API ${parsed.data.code}: ${parsed.data.message}`
        : `Pi Cloud API request failed with status ${response.status}`);
    }
    return schema.parse(value);
  }
}

/** Resolves an API route without discarding an operator-configured reverse-proxy base path. */
export function apiUrl(serverUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), `${serverUrl.replace(/\/+$/u, "")}/`);
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new Error("Pi Cloud API response exceeds 1048576 bytes");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error("Pi Cloud API response exceeds 1048576 bytes");
    }
    chunks.push(chunk.value);
  }

  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
