/**
 * Regression tests for CR-011 & CR-013 (Module 4 UI wiring):
 * Retries of the same draft invoice or purchase order reuse the same request_id UUID
 * and invoke Release 174's idempotent RPCs, falling back cleanly before 174 is applied.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createInvoiceWithIdempotency,
  createPurchaseOrderWithIdempotency,
  financeRequestIdForAttempt,
} from "@/lib/finance-create-idempotency";

describe("CR-011 & CR-013 (Module 4): request_id idempotency wiring", () => {
  it("reuses request_id across retries of the same payload and rotates on edit", () => {
    let n = 0;
    const make = () => `fin-${++n}`;
    const first = financeRequestIdForAttempt(null, "draft-1", make);
    expect(financeRequestIdForAttempt(first, "draft-1", make)).toBe(first);
    expect(financeRequestIdForAttempt(first, "draft-2", make)).toEqual({ signature: "draft-2", requestId: "fin-2" });
  });

  it("calls create_with_lines_idempotent for draft invoices and falls back cleanly before Release 174", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "inv-1", error: null });
    const res = await createInvoiceWithIdempotency({ rpc, from: vi.fn() } as never, {
      requestId: "req-inv-1",
      header: { customer: "Acme", status: "draft" },
      lines: [{ description: "Machining" }],
    });
    expect(res).toEqual({ invoiceId: "inv-1" });
    expect(rpc).toHaveBeenCalledWith("create_with_lines_idempotent", expect.objectContaining({
      p_request_id: "req-inv-1",
      p_parent: "invoices",
      p_child: "invoice_line_items",
      p_fk: "invoice_id",
    }));

    const rpcFallback = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } })
      .mockResolvedValueOnce({ data: "inv-2", error: null });
    const fb = await createInvoiceWithIdempotency({ rpc: rpcFallback, from: vi.fn() } as never, {
      requestId: "req-inv-2",
      header: { customer: "Acme", status: "draft" },
      lines: [{ description: "Machining" }],
    });
    expect(fb).toEqual({ invoiceId: "inv-2" });
    expect(rpcFallback).toHaveBeenLastCalledWith("create_with_lines", expect.objectContaining({ p_parent: "invoices" }));
  });

  it("calls create_purchase_order_idempotent without pre-allocating PO numbers, with pre-174 fallback", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "po-1", po_ref: "PO-0042", replayed: true }, error: null });
    const alloc = vi.fn();
    const res = await createPurchaseOrderWithIdempotency({ rpc, from: vi.fn() } as never, {
      requestId: "req-po-1",
      organizationId: "org-1",
      header: { supplier: "Steel Ltd", status: "draft" },
      allocatePoRef: alloc,
    });
    expect(res).toEqual({ poRef: "PO-0042", replayed: true });
    expect(alloc).not.toHaveBeenCalled();

    const insert = vi.fn().mockResolvedValue({ error: null });
    const rpcMissing = vi.fn().mockResolvedValue({ data: null, error: { code: "42883", message: "missing" } });
    const alloc2 = vi.fn().mockResolvedValue("PO-0043");
    const fb = await createPurchaseOrderWithIdempotency({ rpc: rpcMissing, from: () => ({ insert }) } as never, {
      requestId: "req-po-2",
      organizationId: "org-1",
      header: { supplier: "Steel Ltd", status: "draft" },
      allocatePoRef: alloc2,
    });
    expect(fb).toEqual({ poRef: "PO-0043", replayed: false });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("wires request_id helpers into invoices and purchase-orders pages", () => {
    expect(readFileSync("app/(dashboard)/invoices/page.tsx", "utf8")).toContain("createInvoiceWithIdempotency(");
    expect(readFileSync("app/(dashboard)/purchase-orders/page.tsx", "utf8")).toContain("createPurchaseOrderWithIdempotency(");
  });
});
