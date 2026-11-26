// Prepares receipt targets and returns acknowledged writes. Existing issue and edit rules stay with their own actions.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/validation/schemas";

export const CANCELLED_RECEIPT_MESSAGE = "Cancelled purchase orders cannot be marked received.";

export function planPurchaseOrderReceipt<T extends { id: string; status: string }>(orders: readonly T[], ids: readonly string[]) {
  const selected = new Set(ids);
  const targets: T[] = [];
  const cancelled: string[] = [];
  for (const order of orders) {
    if (!selected.has(order.id)) continue;
    if (order.status === "cancelled") cancelled.push(order.id);
    else if (order.status !== "draft" && order.status !== "received") targets.push(order);
  }
  return { targets, cancelled };
}

export async function receivePurchaseOrders(
  client: Pick<SupabaseClient, "from">,
  ids: readonly string[],
  receivedAt: string,
): Promise<string[]> {
  const { data, error } = await client.from("purchase_orders")
    .update({ status: "received", received_at: receivedAt })
    .in("id", ids)
    .select("id");
  if (error?.hint === "purchase_order_cancelled_terminal") {
    throw new ValidationError(CANCELLED_RECEIPT_MESSAGE);
  }
  if (error) throw error;
  const confirmed = new Set(data?.map((row) => row.id));
  return ids.filter((id) => confirmed.has(id));
}
