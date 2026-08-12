import { Readable } from "node:stream";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError, z } from "zod";
import { Authenticator, bearerToken, hasBearerToken } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { ControlPlane } from "./controlPlane.js";
import type { Principal, RunEvent } from "./domain.js";
import { ApiError, unauthorized } from "./errors.js";

const idParamsSchema = z.object({ agentId: z.string().uuid().optional(), runId: z.string().uuid().optional(), leaseId: z.string().uuid().optional() });

/** Builds the authenticated control-plane HTTP surface without binding a port. */
export async function buildApp(config: ApiConfig, clock?: () => Date) {
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization", "req.headers['x-api-key']", "headers.authorization"],
    },
  });
  const controlPlane = new ControlPlane(config, clock);
  const authenticator = new Authenticator(config.apiCredentials);

  await app.register(cors, { origin: false });
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
      events = controlPlane.listEvents(principal, runId, cursor);
      continue;
    }
    if (!follow || controlPlane.isRunTerminal(principal, runId)) return;
    await delay(15_000);
    if (disconnected()) return;
    yield `: heartbeat ${new Date().toISOString()}\n\n`;
    events = controlPlane.listEvents(principal, runId, cursor);
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
