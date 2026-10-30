import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { KEY_VERSION, decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { DbError, serviceDb } from "@/lib/integrations/server";
import { type MicrosoftReady, getProfile, microsoftTokenSource } from "@/lib/integrations/microsoft/client";
import { authorizeUrl, exchangeCode } from "@/lib/integrations/microsoft/oauth";
import { hashState, newAuthorisation } from "@/lib/integrations/xero/oauth";

// Admin > Integrations > Microsoft 365 (E7): Connect, the callback, Disconnect and Test, mirroring Xero's (lib/integrations/server.ts).
// The state and PKCE verifier are kept by 107's integration_oauth_start as the signed-in admin (admin, two-step, own company, never a
// support session); the callback uses 084's integration_oauth_consume and integration_store_connection with provider 'microsoft' (the
// mailbox's object id is the connection's tenant_id, its address the tenant_name). The browser never receives a token, a code or a key.

const ctx = (org: string, purpose: "pkce" | "refresh" | "access") => ({ organizationId: org, provider: "microsoft", purpose });

/** Connect, step 1: Microsoft's sign-in URL (the database keeps the state's hash and the encrypted verifier for 10 minutes). */
export async function beginMicrosoftConnect(userClient: SupabaseClient, org: string, ready: MicrosoftReady): Promise<string> {
  const auth = newAuthorisation();
  const { error } = await userClient.rpc("integration_oauth_start", {
    p_provider: "microsoft", p_state_hash: auth.stateHash, p_verifier_enc: encryptSecret(auth.verifier, ctx(org, "pkce"), ready.key),
  });
  if (error) throw new DbError(error.message, error.code, (error as { hint?: string }).hint);
  return authorizeUrl(ready.config, auth.state, auth.challenge);
}

export type MicrosoftConnectOutcome = { ok: true; mailbox: string } | { ok: false; reason: "mailbox_in_use" | "disconnect_first" | "no_mailbox" | "store_failed" };

/** Connect, steps 2 and 3 (the callback): the state used up for this admin and company; the code exchanged; the mailbox read; stored. */
export async function finishMicrosoftConnect(service: SupabaseClient, org: string, userId: string, state: string, code: string, ready: MicrosoftReady,
                                             deps: { fetchImpl?: typeof fetch } = {}): Promise<MicrosoftConnectOutcome> {
  const db = serviceDb(service);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const consumed = await db.rpc<{ verifier_enc: string }>("integration_oauth_consume", { p_org: org, p_user: userId, p_provider: "microsoft", p_state_hash: hashState(state) });
  const verifier = decryptSecret(consumed.verifier_enc, ctx(org, "pkce"), ready.key);
  const tokens = await exchangeCode(ready.config, code, verifier, fetchImpl);
  const profile = await getProfile(tokens.accessToken, fetchImpl);
  if (!profile.mailbox) return { ok: false, reason: "no_mailbox" };
  try {
    await db.rpc("integration_store_connection", {
      p_org: org, p_user: userId, p_provider: "microsoft", p_tenant_id: profile.id, p_tenant_name: profile.mailbox, p_external_connection_id: null,
      p_refresh_enc: encryptSecret(tokens.refreshToken, ctx(org, "refresh"), ready.key),
      p_access_enc: encryptSecret(tokens.accessToken, ctx(org, "access"), ready.key),
      p_access_expires_at: tokens.expiresAt.toISOString(), p_key_version: KEY_VERSION,
    });
  } catch (err) {
    const hint = err instanceof DbError ? err.hint : undefined;
    if (hint === "tenant_in_use" || (err instanceof DbError && err.code === "23505")) return { ok: false, reason: "mailbox_in_use" };
    if (hint === "disconnect_first") return { ok: false, reason: "disconnect_first" };
    return { ok: false, reason: "store_failed" };
  }
  return { ok: true, mailbox: profile.mailbox };
}

/** Disconnect: as the signed-in admin (the database checks admin and two-step; the tokens are deleted). Consent stays at Microsoft. */
export async function disconnectMicrosoft(userClient: SupabaseClient): Promise<void> {
  const { error } = await userClient.rpc("integration_disconnect", { p_provider: "microsoft" });
  if (error) throw new DbError(error.message, error.code, (error as { hint?: string }).hint);
}

/** Test: the company's mailbox as Microsoft 365 answers for it now (a fresh token if due). null when not connected / must connect again. */
export async function testMicrosoft(service: SupabaseClient, org: string, ready: MicrosoftReady, fetchImpl: typeof fetch = fetch): Promise<{ mailbox: string } | null> {
  const { data, error } = await service.from("integration_connections").select("status").eq("organization_id", org).eq("provider", "microsoft").maybeSingle();
  if (error) throw new DbError(error.message, error.code);
  if ((data as { status: string } | null)?.status !== "connected") return null;
  const token = await microsoftTokenSource(service, ready, fetchImpl)(org);
  if (!token) return null;
  return { mailbox: (await getProfile(token, fetchImpl)).mailbox };
}
