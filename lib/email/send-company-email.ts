import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PLACEHOLDERS } from "@/lib/email/templates/defaults";

import { mockProvider } from "@/lib/email/providers/mock";
import { microsoftProvider } from "@/lib/email/providers/microsoft";
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
 * Every call is reserved first in 106's send ledger (reserve_company_email), keyed by a digest of (company, kind, document, the
 * caller's idempotencyKey): that writes the email_history row ('sending', or 'drafted') and a retry with the same key gets the earlier
 * answer instead of a second row or a second send, whatever the provider. Then the outcome is recorded (complete_company_email:
 * 'sent_via_system', 'failed' (may be tried again with the same key), or 'unknown' when the provider's answer can't be trusted: never
 * retried). If nothing can be reserved, nothing is sent. Without an idempotencyKey every call is a new e-mail. Before 106 is applied
 * the history row is written directly (no retry guard but Resend's own idempotency header). Subject, addresses and file names are one line (CR/LF stripped); on a Vercel preview every recipient must be on
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
/** All attachments together (Microsoft 365 takes at most 3 MB: lib/email/providers/microsoft.ts refuses more). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** The caller's idempotency key: letters, digits and : . _ - (e.g. "invoice-reminder:<invoice id>:2026-W45"). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{8,200}$/;
export const MOCK_REFUSED_MESSAGE = "EMAIL_PROVIDER=mock is for tests only and is refused on a deployment. Remove it to send.";
/** Sent (or being sent) by one company in the last hour: above this, refused as rate limited. */
export const HOURLY_COMPANY_LIMIT = 200; // enforced by reserve_company_email (106)

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

/** The provider for this company, null (no provider: the e-mail becomes a draft), or "refused" (EMAIL_PROVIDER=mock on a deployment). */
export async function selectProvider(organizationId: string, deps: CompanyEmailDeps = {}): Promise<EmailProvider | null | "refused"> {
  const env = deps.env ?? process.env;
  if (env.EMAIL_PROVIDER === "mock") return env.VERCEL_ENV ? "refused" : (deps.providers?.mock ?? mockProvider)();
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
  // A placeholder the template should have filled (e.g. {{greeting}}) never reaches a customer.
  const unfilled = unfilledPlaceholders(`${subject}\n${text}\n${input.html ?? ""}`);
  if (unfilled.length) return { error: `The e-mail still has ${unfilled.map((name) => `{{${name}}}`).join(", ")} in it. Replace it with the real text.`, code: "invalid" };
  const attachments = (input.attachments ?? []).map((a) => ({
    filename: stripHeader(String(a.filename ?? "")).replace(/[\\/"]+/g, "_").slice(0, 120),
    content: Buffer.from(a.content),
    contentType: /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType : "application/octet-stream",
  }));
  if (attachments.length > MAX_ATTACHMENTS || attachments.some((a) => !a.filename)) return { error: "Check the attachments.", code: "invalid" };
  if (attachments.reduce((sum, a) => sum + a.content.length, 0) > MAX_ATTACHMENT_BYTES) return { error: "The attachments are too large to send (5 MB at most).", code: "invalid" };
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) return { error: "Invalid idempotency key.", code: "invalid" };
  return { email: { to: toList, cc: ccList, subject, text, html: input.html, attachments } };
}

/** Known placeholder names still written as {{name}} in the text (unknown names are the person's own text and pass). */
export function unfilledPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) if ((PLACEHOLDERS as readonly string[]).includes(match[1])) found.add(match[1]);
  return [...found];
}

