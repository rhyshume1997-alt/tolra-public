// Records an invoice send timestamp and requires acknowledgement of that invoice.
// Existing invoice permissions and lifecycle rules govern the update.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/validation/schemas";

export async function recordInvoiceSent(client: Pick<SupabaseClient, "from">, id: string, sentAt: string): Promise<void> {
  const { data, error } = await client.from("invoices").update({ sent_date: sentAt }).eq("id", id).select("id");
  if (error) throw error;
  if (!data?.some((row) => row.id === id)) {
    throw new ValidationError("The invoice's sent date could not be confirmed. Refresh the invoice and check whether the email was sent before sending it again.");
  }
}
