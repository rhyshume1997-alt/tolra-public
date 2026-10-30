import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { inviteRedirectUri } from "@/lib/integrations/app-credentials";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { type ConnectOutcome, DbError, completeConnect, serviceDb } from "@/lib/integrations/server";
import { type XeroConfig, authorizeUrl, hashState, newAuthorisation } from "@/lib/integrations/xero/oauth";

// The accountant's connect link (E2; migration 107). An admin (two-step, own company, never support) makes a one-use link valid 24 hours;
// only its SHA-256 is kept. The accountant opens it signed out: the server uses it up (integration_invite_redeem: unused, unexpired, and
// the admin who made it still an admin) and sends them straight to Xero; Xero sends them back to /api/integrations/invite/callback,
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
  not_configured: { title: "Not set up yet", body: "Xero is not set up in Tolra yet. Nothing was used up: try the same link later." },
  failed: { title: "That didn't work", body: "Connecting to Xero didn't work and nothing changed. Ask for a new link." },
};

/** A fixed page for the accountant (no Tolra session, so no app page): fixed text by outcome only, nothing from the request. */
export function invitePage(outcome: string, status = 200): Response {
  const p = PAGE[outcome] ?? PAGE.failed;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">`
    + `<title>${p.title}</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:48px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 12px}p{color:#475569;line-height:1.5}</style></head>`
    + `<body><main><h1>${p.title}</h1><p>${p.body}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}