/** The ledger key: a digest of the company, kind, document and the caller's key (a fresh one when the caller gave none). */
export function ledgerKey(input: CompanyEmailInput): string {
  const parts = [input.organizationId, input.kind, relatedType(input.kind, input.recordType), input.recordId ?? "", input.idempotencyKey ?? `once:${randomUUID()}`];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

type Reservation = { send_id: string; history_id: string; status: "drafted" | "sending" | "accepted" | "failed" | "unknown"; replay: boolean };
const isMissingFunction = (error: { code?: string } | null) => error?.code === "PGRST202" || error?.code === "42883";

/** The earlier answer for a key seen before (never a second send). */
function replayResult(r: Reservation, providerName: "resend" | "microsoft" | "mock" | "none"): CompanyEmailResult {
  if (r.status === "accepted") return { ok: true, mode: "sent", provider: providerName, historyId: r.history_id };
  if (r.status === "drafted") return { ok: true, mode: "drafted", provider: "none", historyId: r.history_id };
  if (r.status === "sending") return { ok: false, error: "This e-mail is already being sent.", code: "provider_error" };
  return { ok: false, error: UNKNOWN_OUTCOME_MESSAGE, code: "provider_error" };
}

export async function sendCompanyEmail(input: CompanyEmailInput, deps: CompanyEmailDeps = {}): Promise<CompanyEmailResult> {
  const env = deps.env ?? process.env;
  const checked = checkInput(input, env);
  if ("error" in checked) return { ok: false, error: checked.error, code: checked.code };
  const key = ledgerKey(input);
  const email: OutgoingEmail = { ...checked.email, idempotencyKey: `company-email/${key}` };

  const selected = await selectProvider(input.organizationId, { ...deps, env });
  if (selected === "refused") return { ok: false, error: MOCK_REFUSED_MESSAGE, code: "no_provider" };
  const provider = selected;
  const db = deps.db === undefined ? createSupabaseAdminClient() : deps.db;
  if (!db) return { ok: false, error: "E-mail can't be recorded here, so it wasn't sent.", code: provider ? "provider_error" : "no_provider" };

  const to = [...email.to, ...email.cc].join(", ");
  const related = relatedType(input.kind, input.recordType);
  const { data: reserved, error: reserveError } = await db.rpc("reserve_company_email", {
    p_org: input.organizationId, p_user: input.userId, p_key: key, p_to: to, p_subject: email.subject, p_body: email.text,
    p_related_type: related, p_related_id: input.recordId ?? null, p_mode: provider ? "sending" : "drafted",
  });
  if (reserveError && isMissingFunction(reserveError)) return sendWithoutLedger(input, email, provider, db, to, related);
  if (reserveError) {
    if (reserveError.code === "PT429") return { ok: false, error: "Too many e-mails sent in the last hour. Try again later.", code: "rate_limited" };
    console.error("[company-email] not reserved", reserveError.code);
    if (reserveError.code === "42501") return { ok: false, error: "You can't send e-mail for this company.", code: "invalid" };
    return provider
      ? { ok: false, error: "Couldn't record the e-mail, so it wasn't sent. Try again.", code: "provider_error" }
      : { ok: false, error: "E-mail sending isn't set up, and the draft couldn't be saved. Try again.", code: "no_provider" };
  }
  const reservation = reserved as Reservation;
  if (reservation.replay) return replayResult(reservation, provider?.name ?? "none");
  if (!provider) return { ok: true, mode: "drafted", provider: "none", historyId: reservation.history_id };

  const result = await provider.send(email);
  if (result.outcome !== "accepted") console.error("[company-email] send", provider.name, result.outcome, result.detail);
  const { error: completeError } = await db.rpc("complete_company_email", { p_org: input.organizationId, p_user: input.userId, p_send: reservation.send_id, p_outcome: result.outcome });
  // If this write is lost the ledger stays 'sending' and becomes 'unknown' after ten minutes: never a silent second send.
  if (completeError) console.error("[company-email] outcome not recorded", completeError.code);
  return outcomeResult(result, provider.name, reservation.history_id);
}

function outcomeResult(result: { outcome: string; rateLimited?: boolean; providerMessageId?: string; detail: string }, name: "resend" | "microsoft" | "mock", historyId: string): CompanyEmailResult {
  if (result.outcome === "accepted") return { ok: true, mode: "sent", provider: name, providerMessageId: result.providerMessageId, historyId };
  if (result.rateLimited) return { ok: false, error: "The e-mail service is busy. Wait a minute and try again.", code: "rate_limited" };
  if (result.detail === "attachment_too_large") return { ok: false, error: "The PDF is too large for your Microsoft 365 mailbox (3 MB at most). Use Open in my mail app instead.", code: "invalid" };
  if (result.outcome === "failed") return { ok: false, error: "The e-mail service refused this e-mail. Check the addresses and try again.", code: "provider_error" };
  return { ok: false, error: UNKNOWN_OUTCOME_MESSAGE, code: "provider_error" };
}

/** Before 106 is applied: the history row written directly, the outcome recorded on it (no ledger, so no retry guard but Resend's). */
async function sendWithoutLedger(input: CompanyEmailInput, email: OutgoingEmail, provider: EmailProvider | null, db: SupabaseClient, to: string, related: string): Promise<CompanyEmailResult> {
  const row = { organization_id: input.organizationId, to_email: to, subject: email.subject, body: email.text, status: provider ? "sending" : "drafted", related_to_type: related, related_to_id: input.recordId ?? null, drafted_by: input.userId };
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
  return outcomeResult(result, provider.name, historyId);
}
