import { Readable } from "node:stream";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type WebSocket from "ws";
import { ZodError, z } from "zod";
import { Authenticator, bearerToken, hasBearerToken } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { ControlPlane } from "./controlPlane.js";
import type { HostedSession, Principal, RunEvent, Workspace } from "./domain.js";
import { ApiError, unauthorized } from "./errors.js";
import { HostedControlPlane } from "./hostedControlPlane.js";

declare module "fastify" {
  interface FastifyRequest {
    hostedClientSession?: HostedSession;
    hostedRuntimeAssignment?: { assignmentId: string; session: HostedSession; workspace: Workspace };
  }
}

const idParamsSchema = z.object({
  agentId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  leaseId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
});

/** Builds the authenticated control-plane HTTP surface without binding a port. */
export async function buildApp(config: ApiConfig, clock?: () => Date) {
  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "req.headers['sec-websocket-protocol']",
        "headers.authorization",
        "headers['sec-websocket-protocol']",
      ],
    },
  });
  const controlPlane = new ControlPlane(config, clock);
  const hostedControlPlane = new HostedControlPlane(config, controlPlane.store, clock);
  const authenticator = new Authenticator(config.apiCredentials);

  await app.register(cors, { origin: false });
  await app.register(websocket, {
    options: {
      maxPayload: config.hostedLaunchLimits.maxRecordBytes,
      handleProtocols: (protocols) => protocols.has("pi-cloud-rpc") ? "pi-cloud-rpc" : false,
    },
  });
  app.addHook("preClose", async () => hostedControlPlane.close());
  app.addHook("onClose", async () => controlPlane.close());

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ code: "invalid_request", message: "Invalid request", issues: error.issues });
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    request.log.error({ err: error }, "Unhandled control-plane error");
    return reply.code(500).send({ code: "internal_error", message: "Internal server error" });
  });

  const principal = (authorization: string | undefined): Principal => authenticator.authenticate(authorization);

  app.get("/health", async () => ({ status: "ok", service: "pi-cloud-api" }));

  app.post("/v1/agents", async (request, reply) => {
    const result = controlPlane.createAgent(
      principal(request.headers.authorization),
      request.body,
      request.headers["idempotency-key"],
    );
    return reply.code(201).send(result);
  });

  app.get("/v1/agents", async (request) =>
    controlPlane.listAgents(principal(request.headers.authorization), request.query),
  );

  app.get("/v1/agents/:agentId", async (request) => {
    const { agentId } = idParamsSchema.parse(request.params);
    return controlPlane.getAgent(principal(request.headers.authorization), required(agentId));
  });

  app.post("/v1/agents/:agentId/runs", async (request, reply) => {
    const { agentId } = idParamsSchema.parse(request.params);
    const run = controlPlane.createFollowUp(
      principal(request.headers.authorization),
      required(agentId),
      request.body,
      request.headers["idempotency-key"],
    );
    return reply.code(201).send(run);
  });

  app.get("/v1/runs", async (request) =>
    controlPlane.listRuns(principal(request.headers.authorization), request.query),
  );

  app.get("/v1/runs/:runId", async (request) => {
    const { runId } = idParamsSchema.parse(request.params);
    return controlPlane.getRun(principal(request.headers.authorization), required(runId));
  });

  app.post("/v1/runs/:runId/cancel", async (request) => {
    const { runId } = idParamsSchema.parse(request.params);
    return controlPlane.cancelRun(principal(request.headers.authorization), required(runId));
  });

  app.post("/v1/agents/:agentId/archive", async (request) => {
    const { agentId } = idParamsSchema.parse(request.params);
    return controlPlane.archiveAgent(principal(request.headers.authorization), required(agentId), true);
  });

  app.post("/v1/agents/:agentId/unarchive", async (request) => {
    const { agentId } = idParamsSchema.parse(request.params);
    return controlPlane.archiveAgent(principal(request.headers.authorization), required(agentId), false);
  });

  app.delete("/v1/agents/:agentId", async (request, reply) => {
    const { agentId } = idParamsSchema.parse(request.params);
    controlPlane.deleteAgent(principal(request.headers.authorization), required(agentId));
    return reply.code(204).send();
  });

  app.get("/v1/runs/:runId/events", async (request, reply) => {
    const caller = principal(request.headers.authorization);
    const { runId } = idParamsSchema.parse(request.params);
    const id = required(runId);
    const query = z.object({ cursor: z.string().optional(), follow: z.enum(["true", "false"]).default("true") }).parse(request.query);
    const headerCursor = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    const cursor = query.cursor ?? headerCursor;
    const initial = controlPlane.listEvents(caller, id, cursor);

    reply.headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    return reply.send(
      Readable.from(
        eventStream(controlPlane, caller, id, cursor, initial, query.follow === "true", () => request.raw.destroyed),
      ),
    );
  });

  app.post("/v1/workspaces", async (request, reply) => {
    const workspace = hostedControlPlane.createWorkspace(
      principal(request.headers.authorization),
      request.body,
      request.headers["idempotency-key"],
    );
    return reply.code(201).send(workspace);
  });

  app.get("/v1/workspaces", async (request) =>
    hostedControlPlane.listWorkspaces(principal(request.headers.authorization), request.query),
  );

  app.get("/v1/workspaces/:workspaceId", async (request) => {
    const { workspaceId } = idParamsSchema.parse(request.params);
    return hostedControlPlane.getWorkspace(principal(request.headers.authorization), required(workspaceId));
  });

  app.post("/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
    const { workspaceId } = idParamsSchema.parse(request.params);
    const session = hostedControlPlane.createHostedSession(
      principal(request.headers.authorization),
      required(workspaceId),
      request.body,
      request.headers["idempotency-key"],
    );
    return reply.code(201).send(session);
  });

  app.get("/v1/hosted-sessions/:sessionId", async (request) => {
    const { sessionId } = idParamsSchema.parse(request.params);
    return hostedControlPlane.getHostedSession(principal(request.headers.authorization), required(sessionId));
  });

  app.post("/v1/hosted-sessions/:sessionId/start", async (request) => {
    const { sessionId } = idParamsSchema.parse(request.params);
    return hostedControlPlane.startHostedSession(principal(request.headers.authorization), required(sessionId));
  });

  app.post("/v1/hosted-sessions/:sessionId/stop", async (request) => {
    const { sessionId } = idParamsSchema.parse(request.params);
    return hostedControlPlane.stopHostedSession(principal(request.headers.authorization), required(sessionId));
  });

  app.post("/v1/hosted-sessions/:sessionId/archive", async (request) => {
    const { sessionId } = idParamsSchema.parse(request.params);
    return hostedControlPlane.archiveHostedSession(principal(request.headers.authorization), required(sessionId));
  });

  app.post("/v1/hosted-sessions/:sessionId/rpc-ticket", async (request, reply) => {
    const { sessionId } = idParamsSchema.parse(request.params);
    const ticket = hostedControlPlane.issueClientTicket(
      principal(request.headers.authorization),
      required(sessionId),
    );
    return reply.code(201).send(ticket);
  });

  app.get(
    "/v1/hosted-sessions/:sessionId/rpc",
    {
      websocket: true,
      preHandler: async (request) => {
        const { sessionId } = idParamsSchema.parse(request.params);
        const id = required(sessionId);
        request.hostedClientSession = request.headers.authorization
          ? hostedControlPlane.authorizeClientConnection(principal(request.headers.authorization), id)
          : hostedControlPlane.authorizeClientTicket(id, browserAttachmentTicket(request.headers["sec-websocket-protocol"]));
      },
    },
    (socket: WebSocket, request) => {
      const session = request.hostedClientSession as HostedSession;
      hostedControlPlane.router.attachClient(session.id, socket);
    },
  );

  app.post("/internal/v1/hosted-runtimes/claim", async (request, reply) => {
    requireDispatcher(request.headers.authorization, config.dispatcherToken);
    const claim = hostedControlPlane.claimHostedRuntime(request.body);
    return claim ? reply.code(201).send(claim) : reply.code(204).send();
  });

  app.get(
    "/internal/v1/hosted-sessions/:sessionId/tunnel",
    {
      websocket: true,
      preHandler: async (request) => {
        const { sessionId } = idParamsSchema.parse(request.params);
        const token = bearerToken(request.headers.authorization);
        if (!token) throw unauthorized();
        const id = required(sessionId);
        request.hostedRuntimeAssignment = hostedControlPlane.authorizeRuntimeAssignment(id, token);
        if (hostedControlPlane.router.hasRuntime(id)) {
          throw new ApiError(409, "runtime_already_connected", "Hosted session runtime is already connected");
        }
      },
    },
    (socket: WebSocket, request) => {
      const assignment = request.hostedRuntimeAssignment as NonNullable<typeof request.hostedRuntimeAssignment>;
      hostedControlPlane.router.attachRuntime({
        sessionId: assignment.session.id,
        assignmentId: assignment.assignmentId,
        workspaceRoot: assignment.workspace.root,
        limits: config.hostedLaunchLimits,
        socket,
      });
    },
  );

  app.post("/internal/v1/runs/claim", async (request, reply) => {
    requireDispatcher(request.headers.authorization, config.dispatcherToken);
    const lease = controlPlane.claimRun(request.body);
    return lease ? reply.code(201).send({ lease }) : reply.code(204).send();
  });

  app.post("/internal/v1/leases/redeem", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    return reply.code(200).send(controlPlane.redeemLease(token, request.body));
  });

  app.post("/internal/v1/leases/:leaseId/heartbeat", async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    const { leaseId } = idParamsSchema.parse(request.params);
    return controlPlane.heartbeatLease(token, required(leaseId), request.body);
  });

  app.post("/internal/v1/runs/:runId/checkout-provenance", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    const { runId } = idParamsSchema.parse(request.params);
    return reply.code(201).send(controlPlane.reportCheckoutProvenance(token, required(runId), request.body));
  });

  app.post("/internal/v1/runs/:runId/events", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    const { runId } = idParamsSchema.parse(request.params);
    return reply.code(201).send(controlPlane.ingestEvent(token, required(runId), request.body));
  });

  app.post("/internal/v1/recovery", async (request) => {
    requireDispatcher(request.headers.authorization, config.dispatcherToken);
    return controlPlane.recover();
  });

  return app;
}

