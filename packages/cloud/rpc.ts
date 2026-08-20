import { randomUUID } from "node:crypto";
import {
  hostedRpcClientEnvelopeSchema,
  hostedRpcEnvelopeSchema,
  type PiRpcClientCommand,
  type PiRpcRecord,
} from "@pi-cloud/contracts";
import { apiUrl } from "./api.js";

const maxInboundBytes = 1_048_576;

type SocketEvent = { data?: unknown };
type SocketListener = (event: SocketEvent) => void;

export type CloudSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: SocketListener, options?: { once?: boolean }): void;
};

export type CloudSocketFactory = (url: string, protocols: string[]) => CloudSocket;

type PendingRequest = {
  resolve: (record: PiRpcRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Ordered hosted-RPC transport used by the cloud terminal after lifecycle attachment. */
export class CloudRpcConnection {
  private outboundSequence = 0;
  private inboundSequence = 0;
  private readonly listeners = new Set<(record: PiRpcRecord) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  private constructor(
    readonly sessionId: string,
    private readonly socket: CloudSocket,
  ) {
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data).catch((error: unknown) => this.fail(error));
    });
    socket.addEventListener("close", () => this.fail(new Error("Pi Cloud RPC connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("Pi Cloud RPC connection failed")));
  }

  /** Opens a ticket-authenticated WebSocket without putting the bearer token in its URL. */
  static async connect(options: {
    serverUrl: string;
    sessionId: string;
    ticket: string;
    socketFactory?: CloudSocketFactory;
  }): Promise<CloudRpcConnection> {
    const endpoint = apiUrl(
      options.serverUrl,
      `v1/hosted-sessions/${encodeURIComponent(options.sessionId)}/rpc`,
    );
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const factory = options.socketFactory ?? defaultSocketFactory;
    const socket = factory(endpoint.toString(), ["pi-cloud-rpc", `pi-cloud-ticket.${options.ticket}`]);
    await waitForOpen(socket);
    return new CloudRpcConnection(options.sessionId, socket);
  }

  subscribe(listener: (record: PiRpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: PiRpcClientCommand): void {
    if (this.closed || this.socket.readyState !== 1) throw new Error("Pi Cloud RPC connection is not open");
    const sequence = this.outboundSequence + 1;
    const envelope = hostedRpcClientEnvelopeSchema.parse({
      version: 1,
      hostedSessionId: this.sessionId,
      direction: "client_to_pi",
      sequence,
      record: command,
    });
    try {
      this.socket.send(JSON.stringify(envelope));
      this.outboundSequence = sequence;
    } catch (error: unknown) {
      this.fail(error);
      throw error;
    }
  }

  request(command: PiRpcClientCommand, timeoutMs = 30_000): Promise<PiRpcRecord> {
    const id = command.id ?? randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response ${id}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...command, id } as PiRpcClientCommand);
      } catch (error: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "client closed");
    this.rejectPending(new Error("Pi Cloud RPC connection closed"));
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = await messageText(data);
    if (Buffer.byteLength(text, "utf8") > maxInboundBytes) throw new Error("Pi Cloud RPC message exceeds 1048576 bytes");
    const envelope = hostedRpcEnvelopeSchema.parse(JSON.parse(text) as unknown);
    if (envelope.direction !== "pi_to_client" || envelope.hostedSessionId !== this.sessionId) {
      throw new Error("Pi Cloud RPC envelope belongs to a different channel");
    }
    if (envelope.sequence !== this.inboundSequence + 1) {
      throw new Error("Pi Cloud RPC envelope sequence is not contiguous");
    }
    this.inboundSequence = envelope.sequence;

    const id = typeof envelope.record.id === "string" ? envelope.record.id : undefined;
    const pending = id ? this.pending.get(id) : undefined;
    if (id && pending && envelope.record.type === "response") {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(envelope.record);
    }
    for (const listener of this.listeners) listener(envelope.record);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(4400, "client protocol failure");
    this.rejectPending(asError(error));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultSocketFactory(url: string, protocols: string[]): CloudSocket {
  return new WebSocket(url, protocols) as unknown as CloudSocket;
}

function waitForOpen(socket: CloudSocket): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Pi Cloud RPC connection failed")), { once: true });
    socket.addEventListener("close", () => reject(new Error("Pi Cloud RPC connection closed before opening")), { once: true });
  });
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maxInboundBytes) throw new Error("Pi Cloud RPC message exceeds 1048576 bytes");
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > maxInboundBytes) throw new Error("Pi Cloud RPC message exceeds 1048576 bytes");
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > maxInboundBytes) throw new Error("Pi Cloud RPC message exceeds 1048576 bytes");
    return data.text();
  }
  throw new Error("Pi Cloud RPC received an unsupported WebSocket message");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
