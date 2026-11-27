/**
 * Inputs: Supabase client, per-attempt requestId UUID, quote/sales-order payloads, and fallback number allocators.
 * Outputs: created (or replayed) quote/sales-order identity; falls back cleanly before Release 174 is applied.
 * Boundary: Module 3 (Quotes & Sales Orders) only; does not modify database migrations or other modules.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { manualOrderIdentity } from "@/lib/accept-quote";
import { missingDbObject } from "@/lib/db-features";

export type CreateAttemptKey = { signature: string; requestId: string };

/** Keeps the same request_id UUID across retries of the same draft payload; mints a new UUID when the payload changes. */
export function requestIdForAttempt(
  current: CreateAttemptKey | null,
  signature: string,
  makeId: () => string = () => crypto.randomUUID(),
): CreateAttemptKey {
  if (current && current.signature === signature) return current;
  return { signature, requestId: makeId() };
}

type QuoteClient = Pick<SupabaseClient, "rpc" | "from">;

export async function createQuoteWithIdempotency(
  client: QuoteClient,
  input: {
    requestId: string;
    header: Record<string, unknown>;
    lines: Record<string, unknown>[];
    allocateQuoteRef: () => Promise<string>;
  },
): Promise<{ quoteId: string | null; quoteRef: string }> {
  const { data, error } = await client.rpc("create_with_lines_idempotent", {
    p_request_id: input.requestId,
    p_parent: "quotes",
    p_header: input.header,
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: input.lines,
  });

  if (!error) {
    const quoteId = data ? String(data) : null;
    let quoteRef = "";
    if (quoteId) {
      try {
        const read = await client.from("quotes").select("quote_ref").eq("id", quoteId).maybeSingle();
        quoteRef = String((read.data as { quote_ref?: unknown } | null)?.quote_ref ?? "");
      } catch {
        quoteRef = "";
      }
    }
    return { quoteId, quoteRef };
  }

  if (!missingDbObject(error)) throw error;

  const quoteRef = await input.allocateQuoteRef();
  const fallback = await client.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { ...input.header, quote_ref: quoteRef },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: input.lines,
  });
  if (fallback.error) throw fallback.error;
  return { quoteId: fallback.data ? String(fallback.data) : null, quoteRef };
}

export async function createSalesOrderWithIdempotency(
  client: QuoteClient,
  input: {
    requestId: string;
    organizationId: string;
    customerPo: string;
    header: Record<string, unknown>;
    allocateOrderRef: () => Promise<string>;
  },
): Promise<{ soNumber: string; customerPo: string | null; replayed: boolean }> {
  const trimmedPo = input.customerPo.trim() || null;
  const { data, error } = await client.rpc("create_sales_order_idempotent", {
    p_request_id: input.requestId,
    p_header: {
      ...input.header,
      customer_po: trimmedPo,
      ...(trimmedPo ? { so_number: trimmedPo } : {}),
    },
  });

  if (!error) {
    const row = (data ?? {}) as { so_number?: unknown; replayed?: unknown };
    return {
      soNumber: String(row.so_number ?? trimmedPo ?? ""),
      customerPo: trimmedPo,
      replayed: row.replayed === true,
    };
  }

  if (!missingDbObject(error)) throw error;

  const identity = await manualOrderIdentity(input.customerPo, input.allocateOrderRef);
  const fallback = await client.from("sales_orders").insert({
    ...input.header,
    organization_id: input.organizationId,
    so_number: identity.soNumber,
    customer_po: identity.customerPo,
  });
  if (fallback.error) throw fallback.error;
  return { soNumber: identity.soNumber, customerPo: identity.customerPo, replayed: false };
}
