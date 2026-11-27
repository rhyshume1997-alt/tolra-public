/**
 * Inputs: Supabase RPC client exposing `rpc("customer_credit")`.
 * Outputs: typed held-credit summary state (`loaded` total/customers or `unavailable`) and warning copy.
 * Boundary: Module 4 (Invoices) only; read-only, does not alter database functions or other modules.
 */

export const INVOICE_CREDIT_HELD_UNAVAILABLE =
  "Customer credit held couldn't be checked. Do not assume £0 credit; retry before chasing or refunding.";

export type InvoiceCreditRpcClient = {
  rpc: (fn: "customer_credit") => PromiseLike<{ data: unknown; error: unknown }>;
};

export type InvoiceCreditHeldState =
  | { status: "loaded"; total: number; customers: number }
  | { status: "unavailable" };

/**
 * Loads the total held customer credit summary from `customer_credit`.
 * Fails closed to `{ status: "unavailable" }` on RPC error, thrown exception, non-array payload, or non-finite credit figure
 * so a failed read is never silently shown as £0 credit held.
 */
export async function loadInvoiceCreditHeld(client: InvoiceCreditRpcClient): Promise<InvoiceCreditHeldState> {
  try {
    const { data, error } = await client.rpc("customer_credit");
    if (error || !Array.isArray(data)) return { status: "unavailable" };

    let totalPence = 0;
    for (const row of data) {
      if (!row || typeof row !== "object") return { status: "unavailable" };
      const amount = Number((row as { credit?: unknown }).credit);
      if (!Number.isFinite(amount)) return { status: "unavailable" };
      totalPence += Math.round(amount * 100);
    }
    return { status: "loaded", total: totalPence / 100, customers: data.length };
  } catch {
    return { status: "unavailable" };
  }
}
