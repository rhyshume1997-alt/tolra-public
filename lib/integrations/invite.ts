import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { inviteRedirectUri } from "@/lib/integrations/app-credentials";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { type ConnectOutcome, DbError, completeConnect, serviceDb } from "@/lib/integrations/server";
import { type XeroConfig, authorizeUrl, hashState, newAuthorisation } from "@/lib/integrations/xero/oauth";
import { LimiterUnavailableError, clientIp, withinLimit } from "@/lib/server/login";

// The accountant's connect link (E2; migration 107). An admin (two-step, own company, never support) makes a one-use link valid 24 hours;
// only its SHA-256 is kept. The accountant opens it signed out: the GET only shows "Connect <company> to Xero" with one Continue button
// (integration_invite_peek: nothing is used up, so a mail scanner or a chat preview opening the link never burns it). The button's POST
// (same origin) uses it up (integration_invite_redeem: unused, not cancelled, unexpired, and the admin who made it still an admin) and
// sends them straight to Xero; Xero sends them back to /api/integrations/invite/callback,
// which completes the connection for THAT company only, as the admin who made the link (084's integration_store_connection checks
// that person is still an active admin). The link grants nothing else: no Tolra session, no page, no data.

/** 32 random bytes, base64url: 43 characters. */
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const INVITE_HOURS = 24;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

/**
 * The PKCE verifier of an invite's Connect is encrypted before the company is known (the link is used up and the state kept in one
 * statement), so it is bound to its own state instead: a ciphertext copied to another state row does not decrypt.
 */
export const inviteVerifierContext = (stateHash: string) => ({ organizationId: `invite-state:${stateHash}`, provider: "xero", purpose: "pkce" as const });

/** The Xero configuration for the accountant's Connect: the same app, the invite callback as redirect URI. */
export function inviteConfig(config: XeroConfig): XeroConfig {
  return { ...config, redirectUri: inviteRedirectUri(config.redirectUri) };
}

/** The link's page: the company's name for an open link, or null (malformed, unknown, used, cancelled, expired). Nothing is used up. */
export async function peekInvite(service: SupabaseClient, token: string): Promise<{ companyName: string } | null> {
  if (!INVITE_TOKEN.test(token)) return null;
  const out = await serviceDb(service).rpc<{ company_name?: unknown } | null>("integration_invite_peek", { p_token_hash: hashInviteToken(token) });
  return out && typeof out.company_name === "string" ? { companyName: out.company_name } : null;
}

/** The public link routes' limit: 20 in 15 minutes per IP (the page, its Continue and Xero's return), as auth/reset does. */
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

export type RedeemOutcome = { ok: true; url: string } | { ok: false; reason: "invalid" };

/** The link is opened: used up (once) and Xero's sign-in URL returned. "invalid" for a malformed, unknown, used or expired link. */
export async function redeemInvite(service: SupabaseClient, token: string, ready: { config: XeroConfig; key: Buffer }): Promise<RedeemOutcome> {
  if (!INVITE_TOKEN.test(token)) return { ok: false, reason: "invalid" };
  const auth = newAuthorisation();
  try {
    await serviceDb(service).rpc("integration_invite_redeem", {
      p_token_hash: hashInviteToken(token), p_state_hash: auth.stateHash,
      p_verifier_enc: encryptSecret(auth.verifier, inviteVerifierContext(auth.stateHash), ready.key),
    });
  } catch (err) {
    if (err instanceof DbError && (err.hint === "invite_invalid" || err.code === "42501")) return { ok: false, reason: "invalid" };
    throw err;
  }
  return { ok: true, url: authorizeUrl(inviteConfig(ready.config), auth.state, auth.challenge) };
}

/** Xero sent the accountant back: the invite's state (only an invite's) is used up and the connection completed for its company. */
export async function finishInviteConnect(service: SupabaseClient, state: string, code: string, ready: { config: XeroConfig; key: Buffer },
                                          deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<ConnectOutcome> {
  const stateHash = hashState(state);
  const consumed = await serviceDb(service).rpc<{ organization_id: string; user_id: string; verifier_enc: string } | null>("integration_oauth_consume_invite", { p_provider: "xero", p_state_hash: stateHash });
  if (!consumed) return { ok: false, reason: "expired" };
  const verifier = decryptSecret(consumed.verifier_enc, inviteVerifierContext(stateHash), ready.key);
  return completeConnect(service, consumed.organization_id, consumed.user_id, verifier, code, { config: inviteConfig(ready.config), key: ready.key }, deps);
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
};

const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(title: string, inner: string, status: number, extra: Record<string, string> = {}): Response {
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
export function invitePage(outcome: string, status = 200): Response {
  const p = PAGE[outcome] ?? PAGE.failed;
  return page(p.title, `<h1>${p.title}</h1><p>${p.body}</p>`, status);
}

/**
 * The link's page for an open link: "Connect <company> to Xero" and one Continue button. The button POSTs to the same address (same
 * origin); only that uses the link up. The company's name is the only data on it (HTML-escaped).
 */
export function inviteConfirmPage(companyName: string): Response {
  const name = escapeHtml(companyName);
  return page(`Connect ${name} to Xero`,
    `<h1>Connect ${name} to Xero</h1><p>You were sent this link to connect ${name}'s Tolra to its Xero organisation. Continue to sign in to Xero and choose that organisation.</p>`
    + `<p>The link works once and expires 24 hours after it was made. It gives no access to Tolra.</p>`
    + `<form method="post"><button type="submit">Continue to Xero</button></form>`, 200);
}