async function* eventStream(
  controlPlane: ControlPlane,
  principal: Principal,
  runId: string,
  initialCursor: string | undefined,
  initialEvents: RunEvent[],
  follow: boolean,
  disconnected: () => boolean,
): AsyncGenerator<string> {
  let cursor = initialCursor;
  let events = initialEvents;
  while (!disconnected()) {
    for (const event of events) {
      cursor = event.cursor;
      yield formatSse(event);
    }
    if (events.length === ControlPlane.eventBatchSize) {
      try {
        events = controlPlane.listEvents(principal, runId, cursor);
      } catch (error: unknown) {
        if (error instanceof ApiError && error.statusCode === 404) return;
        throw error;
      }
      continue;
    }
    if (!follow) return;
    try {
      if (controlPlane.isRunTerminal(principal, runId)) return;
    } catch (error: unknown) {
      if (error instanceof ApiError && error.statusCode === 404) return;
      throw error;
    }
    await delay(15_000);
    if (disconnected()) return;
    yield `: heartbeat ${new Date().toISOString()}\n\n`;
    try {
      events = controlPlane.listEvents(principal, runId, cursor);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.statusCode === 404) return;
      throw error;
    }
  }
}

function formatSse(event: RunEvent): string {
  return `id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function requireDispatcher(authorization: string | undefined, expected: string): void {
  if (!hasBearerToken(authorization, expected)) throw unauthorized();
}

function required(value: string | undefined): string {
  if (!value) throw new ApiError(400, "invalid_request", "Required identifier is missing");
  return value;
}

function browserAttachmentTicket(protocolHeader: string | string[] | undefined): string | undefined {
  const protocols = (Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader ?? "")
    .split(",")
    .map((value) => value.trim());
  if (!protocols.includes("pi-cloud-rpc")) return undefined;
  return protocols.find((value) => value.startsWith("pi-cloud-ticket."))?.slice("pi-cloud-ticket.".length);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
