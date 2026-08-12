import { randomUUID } from "node:crypto";
import { z } from "zod";

const createTaskSchema = z.object({
  repositoryUrl: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "repositoryUrl must use HTTPS",
  }),
  revision: z.string().regex(/^[a-f0-9]{7,64}$/i, "revision must be a Git commit SHA"),
  prompt: z.string().min(1).max(20_000),
});

export type CreateTask = z.infer<typeof createTaskSchema>;

export type Task = CreateTask & {
  id: string;
  status: "queued";
  createdAt: string;
};

/** Holds pre-persistence task records so the API contract can evolve independently of a database. */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();

  create(input: unknown): Task {
    const task = {
      ...createTaskSchema.parse(input),
      id: randomUUID(),
      status: "queued" as const,
      createdAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }
}
