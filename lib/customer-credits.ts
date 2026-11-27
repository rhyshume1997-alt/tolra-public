/**
 * Inputs: Supabase RPC client exposing `rpc("customer_credit")`.
 * Outputs: typed customer credit lookup state (`loaded` map or `unavailable`) and warning copy.
 * Boundary: Module 5 (Customers) only; read-only, does not alter database functions or other modules.
 */

export const CUSTOMER_CREDITS_UNAVAILABLE =
  "Customer credit balances couldn't be loaded. Do not assume customers hold £0 credit; retry before chasing or refunding.";

export type CustomerCreditRpcClient = {
  rpc: (fn: "customer_credit") => PromiseLike<{ data: unknown; error: unknown }>;
};

export type CustomerCreditsState =
  | { status: "loaded"; credits: Map<string, number> }
  | { status: "unavailable" };

/**
 * Loads per-customer credit balances from `customer_credit`.
 * Fails closed to `{ status: "unavailable" }` on RPC error, thrown exception, non-array payload, or non-finite credit figure
 * so a failed read is never displayed as £0 credit.
 */
export async function loadCustomerCredits(client: CustomerCreditRpcClient): Promise<CustomerCreditsState> {
  try {
    const { data, error } = await client.rpc("customer_credit");
    if (error || !Array.isArray(data)) return { status: "unavailable" };

    const credits = new Map<string, number>();
    for (const row of data) {
      if (!row || typeof row !== "object") return { status: "unavailable" };
      const record = row as { customer?: unknown; credit?: unknown };
      if (typeof record.customer !== "string") return { status: "unavailable" };
      const amount = Number(record.credit);
      if (!Number.isFinite(amount)) return { status: "unavailable" };
      credits.set(record.customer, amount);
    }
    return { status: "loaded", credits };
  } catch {
    return { status: "unavailable" };
  }
}
