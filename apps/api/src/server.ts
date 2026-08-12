import { buildApp } from "./app.js";

/** Starts the local control-plane API and exits cleanly when its process is stopped. */
async function start() {
  const app = await buildApp();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);

  await app.listen({ host: "0.0.0.0", port });
}

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
