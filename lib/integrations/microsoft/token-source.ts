import "server-only";

import { microsoftReady, microsoftTokenSource } from "@/lib/integrations/microsoft/client";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * The company's Microsoft 365 delegated access token, for the mailer (lib/email/send-company-email.ts, E8) to send as the connected
 * mailbox. Server only.
 *   - null: Microsoft 365 can't be used for this company now (the server has no service role, no encryption key or no app details;
 *     the company has no connection, or it is disconnected or needs connecting again; migration 107 isn't applied). The mailer then
 *     uses its next provider.
 *   - a string: a valid access token (renewed under 084's lease when due; never logged, never sent to the browser).
 *   - throws: Microsoft or the database did not answer (a network error, a 5xx). The send should fail and be retried, not switch provider.
 */
export async function getDelegatedAccessToken(organizationId: string): Promise<string | null> {
  const service = createSupabaseAdminClient();
  if (!service) return null;
  const { data, error } = await service.from("integration_connections").select("status").eq("organization_id", organizationId).eq("provider", "microsoft").maybeSingle();
  if (error) throw new Error(`Microsoft 365 connection could not be read (${error.code ?? "error"})`);
  if ((data as { status: string } | null)?.status !== "connected") return null;
  const ready = await microsoftReady(service);
  if (!ready) return null;
  return microsoftTokenSource(service, ready)(organizationId);
}
