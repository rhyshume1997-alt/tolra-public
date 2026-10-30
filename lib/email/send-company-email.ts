import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { mockProvider } from "@/lib/email/providers/mock";
import { GRAPH_INLINE_ATTACHMENT_LIMIT, microsoftProvider } from "@/lib/email/providers/microsoft";
import { resendProvider } from "@/lib/email/providers/resend";
import type { EmailProvider, OutgoingEmail } from "@/lib/email/providers/types";
import { getDelegatedAccessToken } from "@/lib/integrations/microsoft/token-source";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * The company mailer (E8): one call for every e-mail the app sends for a company, provider-agnostic.
 *
 * Provider, per company: its connected Microsoft 365 mailbox (a delegated token from lib/integrations/microsoft/token-source.ts) ->
 * Microsoft Graph; else Resend when RESEND_API_KEY and EMAIL_FROM are set; else nothing is sent and the e-mail is saved as a draft in
 * email_history for Approvals (mode 'drafted'). EMAIL_PROVIDER=mock (tests and local runs only) sends nothing and is refused on any
 * Vercel deployment.
 *
 * Every call writes an email_history row first ('sending', or 'drafted'), then records the outcome on it ('sent_via_system',
 * 'failed', or 'unknown' when the provider's answer can't be trusted: never retried automatically). If the row can't be written,
 * nothing is sent. Subject, addresses and file names are one line (CR/LF stripped); on a Vercel preview every recipient must be on
 * EMAIL_RECIPIENT_DOMAINS. Recipients are NOT otherwise restricted here: the caller decides who may be written to (the route only
 * allows the document's own customer or supplier, the company's own people, or the allowlist).
 */

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

/** For tests and callers that write the history through their own session (RLS) instead of the service role. */
export type CompanyEmailDeps = {
  db?: SupabaseClient | null;
  env?: Record<string, string | undefined>;
  getToken?: (organizationId: string) => Promise<string | null>;
  fetch?: typeof fetch;
  providers?: { resend?: (apiKey: string, from: string) => EmailProvider; microsoft?: (token: string) => EmailProvider; mock?: () => EmailProvider };
};

/** Who may send a company e-mail from the app (POST /api/email/send). */
export const EMAIL_SEND_ROLES = ["admin", "office"] as const;

export const MAX_RECIPIENTS = 10;
export const MAX_TEXT = 100_000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = GRAPH_INLINE_ATTACHMENT_LIMIT;
/** Sent (or being sent) by one company in the last hour: above this, refused as rate limited. */
export const HOURLY_COMPANY_LIMIT = 200;

export const UNKNOWN_OUTCOME_MESSAGE = "We couldn't confirm whether this e-mail was sent. Don't send it again yet: an administrator can check and settle it in Email history.";

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

/** One header line: CR, LF and other line breaks removed (a value can never add a header). */
export const stripHeader = (value: string) => value.replace(/[\r\n\u2028\u2029\0]+/g, " ").trim();

/** A recipient as sent: trimmed, lower case; null when it isn't one plain address (any line break or space inside refuses it). */
export function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  if (/[\s\0\u2028\u2029]/.test(address)) return null;
  return address.length <= 254 && EMAIL.test(address) ? address : null;
}

