import { checkoutProvenanceSchema, type CheckoutProvenance } from "@pi-cloud/contracts";
import { z } from "zod";

const redeemLeaseResponseSchema = z.object({
  taskId: z.uuid(),
  runId: z.uuid(),
  budgets: z.object({
    wallTimeSeconds: z.number(),
    idleTimeSeconds: z.number(),
    cpuSeconds: z.number(),
    memoryMb: z.number(),
    artifactBytes: z.number(),
    eventCount: z.number(),
    eventBytes: z.number(),
    eventPayloadBytes: z.number(),
    providerUsage: z.number().optional(),
    maxRetries: z.number(),
  }),
  cancelRequested: z.boolean(),
});

export type RedeemedLease = z.infer<typeof redeemLeaseResponseSchema>;

export interface RunnerControlPlaneClient {
  redeemLease(runnerId: string): Promise<RedeemedLease>;
  reportCheckoutProvenance(runId: string, provenance: CheckoutProvenance): Promise<CheckoutProvenance>;
}

/** Talks to the authenticated control-plane runner endpoints for one leased task. */
export class ControlPlaneClient implements RunnerControlPlaneClient {
  constructor(
    private readonly controlPlaneUrl: URL,
    private readonly taskLease: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  async redeemLease(runnerId: string): Promise<RedeemedLease> {
    return redeemLeaseResponseSchema.parse(
      await this.postJson("/internal/v1/leases/redeem", { runnerId }),
    );
  }

  async reportCheckoutProvenance(runId: string, provenance: CheckoutProvenance): Promise<CheckoutProvenance> {
    return checkoutProvenanceSchema.parse(
      await this.postJson(`/internal/v1/runs/${runId}/checkout-provenance`, provenance),
    );
  }

  private async postJson(pathname: string, body: unknown): Promise<unknown> {
    const response = await this.http(new URL(pathname, this.controlPlaneUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.taskLease}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const details = await tryReadJson(response);
      const message =
        typeof details === "object" && details !== null && "message" in details && typeof details.message === "string"
          ? details.message
          : `Control plane request failed with ${response.status}`;
      throw new Error(message);
    }

    return response.json();
  }
}

async function tryReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
