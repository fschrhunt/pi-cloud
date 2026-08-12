import { buildApp } from "./app.js";
import { readApiConfig } from "./config.js";

/** Starts the local control-plane API and exits cleanly when its process is stopped. */
async function start() {
  const app = await buildApp(readApiConfig(process.env));
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);

  await app.listen({ host: "0.0.0.0", port });
}

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
