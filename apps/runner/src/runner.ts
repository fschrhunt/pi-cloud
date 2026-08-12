import { readRunnerConfig } from "./config.js";

/** Validates runner boot configuration; Pi RPC startup is the next vertical slice. */
function main() {
  const config = readRunnerConfig(process.env);
  console.log(`Runner lease accepted for ${new URL(config.controlPlaneUrl).origin}`);
}

try {
  main();
} catch (error: unknown) {
  console.error("Runner configuration is invalid. A signed task lease is required.");
  console.error(error);
  process.exitCode = 1;
}
