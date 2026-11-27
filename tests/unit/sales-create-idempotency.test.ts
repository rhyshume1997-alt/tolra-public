/**
 * Regression tests for CR-010 & CR-012 (Module 3 UI wiring):
 * Retries of the same draft quote or manual sales order reuse the same request_id UUID
 * and invoke Release 174's idempotent RPCs, falling back cleanly before 174 is applied.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createQuoteWithIdempotency,
  createSalesOrderWithIdempotency,
  requestIdForAttempt,
} from "@/lib/sales-create-idempotency";

describe("CR-010 & CR-012 (Module 3): request_id idempotency wiring", () => {
  it("reuses the same request_id for identical payloads and rotates on change", () => {
    let n = 0;
    const make = () => `req-${++n}`;
    const first = requestIdForAttempt(null, "sig-1", make);
    expect(first).toEqual({ signature: "sig-1", requestId: "req-1" });
    expect(requestIdForAttempt(first, "sig-1", make)).toBe(first);
    expect(requestIdForAttempt(first, "sig-2", make)).toEqual({ signature: "sig-2", requestId: "req-2" });
  });

  it("calls create_with_lines_idempotent for quotes without pre-allocating QUO numbers", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "q-id-1", error: null });
    const from = vi.fn().mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { quote_ref: "QUO-0101" }, error: null }) }) }),
    });
    const allocateQuoteRef = vi.fn();

    const result = await createQuoteWithIdempotency(
      { rpc, from } as never,
      { requestId: "req-1", header: { customer: "Acme" }, lines: [{ description: "Part" }], allocateQuoteRef },
    );

    expect(result).toEqual({ quoteId: "q-id-1", quoteRef: "QUO-0101" });
    expect(allocateQuoteRef).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("create_with_lines_idempotent", expect.objectContaining({
      p_request_id: "req-1",
      p_parent: "quotes",
      p_child: "quote_line_items",
      p_fk: "quote_id",
    }));
  });

  it("falls back to allocateQuoteRef + create_with_lines when Release 174 RPC is not yet installed", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })
      .mockResolvedValueOnce({ data: "q-id-2", error: null });
    const allocateQuoteRef = vi.fn().mockResolvedValue("QUO-0102");

    const result = await createQuoteWithIdempotency(
      { rpc, from: vi.fn() } as never,
      { requestId: "req-2", header: { customer: "Acme" }, lines: [{ description: "Part" }], allocateQuoteRef },
    );

    expect(result).toEqual({ quoteId: "q-id-2", quoteRef: "QUO-0102" });
    expect(allocateQuoteRef).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith("create_with_lines", expect.objectContaining({
      p_header: expect.objectContaining({ quote_ref: "QUO-0102" }),
    }));
  });

  it("calls create_sales_order_idempotent and falls back cleanly before Release 174", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "so-1", so_number: "SO-0050", replayed: true }, error: null });
    const allocateOrderRef = vi.fn();

    const res = await createSalesOrderWithIdempotency(
      { rpc, from: vi.fn() } as never,
      { requestId: "req-so-1", organizationId: "org-1", customerPo: "", header: { customer: "Acme" }, allocateOrderRef },
    );
    expect(res).toEqual({ soNumber: "SO-0050", customerPo: null, replayed: true });
    expect(allocateOrderRef).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("create_sales_order_idempotent", expect.objectContaining({ p_request_id: "req-so-1" }));

    const insert = vi.fn().mockResolvedValue({ error: null });
    const rpcMissing = vi.fn().mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
    const alloc = vi.fn().mockResolvedValue("SO-0051");
    const fallback = await createSalesOrderWithIdempotency(
      { rpc: rpcMissing, from: () => ({ insert }) } as never,
      { requestId: "req-so-2", organizationId: "org-1", customerPo: "", header: { customer: "Acme" }, allocateOrderRef: alloc },
    );
    expect(fallback).toEqual({ soNumber: "SO-0051", customerPo: null, replayed: false });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("wires request_id helpers into quotes and sales-orders pages", () => {
    expect(readFileSync("app/(dashboard)/quotes/page.tsx", "utf8")).toContain("createQuoteWithIdempotency(");
    expect(readFileSync("app/(dashboard)/sales-orders/page.tsx", "utf8")).toContain("createSalesOrderWithIdempotency(");
  });
});
