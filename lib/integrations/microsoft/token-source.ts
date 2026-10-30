import "server-only";

/**
 * The one thing the company mailer (lib/email/send-company-email.ts) needs from the Microsoft 365 connection: a delegated Graph access
 * token for the company's connected mailbox (scope Mail.Send), refreshed when needed, or null when the company has no working
 * Microsoft connection. null means "use the next provider" (Resend, else a draft for Approvals).
 *
 * STUB until the Microsoft connect unit (E7, lib/integrations/microsoft/client.ts and migration 107) lands: no company can have a
 * Microsoft connection before 107 (the provider check on integration_connections doesn't allow 'microsoft' yet), so this always
 * answers null. E7 replaces the body with a call into its client; the signature stays.
 */
export async function getDelegatedAccessToken(organizationId: string): Promise<string | null> {
  void organizationId;
  return null;
}
