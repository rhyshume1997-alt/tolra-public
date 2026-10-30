// stub: replaced by EA at merge. This file is E8's (the company mailer). It exists in this branch only so the e-mail schedules compile and
// their tests can mock it; the exported names and shapes are copied from the E-items contract. Until EA's version lands it sends nothing
// and says so (no_provider), so a schedule can never report an e-mail that was not made.
import "server-only";

export type CompanyEmailKind = "quote" | "invoice" | "purchase_order" | "delivery_note" | "invoice_reminder" | "timesheet" | "job" | "rfq" | "alert" | "test";
export interface CompanyEmailInput {
  organizationId: string;
  userId: string | null;
  kind: CompanyEmailKind;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  recordType?: string;
  recordId?: string;
  attachments?: { filename: string; content: Buffer | Uint8Array; contentType: string }[];
  idempotencyKey?: string;
}
export type CompanyEmailResult =
  | { ok: true; mode: "sent" | "drafted"; provider: "resend" | "microsoft" | "mock" | "none"; providerMessageId?: string; historyId?: string }
  | { ok: false; error: string; code: "no_provider" | "recipient_refused" | "provider_error" | "rate_limited" | "invalid" };

export async function sendCompanyEmail(input: CompanyEmailInput): Promise<CompanyEmailResult> {
  void input;
  return { ok: false, error: "The company mailer is not installed in this branch yet.", code: "no_provider" };
}
