/** The batch's real dependencies against a fake service-role client: the queue head applies the claim's eligibility, and every read carries the company. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integrations/server", () => ({ sendQueued: vi.fn() }));

import { batchDeps } from "@/lib/integrations/xero/batch-deps";

const pending = (id: string, docId: string, action: "create" | "void") => ({ id, doc_type: "invoice", doc_id: docId, doc_ref: `R-${docId}`, action, status: "pending", attempts: 1,
  external_id: null, external_number: null, last_error: null, next_attempt_at: "2026-10-30T11:00:00Z", sent_at: null });

function service(queue: unknown[], creates: unknown[]) {
  const filters: Array<[string, unknown]> = [];
  const from = () => {
    let isCreateLookup = false;
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ["select", "lte", "gt", "order", "limit"]) q[m] = chain;
    q.eq = (col: string, val: unknown) => { filters.push([col, val]); if (col === "action" && val === "create") isCreateLookup = true; return q; };
    q.in = async () => ({ data: creates, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: isCreateLookup ? creates : queue, error: null });
    return q;
  };
  return { client: { from } as never, filters };
}

describe("dueQueue", () => {
  it("a void whose invoice has not been sent yet is not the head (the claim skips it), so it does not stall the batch", async () => {
    const s = service([pending("v1", "d1", "void"), pending("c1", "d2", "create"), pending("v2", "d3", "void")], [{ doc_id: "d3", status: "sent", external_id: "x" }]);
    const deps = batchDeps({ user: {} as never, service: s.client, org: "org-1", ready: { config: {} as never, key: Buffer.alloc(32) } });
    expect((await deps.dueQueue()).map((r) => r.id)).toEqual(["c1", "v2"]);
    expect(s.filters).toContainEqual(["organization_id", "org-1"]);
  });
});
