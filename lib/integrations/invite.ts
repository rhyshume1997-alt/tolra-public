import "server-only";

import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { inviteRedirectUri } from "@/lib/integrations/app-credentials";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { type ConnectOutcome, DbError, completeConnect, serviceDb } from "@/lib/integrations/server";
import { type XeroConfig, authorizeUrl, hashState, newAuthorisation } from "@/lib/integrations/xero/oauth";
import { LimiterUnavailableError, clientIp, withinLimit } from "@/lib/server/login";

// The accountant's connect link (E2; migration 107, hardened by proposal 151). An admin (two-step, own company, never support) names the
// accountant's e-mail address; the link e-mailed there carries only an OPAQUE REFERENCE (22 random characters) that grants nothing on its
// own. Opening it (a GET) shows "Connect <company> to Xero" and the masked address; nothing is used up. "E-mail me a code" sends a one-time
// 8-digit code to the BOUND address only (the visitor never names one); the code, typed back, is what uses the invite up (integration_invite_code_verify:
// unused, not cancelled, unexpired, five wrong codes lock it, the admin who made it still an admin) and sends the browser to Xero with state +
// PKCE as always. Xero sends them back to /api/integrations/invite/callback, which completes the connection for THAT company only, as the admin
// who made the invite (084's integration_store_connection checks that person is still an active admin). The link grants nothing else: no Tolra
// session, no page, no data. A connection made this way is like any other: 149 puts transfers OFF and held documents stay held.

/**
 * 107's one-use TOKEN helpers (32 random bytes, base64url: 43 characters, kept as a SHA-256). The Xero connect link no longer uses them (it is an opaque
 * reference plus an e-mailed code); the accountant's Tolra invite (129: a viewer login for the invite's own address, a different feature) still does.
 */
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
export function newInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

/** The opaque reference in the link: 16 random bytes, base64url: 22 characters. It is not a secret that grants anything; the e-mailed code is. */
export const INVITE_REF = /^[A-Za-z0-9_-]{22}$/;
export const INVITE_HOURS = 24;
export const INVITE_CODE = /^[0-9]{8}$/;

export function newInviteRef(): string {
  return randomBytes(16).toString("base64url");
}

/** An 8-digit one-time code (uniform: randomInt). */
export function newInviteCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

/** What a person typed, made one code: spaces and hyphens removed ("1234 5678"); null unless exactly 8 digits. */
export function cleanInviteCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = input.replace(/[\s-]/g, "");
  return INVITE_CODE.test(code) ? code : null;
}

/** The code's keyed hash: HMAC-SHA256 with a key derived from the server's encryption key, over the reference and the code. Only this is stored. */
export function inviteCodeHash(key: Buffer, ref: string, code: string): string {
  const subKey = createHmac("sha256", key).update("tolra:xero-invite-code:v1", "utf8").digest();
  return createHmac("sha256", subKey).update(`${ref}:${code}`, "utf8").digest("hex");
}

/**
 * The exact HTTPS redirect-URI allow list: XERO_INVITE_REDIRECT_URIS, comma separated. An entry counts only if it is https, has no wildcard, no
 * user info, no query, no fragment, and is already in its normal written form (so it can be compared as plain text). The invite's redirect URI
 * must EQUAL one entry, character for character: no prefix, no suffix, no case folding, no wildcard. An unset or empty list allows nothing.
 */
export function inviteRedirectAllowList(env: Record<string, string | undefined> = process.env): string[] {
  return (env.XERO_INVITE_REDIRECT_URIS ?? "").split(",").map((e) => e.trim()).filter((e) => {
    if (!e || e.includes("*")) return false;
    try {
      const u = new URL(e);
      return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.href === e;
    } catch {
      return false;
    }
  });
}

export function inviteRedirectAllowed(redirectUri: string, env: Record<string, string | undefined> = process.env): boolean {
  return inviteRedirectAllowList(env).includes(redirectUri);
}

/** The redirect URI the accountant's Connect would use, or null when it is not on the exact allow list (then nothing is started). */
export function allowedInviteRedirect(config: XeroConfig, env: Record<string, string | undefined> = process.env): string | null {
  const uri = inviteRedirectUri(config.redirectUri);
  return inviteRedirectAllowed(uri, env) ? uri : null;
}

/**
 * The PKCE verifier of an invite's Connect is encrypted before the company is known (the invite is used up and the state kept in one
 * statement), so it is bound to its own state instead: a ciphertext copied to another state row does not decrypt.
 */
export const inviteVerifierContext = (stateHash: string) => ({ organizationId: `invite-state:${stateHash}`, provider: "xero", purpose: "pkce" as const });

