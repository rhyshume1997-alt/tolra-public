import "server-only";

import { microsoftReady, microsoftTokenSource } from "@/lib/integrations/microsoft/client";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * The company's Microsoft 365 delegated access token, for the mailer (lib/email/send-company-email.ts, E8) to send as the connected
 * mailbox. Server only.
 * For provider selection (`forSending: true`):
 *   - null: this company has no Microsoft connection, or an admin explicitly disconnected it. Only then may the mailer choose Resend.
 *   - a string: a valid access token (renewed under 084's lease when due; never logged, never sent to the browser).
 *   - throws: the connection cannot be checked, needs reconnection, or its configured credentials/token cannot be used. Fail closed;
 *     a broken Microsoft connection is never permission to send from another provider.
 * The legacy inbox reader keeps its existing null-on-unavailable result when forSending is omitted.
 */
export async function getDelegatedAccessToken(organizationId: string, options: { forSending?: boolean } = {}): Promise<string | null> {
  const unavailable = (message: string): null => {
    if (options.forSending) throw new Error(message);
    return null;
  };
  const service = createSupabaseAdminClient();
  if (!service) return unavailable("Microsoft 365 connection could not be checked");
  const { data, error } = await service.from("integration_connections").select("status").eq("organization_id", organizationId).eq("provider", "microsoft").maybeSingle();
  if (error) throw new Error(`Microsoft 365 connection could not be read (${error.code ?? "error"})`);
  const status = (data as { status: string } | null)?.status;
  if (!data || status === "disconnected") return null;
  if (status !== "connected") return unavailable("Microsoft 365 needs to be connected again");
  const ready = await microsoftReady(service);
  if (!ready) return unavailable("Microsoft 365 app credentials are not available");
  const token = await microsoftTokenSource(service, ready)(organizationId);
  if (!token) return unavailable("Microsoft 365 mailbox authorisation is not available");
  return token;
}