/** EMAIL_RECIPIENT_DOMAINS: comma separated; "example.com" or "@example.com" allows the domain, "a@example.com" one address. */
export function onRecipientAllowlist(address: string, list: string | undefined): boolean {
  const entries = (list || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const domain = address.split("@")[1] ?? "";
  // "@example.com" is a domain too (send-job's own copy treats it as an address: its replace(/^@/) never runs).
  return entries.some((entry) => (entry.includes("@") && !entry.startsWith("@") ? entry === address : entry.replace(/^@/, "") === domain));
}

/** email_history.related_to_type for a kind (its check allows invoice, quote, sales_order, purchase_order, delivery_note, rfq, job, general). */
export function relatedType(kind: CompanyEmailKind, recordType?: string): string {
  const allowed = ["invoice", "quote", "sales_order", "purchase_order", "delivery_note", "rfq", "job", "general"];
  if (recordType && allowed.includes(recordType)) return recordType;
  switch (kind) {
    case "quote": case "invoice": case "purchase_order": case "delivery_note": case "job": case "rfq": return kind;
    case "invoice_reminder": return "invoice";
    default: return "general";
  }
}

/** The provider for this company, or null (no provider: the e-mail becomes a draft). */
export async function selectProvider(organizationId: string, deps: CompanyEmailDeps = {}): Promise<EmailProvider | null> {
  const env = deps.env ?? process.env;
  if (env.EMAIL_PROVIDER === "mock" && !env.VERCEL_ENV) return (deps.providers?.mock ?? mockProvider)();
  let token: string | null = null;
  try {
    token = await (deps.getToken ?? getDelegatedAccessToken)(organizationId);
  } catch {
    token = null;
  }
  if (token) return deps.providers?.microsoft ? deps.providers.microsoft(token) : microsoftProvider(token, deps.fetch ?? fetch);
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM ? stripHeader(env.EMAIL_FROM) : "";
  if (apiKey && from) return (deps.providers?.resend ?? resendProvider)(apiKey, from);
  return null;
}

type Checked = { email: OutgoingEmail } | { error: string; code: "invalid" | "recipient_refused" };

/** The input made safe to send: addresses, subject, text and attachments checked; the preview allowlist applied. */
export function checkInput(input: CompanyEmailInput, env: Record<string, string | undefined>): Checked {
  if (!input.organizationId) return { error: "No company.", code: "invalid" };
  const to = (input.to ?? []).map(cleanAddress);
  const cc = (input.cc ?? []).map(cleanAddress);
  if (!to.length) return { error: "Enter an e-mail address to send to.", code: "invalid" };
  if (to.includes(null) || cc.includes(null)) return { error: "One of the e-mail addresses isn't valid.", code: "invalid" };
  const unique = (list: (string | null)[]) => [...new Set(list as string[])];
  const toList = unique(to);
  const ccList = unique(cc).filter((address) => !toList.includes(address));
  if (toList.length + ccList.length > MAX_RECIPIENTS) return { error: `Send to at most ${MAX_RECIPIENTS} addresses.`, code: "invalid" };
  // A preview deployment never writes to anyone outside the allowlist (an empty allowlist refuses everyone).
  if (env.VERCEL_ENV === "preview") {
    const outside = [...toList, ...ccList].filter((address) => !onRecipientAllowlist(address, env.EMAIL_RECIPIENT_DOMAINS));
    if (outside.length) return { error: "This test site only sends to allowlisted addresses.", code: "recipient_refused" };
  }
  const subject = stripHeader(input.subject ?? "");
  if (!subject) return { error: "Enter a subject.", code: "invalid" };
  if (subject.length > 200) return { error: "The subject can be up to 200 characters.", code: "invalid" };
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) return { error: "Enter the e-mail text.", code: "invalid" };
  if (text.length > MAX_TEXT || (input.html?.length ?? 0) > MAX_TEXT * 2) return { error: "The e-mail is too long.", code: "invalid" };
  const attachments = (input.attachments ?? []).map((a) => ({
    filename: stripHeader(String(a.filename ?? "")).replace(/[\\/"]+/g, "_").slice(0, 120),
    content: Buffer.from(a.content),
    contentType: /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType : "application/octet-stream",
  }));
  if (attachments.length > MAX_ATTACHMENTS || attachments.some((a) => !a.filename)) return { error: "Check the attachments.", code: "invalid" };
  if (attachments.reduce((sum, a) => sum + a.content.length, 0) > MAX_ATTACHMENT_BYTES) return { error: "The attachments are too large to send (3 MB at most).", code: "invalid" };
  const key = input.idempotencyKey && /^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey) ? `company-email/${input.organizationId}/${input.idempotencyKey}` : undefined;
  return { email: { to: toList, cc: ccList, subject, text, html: input.html, attachments, idempotencyKey: key } };
}

export async function sendCompanyEmail(input: CompanyEmailInput, deps: CompanyEmailDeps = {}): Promise<CompanyEmailResult> {
  const env = deps.env ?? process.env;
  const checked = checkInput(input, env);
  if ("error" in checked) return { ok: false, error: checked.error, code: checked.code };
  const { email } = checked;

  const provider = await selectProvider(input.organizationId, { ...deps, env });
  const db = deps.db === undefined ? createSupabaseAdminClient() : deps.db;
  if (!db) return { ok: false, error: "E-mail can't be recorded here, so it wasn't sent.", code: provider ? "provider_error" : "no_provider" };

  const row = {
    organization_id: input.organizationId,
    to_email: [...email.to, ...email.cc].join(", "),
    subject: email.subject,
    body: email.text,
    status: provider ? "sending" : "drafted",
    related_to_type: relatedType(input.kind, input.recordType),
    related_to_id: input.recordId ?? null,
    drafted_by: input.userId,
  };

  if (provider) {
    // A per-company ceiling on the hour (a stolen session can't use the company's mailbox as a spam cannon).
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error: countError } = await db.from("email_history").select("id", { count: "exact", head: true })
      .eq("organization_id", input.organizationId).in("status", ["sending", "sent_via_system", "unknown"]).gte("drafted_at", since);
    if (!countError && (count ?? 0) >= HOURLY_COMPANY_LIMIT) return { ok: false, error: "Too many e-mails sent in the last hour. Try again later.", code: "rate_limited" };
  }

  const { data: inserted, error: insertError } = await db.from("email_history").insert(row).select("id").single();
  const historyId = (inserted as { id?: string } | null)?.id;
  if (insertError || !historyId) {
    console.error("[company-email] history not written", insertError?.code ?? "no id");
    return provider
      ? { ok: false, error: "Couldn't record the e-mail, so it wasn't sent. Try again.", code: "provider_error" }
      : { ok: false, error: "E-mail sending isn't set up, and the draft couldn't be saved. Try again.", code: "no_provider" };
  }
  if (!provider) return { ok: true, mode: "drafted", provider: "none", historyId };

  const result = await provider.send(email);
  if (result.outcome !== "accepted") console.error("[company-email] send", provider.name, result.outcome, result.detail);
  const status = result.outcome === "accepted" ? "sent_via_system" : result.outcome === "failed" ? "failed" : "unknown";
  const { error: updateError } = await db.from("email_history")
    .update(status === "sent_via_system" ? { status, sent_at: new Date().toISOString() } : { status })
    .eq("id", historyId).eq("organization_id", input.organizationId);
  if (updateError) console.error("[company-email] outcome not recorded", updateError.code);

  if (result.outcome === "accepted") return { ok: true, mode: "sent", provider: provider.name, providerMessageId: result.providerMessageId, historyId };
  if (result.rateLimited) return { ok: false, error: "The e-mail service is busy. Wait a minute and try again.", code: "rate_limited" };
  if (result.outcome === "failed") return { ok: false, error: "The e-mail service refused this e-mail. Check the addresses and try again.", code: "provider_error" };
  return { ok: false, error: UNKNOWN_OUTCOME_MESSAGE, code: "provider_error" };
}