/** The Xero configuration for the accountant's Connect: the same app, the invite callback as redirect URI. */
export function inviteConfig(config: XeroConfig): XeroConfig {
  return { ...config, redirectUri: inviteRedirectUri(config.redirectUri) };
}

/** The link's page: the company's name and the masked recipient for an open invite, or null (malformed, unknown, used, cancelled, locked, expired). Nothing is used up. */
export async function peekInvite(service: SupabaseClient, ref: string): Promise<{ companyName: string; recipientHint: string } | null> {
  if (!INVITE_REF.test(ref)) return null;
  const out = await serviceDb(service).rpc<{ company_name?: unknown; recipient_hint?: unknown } | null>("integration_invite_peek", { p_ref: ref });
  return out && typeof out.company_name === "string" ? { companyName: out.company_name, recipientHint: typeof out.recipient_hint === "string" ? out.recipient_hint : "" } : null;
}

/** The public link routes' limit: 20 in 15 minutes per IP (the page, its buttons and Xero's return), as auth/reset does. */
export const INVITE_RATE = { bucket: "integration_invite", windowSeconds: 15 * 60, max: 20 } as const;

/** true when this IP may go on; false when over the limit OR the limiter can't be used (fails closed: the page says try again). */
export async function inviteRateOk(service: SupabaseClient, request: Request): Promise<boolean> {
  try {
    return await withinLimit(service, INVITE_RATE.bucket, clientIp(request), INVITE_RATE.windowSeconds, INVITE_RATE.max);
  } catch (err) {
    if (err instanceof LimiterUnavailableError) return false;
    throw err;
  }
}

/** A hash of a reference for the server's own log lines: 16 hex characters, never the reference. */
export const refHash = (ref: string) => createHash("sha256").update(ref.slice(0, 200), "utf8").digest("hex").slice(0, 16);

export type RefusalStep = "page" | "code" | "verify" | "callback" | "request";
export type RefusalReason = "invalid_request" | "not_open" | "unknown_ref" | "malformed_ref" | "rate_limited" | "callback_state" | "callback_error" | "redirect_not_allowed" | "mail_failed" | "bad_origin" | "wrong_code";

/**
 * A refusal the app itself meets (a malformed or unknown reference, a page for an invite that isn't open, a rate limit, a callback with an unknown
 * state or a failed hand-back) goes to the SECURITY LOG (integration_invite_refusal_log, never a company's audit) under a fresh random correlation id,
 * which is also written to the server log and shown on the page. Only the id, the step, the reason and a hash of the reference are ever written.
 * Best effort: if the database can't be written, the server log still has the id. Returns the id.
 */
export async function logInviteRefusal(service: SupabaseClient | null, step: RefusalStep, reason: RefusalReason, ref?: string): Promise<string> {
  const id = randomUUID();
  console.warn("[integrations] invite refused:", id, step, reason, ref ? refHash(ref) : "-");
  if (service) {
    await Promise.resolve(service.rpc("integration_invite_refusal_log", { p_step: step, p_reason: reason, p_ref: ref ? ref.slice(0, 200) : null, p_correlation: id }))
      .catch(() => undefined);
  }
  return id;
}

export type CodeIssue =
  | { ok: true; code: string; recipient: string; companyName: string; organizationId: string; sentNumber: number }
  | { ok: false; reason: "invalid" | "too_many_codes" | "wait"; correlationId?: string };

