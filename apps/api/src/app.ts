import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import { ControlPlane } from "./controlPlane.js";

/** Builds the control-plane HTTP surface without binding it to a network port. */
export async function buildApp(config: ApiConfig) {
  const app = Fastify({ logger: true });
  const controlPlane = new ControlPlane(config);

  await app.register(cors, { origin: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: "Invalid request", issues: error.issues });
    }

    return reply.send(error);
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "pi-cloud-api",
  }));

  app.post("/v1/tasks", async (request, reply) => {
    const task = controlPlane.createTask(request.body);
    return reply.code(201).send(task);
  });

  app.get("/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = controlPlane.getTask(taskId);

    return task ?? reply.code(404).send({ message: "Task not found" });
  });

  app.post("/internal/v1/tasks/:taskId/lease", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!hasBearerToken(authorization, config.dispatcherToken)) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const { taskId } = request.params as { taskId: string };
    const audience = (request.body as { audience?: unknown } | undefined)?.audience;
    const lease = controlPlane.issueTaskLease(taskId, audience);

    return lease
      ? reply.code(201).send({ lease })
      : reply.code(404).send({ message: "Task not found" });
  });

  return app;
}

function hasBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return false;
  }

  const token = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return token.length === expected.length && timingSafeEqual(token, expected);
}
