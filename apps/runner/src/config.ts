import { z } from "zod";

const runnerConfigSchema = z.object({
  controlPlaneUrl: z.url(),
  taskLease: z.string().min(1),
});

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

/** Reads the minimum single-task lease configuration required by a runner. */
export function readRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  return runnerConfigSchema.parse({
    controlPlaneUrl: env.PI_CLOUD_CONTROL_PLANE_URL,
    taskLease: env.PI_CLOUD_TASK_LEASE,
  });
}
