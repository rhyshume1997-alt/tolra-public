/**
 * Inputs: Supabase client, per-attempt requestId UUID, draft invoice or purchase-order payloads, and fallback number allocator.
 * Outputs: created (or replayed) invoice/PO identity; falls back cleanly before Release 174 is applied.
 * Boundary: Module 4 (Invoices & Purchase Orders) only; does not modify database migrations or other modules.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { missingDbObject } from "@/lib/db-features";

export type FinanceCreateAttemptKey = { signature: string; requestId: string };

/** Keeps the same request_id UUID across retries of the same draft payload; rotates when the payload changes. */
export function financeRequestIdForAttempt(
  current: FinanceCreateAttemptKey | null,
  signature: string,
  makeId: () => string = () => crypto.randomUUID(),
): FinanceCreateAttemptKey {
  if (current && current.signature === signature) return current;
  return { signature, requestId: makeId() };
}

type FinanceClient = Pick<SupabaseClient, "rpc" | "from">;

export async function createInvoiceWithIdempotency(
  client: FinanceClient,
  input: {
    requestId: string;
    header: Record<string, unknown>;
    lines: Record<string, unknown>[];
  },
): Promise<{ invoiceId: string }> {
  const { data, error } = await client.rpc("create_with_lines_idempotent", {
    p_request_id: input.requestId,
    p_parent: "invoices",
    p_header: input.header,
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: input.lines,
  });
  if (!error) return { invoiceId: String(data) };
  if (!missingDbObject(error)) throw error;

  const fallback = await client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: input.header,
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: input.lines,
  });
  if (fallback.error) throw fallback.error;
  return { invoiceId: String(fallback.data) };
}

export async function createPurchaseOrderWithIdempotency(
  client: FinanceClient,
  input: {
    requestId: string;
    organizationId: string;
    header: Record<string, unknown>;
    allocatePoRef: () => Promise<string>;
  },
): Promise<{ poRef: string; replayed: boolean }> {
  const { data, error } = await client.rpc("create_purchase_order_idempotent", {
    p_request_id: input.requestId,
    p_header: input.header,
  });
  if (!error) {
    const row = (data ?? {}) as { po_ref?: unknown; replayed?: unknown };
    return { poRef: String(row.po_ref ?? ""), replayed: row.replayed === true };
  }
  if (!missingDbObject(error)) throw error;

  const poRef = await input.allocatePoRef();
  const fallback = await client.from("purchase_orders").insert({
    ...input.header,
    organization_id: input.organizationId,
    po_ref: poRef,
    po_number: poRef,
  });
  if (fallback.error) throw fallback.error;
  return { poRef, replayed: false };
}
