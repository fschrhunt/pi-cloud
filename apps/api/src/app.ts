import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import { TaskStore } from "./tasks.js";

/** Builds the control-plane HTTP surface without binding it to a network port. */
export async function buildApp() {
  const app = Fastify({ logger: true });
  const tasks = new TaskStore();

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
    const task = tasks.create(request.body);
    return reply.code(201).send(task);
  });

  app.get("/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.get(taskId);

    return task ?? reply.code(404).send({ message: "Task not found" });
  });

  return app;
}
