import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type AppTestOutcome } from "@/lib/integrations/app-test-messages";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { getProfile } from "@/lib/integrations/microsoft/client";
import { isConsentBlocked } from "@/lib/integrations/microsoft/consent";
import { type MicrosoftConfig, MicrosoftAuthError, authorizeUrl as microsoftAuthorizeUrl, exchangeCode as microsoftExchange } from "@/lib/integrations/microsoft/oauth";
import { APP_TEST_TTL_SECONDS, type SignedStatePayload, signState } from "@/lib/integrations/signed-state";
import { ProviderError } from "@/lib/integrations/types";
import { type XeroConfig, XeroAuthError, authorizeUrl as xeroAuthorizeUrl, exchangeCode as xeroExchange, listConnections, newAuthorisation } from "@/lib/integrations/xero/oauth";

// Platform > App connections > "Test connection": a REAL sign-in round trip for the platform owner's own account, to prove an app's
// redirect URI, client id and client secret are all accepted before any company clicks Connect. Xero: authorize, callback, token, read the
// connections list. Microsoft: authorize, callback, token, GET /me. Nothing is stored for any company or anywhere: the tokens are used for
// the one read and then dropped. The state is a separate signed kind ("app_test": lib/integrations/signed-state.ts), so the callbacks
// never save company tokens for it.

type Ready<C> = { config: C; key: Buffer };

const pkceContext = (nonce: string, provider: "xero" | "microsoft") => ({ organizationId: `app-test:${nonce}`, provider, purpose: "pkce" as const });

/** The provider's sign-in URL for a test, with a signed one-use state bound to this platform owner. */
export function beginAppTest(provider: "xero", ready: Ready<XeroConfig>, userId: string, now?: number): string;
export function beginAppTest(provider: "microsoft", ready: Ready<MicrosoftConfig>, userId: string, now?: number): string;
export function beginAppTest(provider: "xero" | "microsoft", ready: Ready<XeroConfig | MicrosoftConfig>, userId: string, now: number = Date.now()): string {
  const auth = newAuthorisation();
  // The encrypted verifier is bound to the state's own nonce, so a ciphertext copied into another state does not decrypt.
  const { state } = signState({ k: "app_test", p: provider, o: null, u: userId, ttlSeconds: APP_TEST_TTL_SECONDS, v: (nonce) => encryptSecret(auth.verifier, pkceContext(nonce, provider), ready.key) }, ready.key, now);
  return provider === "xero"
    ? xeroAuthorizeUrl(ready.config as XeroConfig, state, auth.challenge)
    : microsoftAuthorizeUrl(ready.config as MicrosoftConfig, state, auth.challenge);
}

/** The sign-in came back with an error: what it means in plain words. `error` and `description` are the callback's own query values. */
export function classifyProviderError(error: string | null | undefined, description: string | null | undefined): AppTestOutcome {
  const text = `${error ?? ""} ${description ?? ""}`;
  if (isConsentBlocked(text)) return "consent_blocked";
  if (/AADSTS50011|redirect[_ ]uri/i.test(text)) return "redirect_mismatch";
  if (/AADSTS7000215|AADSTS7000222|AADSTS7000218|invalid_client/i.test(text)) return "bad_secret";
  if (/AADSTS700016|unauthorized_client/i.test(text)) return "bad_client_id";
  if (/AADSTS50020|AADSTS500200|AADSTS50194|AADSTS700038|AADSTS9002331|personal/i.test(text)) return "wrong_account";
  if (/access_denied/i.test(text)) return "denied";
  return "failed";
}

/** The token endpoint refused: its error code (safe to keep) in plain words. */
function classifyTokenError(err: unknown): AppTestOutcome {
  const code = err instanceof XeroAuthError || err instanceof MicrosoftAuthError ? err.code : "";
  if (code === "invalid_client") return "bad_secret";
  if (code === "unauthorized_client") return "bad_client_id";
  if (code === "invalid_grant") return "redirect_mismatch";
  return "failed";
}

/** The code came back: exchange it, make the one read, drop everything. Never stores or returns a token. */
export async function finishAppTest(payload: SignedStatePayload, ready: Ready<XeroConfig | MicrosoftConfig>, code: string, fetchImpl: typeof fetch = fetch): Promise<AppTestOutcome> {
  if (!payload.v) return "failed";
  let verifier: string;
  try {
    verifier = decryptSecret(payload.v, pkceContext(payload.n, payload.p), ready.key);
  } catch {
    return "failed";
  }
  try {
    if (payload.p === "xero") {
      const tokens = await xeroExchange(ready.config as XeroConfig, code, verifier, fetchImpl);
      await listConnections(tokens.accessToken, fetchImpl);
    } else {
      const tokens = await microsoftExchange(ready.config as MicrosoftConfig, code, verifier, fetchImpl);
      await getProfile(tokens.accessToken, fetchImpl);
    }
    return "ok";
  } catch (err) {
    if (err instanceof ProviderError) return "failed";
    return classifyTokenError(err);
  }
}

/** The signed-in person is still the platform owner who started the test, with the second step done. */
export async function ownerStillValid(supabase: SupabaseClient | null, userId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getUser();
  if (data?.user?.id !== userId) return false;
  const { data: isOwner, error } = await supabase.rpc("is_platform_admin");
  if (error || isOwner !== true) return false;
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return !assuranceError && assurance?.currentLevel === "aal2";
}
