import { createPrivateKey } from "node:crypto";
import { issueTaskLease } from "@pi-cloud/contracts";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import { TaskStore, type Task } from "./tasks.js";

const leaseAudienceSchema = z.string().min(1).max(200);

/** Owns task orchestration capabilities without exposing runner authority on the public HTTP API. */
export class ControlPlane {
  private readonly tasks = new TaskStore();
  private readonly privateKey;

  constructor(private readonly config: ApiConfig) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(config.taskLeasePrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
  }

  createTask(input: unknown): Task {
    return this.tasks.create(input);
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  issueTaskLease(taskId: string, audienceInput: unknown): string | undefined {
    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    return issueTaskLease({
      taskId: task.id,
      repositoryUrl: task.repositoryUrl,
      revision: task.revision,
      issuer: this.config.taskLeaseIssuer,
      audience: leaseAudienceSchema.parse(audienceInput),
      privateKey: this.privateKey,
      ttlSeconds: 300,
    });
  }
}
