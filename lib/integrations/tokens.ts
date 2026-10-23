// Access tokens for one company (G22, Lot B §2.6 step 4). Xero's refresh token is single use and rotates, so it is refreshed only under
// migration 084's lease (one holder at a time), and the new pair is stored BEFORE the new access token is used; a refused refresh token
// (invalid_grant) marks the connection needs_reconnect, which pauses sending until an admin connects again. Tokens are decrypted only in
// memory here and never logged.

import { randomUUID } from "node:crypto";

import { IntegrationCryptoError, KEY_VERSION, decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import type { EngineDb } from "@/lib/integrations/engine";
import type { ProviderId } from "@/lib/integrations/types";
import type { TokenSet } from "@/lib/integrations/xero/oauth";

type Lease = { refresh_token_enc: string; access_token_enc: string | null; access_expires_at: string | null; key_version: number };

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export type TokenSourceDeps = {
  db: EngineDb;
  key: Buffer;
  /** Xero's refresh call (lib/integrations/xero/oauth.ts refreshTokens with the app's configuration). */
  refresh(refreshToken: string): Promise<TokenSet>;
  /** true for "the refresh token was refused: connect again" (XeroAuthError invalid_grant). */
  isRefused(err: unknown): boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** The company's access token, refreshed under the lease when it is due (or forced), or null when the company must connect again. */
export function createTokenSource(deps: TokenSourceDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async function accessToken(org: string, provider: ProviderId, opts: { force?: boolean } = {}): Promise<string | null> {
    const holder = randomUUID();
    let lease: Lease | null = null;
    // Another caller may be refreshing right now: wait for it (its lease is at most 60 seconds) rather than refresh twice.
    for (let i = 0; i < 4 && !lease; i += 1) {
      lease = await deps.db.rpc<Lease | null>("integration_token_lease", { p_org: org, p_provider: provider, p_holder: holder, p_seconds: 60 });
      if (!lease && i < 3) await sleep(1_500);
    }
    if (!lease) return null;
    const ctx = (purpose: "refresh" | "access") => ({ organizationId: org, provider, purpose });
    try {
      if (!opts.force && lease.access_token_enc && lease.access_expires_at && Date.parse(lease.access_expires_at) - now() > REFRESH_MARGIN_MS) {
        return decryptSecret(lease.access_token_enc, ctx("access"), deps.key);
      }
      const refreshToken = decryptSecret(lease.refresh_token_enc, ctx("refresh"), deps.key);
      let set: TokenSet;
      try {
        set = await deps.refresh(refreshToken);
      } catch (err) {
        if (deps.isRefused(err)) {
          await deps.db.rpc("integration_mark_needs_reconnect", { p_org: org, p_provider: provider, p_reason: "Xero refused the stored sign-in (it was revoked, or not used for 60 days): connect again." });
          return null;
        }
        throw err;
      }
      const stored = await deps.db.rpc<boolean>("integration_token_store", {
        p_org: org, p_provider: provider, p_holder: holder,
        p_refresh_enc: encryptSecret(set.refreshToken, ctx("refresh"), deps.key),
        p_access_enc: encryptSecret(set.accessToken, ctx("access"), deps.key),
        p_access_expires_at: set.expiresAt.toISOString(), p_key_version: KEY_VERSION,
      });
      if (!stored) {
        // Another holder took the lease over while Xero answered: the new refresh token could not be kept, so the stored one is spent.
        await deps.db.rpc("integration_mark_needs_reconnect", { p_org: org, p_provider: provider, p_reason: "The Xero sign-in was renewed twice at once and could not be kept: connect again." });
        return null;
      }
      return set.accessToken;
    } catch (err) {
      if (err instanceof IntegrationCryptoError) {
        await deps.db.rpc("integration_mark_needs_reconnect", { p_org: org, p_provider: provider, p_reason: "The stored Xero sign-in can't be read with this server's key: connect again." });
        return null;
      }
      throw err;
    } finally {
      await deps.db.rpc("integration_token_release", { p_org: org, p_provider: provider, p_holder: holder }).catch(() => undefined);
    }
  };
}
