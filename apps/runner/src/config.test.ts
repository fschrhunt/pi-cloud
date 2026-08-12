import assert from "node:assert/strict";
import test from "node:test";
import { readRunnerConfig } from "./config.js";

test("runner requires a control-plane URL and task lease", () => {
  assert.deepEqual(
    readRunnerConfig({
      PI_CLOUD_CONTROL_PLANE_URL: "https://control.pi-cloud.test",
      PI_CLOUD_TASK_LEASE: "development-lease",
    }),
    {
      controlPlaneUrl: "https://control.pi-cloud.test",
      taskLease: "development-lease",
    },
  );
});

test("runner refuses to start without a task lease", () => {
  assert.throws(() => readRunnerConfig({ PI_CLOUD_CONTROL_PLANE_URL: "https://control.pi-cloud.test" }));
});
