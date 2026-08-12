import cors from "@fastify/cors";
import Fastify from "fastify";

/** Builds the control-plane HTTP surface without binding it to a network port. */
export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: false });

  app.get("/health", async () => ({
    status: "ok",
    service: "pi-cloud-api",
  }));

  return app;
}