/** "E-mail me a code": the database keeps the code's hash and answers with the BOUND address; the caller e-mails the code there and never logs it. */
export async function issueInviteCode(service: SupabaseClient, ref: string, key: Buffer): Promise<CodeIssue> {
  if (!INVITE_REF.test(ref)) return { ok: false, reason: "invalid", correlationId: await logInviteRefusal(service, "code", "malformed_ref", ref) };
  const code = newInviteCode();
  const out = await serviceDb(service).rpc<{ ok?: boolean; reason?: string; recipient?: string; company_name?: string; organization_id?: string; sent_number?: number; correlation_id?: string } | null>(
    "integration_invite_code_issue", { p_ref: ref, p_code_hash: inviteCodeHash(key, ref, code) });
  if (out?.ok === true && typeof out.recipient === "string" && typeof out.company_name === "string" && typeof out.organization_id === "string") {
    return { ok: true, code, recipient: out.recipient, companyName: out.company_name, organizationId: out.organization_id, sentNumber: Number(out.sent_number) || 1 };
  }
  return { ok: false, reason: out?.reason === "too_many_codes" || out?.reason === "wait" ? out.reason : "invalid", correlationId: safeId(out?.correlation_id) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A correlation id from the database, only if it really is one (it is printed on a page). */
const safeId = (v: unknown): string | undefined => (typeof v === "string" && UUID_RE.test(v) ? v : undefined);

export type RedeemOutcome =
  | { ok: true; url: string }
  | { ok: false; reason: "invalid" | "code_expired" | "wrong_code" | "locked" | "redirect_not_allowed"; attemptsLeft?: number; correlationId?: string };

/**
 * The code is typed: checked and the invite used up (once) in one database call, and Xero's sign-in URL returned (state + PKCE as an admin's
 * own Connect). The redirect URI must be on the exact allow list BEFORE anything is used up.
 */
export async function redeemInvite(service: SupabaseClient, ref: string, code: string, ready: { config: XeroConfig; key: Buffer }, env: Record<string, string | undefined> = process.env): Promise<RedeemOutcome> {
  if (!INVITE_REF.test(ref) || !INVITE_CODE.test(code)) return { ok: false, reason: "invalid", correlationId: await logInviteRefusal(service, "verify", INVITE_REF.test(ref) ? "wrong_code" : "malformed_ref", ref) };
  const redirect = allowedInviteRedirect(ready.config, env);
  if (!redirect) return { ok: false, reason: "redirect_not_allowed", correlationId: await logInviteRefusal(service, "verify", "redirect_not_allowed", ref) };
  const auth = newAuthorisation();
  let out: { ok?: boolean; reason?: string; attempts_left?: number; correlation_id?: string } | null;
  try {
    out = await serviceDb(service).rpc("integration_invite_code_verify", {
      p_ref: ref, p_code_hash: inviteCodeHash(ready.key, ref, code), p_state_hash: auth.stateHash,
      p_verifier_enc: encryptSecret(auth.verifier, inviteVerifierContext(auth.stateHash), ready.key),
    });
  } catch (err) {
    if (err instanceof DbError && (err.hint === "invite_invalid" || err.code === "42501")) return { ok: false, reason: "invalid", correlationId: await logInviteRefusal(service, "verify", "unknown_ref", ref) };
    throw err;
  }
  if (out?.ok === true) return { ok: true, url: authorizeUrl({ ...ready.config, redirectUri: redirect }, auth.state, auth.challenge) };
  const reason = out?.reason;
  const correlationId = safeId(out?.correlation_id);
  if (reason === "code_expired" || reason === "locked") return { ok: false, reason, correlationId };
  if (reason === "wrong_code") return { ok: false, reason, attemptsLeft: typeof out?.attempts_left === "number" ? out.attempts_left : undefined, correlationId };
  return { ok: false, reason: "invalid", correlationId };
}

/** Xero sent the accountant back: the invite's state (only an invite's) is used up and the connection completed for its company. */
export async function finishInviteConnect(service: SupabaseClient, state: string, code: string, ready: { config: XeroConfig; key: Buffer },
                                          deps: { fetchImpl?: typeof fetch; now?: () => number; env?: Record<string, string | undefined> } = {}): Promise<ConnectOutcome & { correlationId?: string }> {
  // The redirect URI sent to Xero's token endpoint is the one on the allow list; anything else is refused before the state is used up.
  const redirect = allowedInviteRedirect(ready.config, deps.env ?? process.env);
  if (!redirect) return { ok: false, reason: "not_configured", correlationId: await logInviteRefusal(service, "callback", "redirect_not_allowed") };
  const stateHash = hashState(state);
  const consumed = await serviceDb(service).rpc<{ ok?: boolean; reason?: string; correlation_id?: string; organization_id: string; user_id: string; verifier_enc: string } | null>("integration_oauth_consume_invite", { p_provider: "xero", p_state_hash: stateHash });
  if (!consumed) return { ok: false, reason: "expired", correlationId: await logInviteRefusal(service, "callback", "callback_state") };
  // The database re-checked the INVITE at this moment (not expired, not cancelled, its admin still an admin): nothing is exchanged or stored otherwise.
  if (consumed.ok === false || typeof consumed.organization_id !== "string") return { ok: false, reason: "expired", correlationId: safeId(consumed.correlation_id) };
  const verifier = decryptSecret(consumed.verifier_enc, inviteVerifierContext(stateHash), ready.key);
  return completeConnect(service, consumed.organization_id, consumed.user_id, verifier, code, { config: { ...ready.config, redirectUri: redirect }, key: ready.key }, { ...deps, inviteStateHash: stateHash });
}

const PAGE: Record<string, { title: string; body: string }> = {
  connected: { title: "All connected", body: "Xero is now connected to Tolra for this company. You can close this page." },
  invalid: { title: "This link can't be used", body: "It has expired (links last 24 hours), was already used, or was copied wrongly. Ask for a new link." },
  expired: { title: "That took too long", body: "The Xero sign-in took more than 10 minutes, or was started elsewhere. Ask for a new link." },
  cancelled: { title: "Nothing was connected", body: "The Xero sign-in was cancelled. Ask for a new link to try again." },
  choose_one: { title: "Choose one organisation", body: "More than one Xero organisation was ticked. Ask for a new link and tick one only." },
  no_organisation: { title: "No organisation chosen", body: "No Xero organisation was chosen. Ask for a new link and choose one." },
  tenant_in_use: { title: "Already connected elsewhere", body: "That Xero organisation is already connected to another company in Tolra." },
  disconnect_first: { title: "Another organisation is connected", body: "This company is connected to another Xero organisation. Its admin must disconnect it first." },
  not_configured: { title: "Not set up yet", body: "Tolra's Xero connection is switched on at go-live. Nothing was used up: try the same link later." },
  busy: { title: "Try again shortly", body: "Too many attempts from here, or Tolra can't check right now. Wait a few minutes and open the link again; if it was already used, ask for a new one." },
  failed: { title: "That didn't work", body: "Connecting to Xero didn't work and nothing changed. Ask for a new link." },
  locked: { title: "This link is locked", body: "Too many wrong codes were typed, so the link was cancelled. Ask for a new link." },
  mail_failed: { title: "The code couldn't be sent", body: "Tolra couldn't e-mail the code just now. Nothing was used up. Try again later, or ask for a new link." },
};

/** "Reference: <id>" for a refused request: the random correlation id only, so it can be quoted and traced in the security log. */
export const referenceLine = (id?: string) => (id && UUID_RE.test(id) ? `<p style="font-size:13px">Reference: <code>${id}</code></p>` : "");

export const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The fixed, self-contained page the public link routes answer with (no app shell; the accountant invite (129) uses it too). */
export function page(title: string, inner: string, status: number, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">`
    + `<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:48px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 12px}p{color:#475569;line-height:1.5}button{font:inherit;font-weight:600;background:#13b5ea;color:#fff;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}</style></head>`
    + `<body><main>${inner}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' https://login.xero.com", ...extra },
  });
}

/** A fixed page for the accountant (no Tolra session, so no app page): fixed text by outcome only, nothing from the request. */
export function invitePage(outcome: string, status = 200, correlationId?: string): Response {
  const p = PAGE[outcome] ?? PAGE.failed;
  return page(p.title, `<h1>${p.title}</h1><p>${p.body}</p>${referenceLine(correlationId)}`, status);
}

/** What the confirm page can say above its forms: fixed texts only (never anything typed or received). */
export type InviteNotice = "code_sent" | "wrong_code" | "code_expired" | "wait" | "too_many_codes" | "enter_code";
const NOTICE: Record<InviteNotice, string> = {
  code_sent: "We've e-mailed a code to that address. It works for 15 minutes.",
  wrong_code: "That code isn't right. Check the e-mail and try again.",
  code_expired: "That code has run out, or none was sent yet. Ask for a new code.",
  wait: "A code was sent a moment ago. Wait a minute before asking for another.",
  too_many_codes: "Too many codes were sent for this link. Ask for a new link.",
  enter_code: "Enter the 8-digit code from the e-mail.",
};

/**
 * The link's page for an open link: "Connect <company> to Xero", the masked address the code goes to, and two forms (same origin): e-mail me a code,
 * and type the code. Only the code form uses the link up. The company's name and the masked address are the only data on it (HTML-escaped).
 */
export function inviteConfirmPage(companyName: string, recipientHint: string, notice?: InviteNotice, status = 200, correlationId?: string): Response {
  const name = escapeHtml(companyName);
  const hint = escapeHtml(recipientHint);
  return page(`Connect ${name} to Xero`,
    `<h1>Connect ${name} to Xero</h1><p>You were sent this link to connect ${name}'s Tolra to its Xero organisation.</p>`
    + `<p>To make sure it is you, we send a one-time code to ${hint}. Only whoever can read that mailbox can continue.</p>`
    + (notice ? `<p role="status"><strong>${NOTICE[notice]}</strong></p>${referenceLine(correlationId)}` : "")
    + `<form method="post"><input type="hidden" name="action" value="send"><button type="submit">E-mail me a code</button></form>`
    + `<form method="post" autocomplete="off"><input type="hidden" name="action" value="verify">`
    + `<p><label>Code from the e-mail<br><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required style="font:inherit;padding:8px;margin-top:4px"></label></p>`
    + `<button type="submit">Continue to Xero</button></form>`
    + `<p>The link expires 24 hours after it was made. It gives no access to Tolra.</p>`, status);
}

/** "a***@firm.example": enough to recognise the address, not the whole of it (the database makes the same for the page). */
export function maskRecipient(email: string): string {
  const [local, domain] = email.split("@");
  return local && domain ? `${local[0]}***@${domain}` : "your e-mail";
}
