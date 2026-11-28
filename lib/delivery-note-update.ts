// Writes delivery-note fields and returns only acknowledged IDs. Existing database rules govern the write.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/validation/schemas";

export async function updateDeliveryNotes(
  client: Pick<SupabaseClient, "from">,
  ids: readonly string[],
  columns: Record<string, unknown>,
): Promise<string[]> {
  const { data, error } = await client.from("delivery_notes").update(columns).in("id", ids).select("id");
  if (error) throw error;

  const acknowledged = new Set(data?.map((row) => row.id));
  const updated = ids.filter((id) => acknowledged.has(id));
  if (!updated.length) {
    throw new ValidationError("No delivery notes were updated. Refresh the list and try again.");
  }
  return updated;
}
