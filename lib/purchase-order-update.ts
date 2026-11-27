// Updates requested purchase-order IDs and returns only IDs acknowledged by the database.
// The caller's existing permissions and database transition rules govern every update.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/validation/schemas";

export async function updatePurchaseOrders(
  client: Pick<SupabaseClient, "from">,
  ids: readonly string[],
  columns: Record<string, unknown>,
): Promise<string[]> {
  const { data, error } = await client.from("purchase_orders").update(columns).in("id", ids).select("id");
  if (error) throw error;

  const acknowledged = new Set(data?.map((row) => row.id));
  const updatedIds = ids.filter((id) => acknowledged.has(id));
  if (!updatedIds.length) {
    throw new ValidationError("No purchase orders were updated. Refresh the list and try again.");
  }
  return updatedIds;
}
