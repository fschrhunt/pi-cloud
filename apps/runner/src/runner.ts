import { readRunnerConfig, readTaskLease } from "./config.js";

/** Verifies single-task authority before the runner can begin repository execution. */
function main() {
  const config = readRunnerConfig(process.env);
  const lease = readTaskLease(config);
  console.log(`Runner accepted task ${lease.taskId} from ${new URL(config.controlPlaneUrl).origin}`);
}

try {
  main();
} catch (error: unknown) {
  console.error("Runner configuration is invalid. A signed task lease is required.");
  console.error(error);
  process.exitCode = 1;
}
