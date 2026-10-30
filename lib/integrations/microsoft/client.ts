import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAppCredentials } from "@/lib/integrations/app-credentials";
import { encryptionKey } from "@/lib/integrations/crypto";
import { serviceDb } from "@/lib/integrations/server";
import { createTokenSource } from "@/lib/integrations/tokens";
import { ProviderError } from "@/lib/integrations/types";
import { type MicrosoftConfig, MicrosoftAuthError, microsoftConfigFrom, refreshTokens } from "@/lib/integrations/microsoft/oauth";

// Microsoft Graph for one connected mailbox (E7). The access token is renewed under 084's lease (lib/integrations/tokens.ts: one holder
// at a time, the new refresh token stored before the new access token is used); a refused refresh (invalid_grant) marks the connection
// needs_reconnect. Tokens are decrypted only in memory here and never logged.

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;

export type MicrosoftReady = { config: MicrosoftConfig; key: Buffer };

/** Microsoft 365 is usable on this server: the app's credentials (stored, else MS_CLIENT_ID / MS_CLIENT_SECRET) and the encryption key. */
export async function microsoftReady(service: SupabaseClient | null, env: Record<string, string | undefined> = process.env): Promise<MicrosoftReady | null> {
  let key: Buffer;
  try {
    key = encryptionKey(env);
  } catch {
    return null;
  }
  const creds = await getAppCredentials("microsoft", { service, env, key }).catch(() => null);
  return creds ? { config: microsoftConfigFrom(creds, env), key } : null;
}

/** The company's Microsoft 365 access token, renewed when due; null when it must connect again. */
export function microsoftTokenSource(service: SupabaseClient, ready: MicrosoftReady, fetchImpl: typeof fetch = fetch) {
  const source = createTokenSource({
    db: serviceDb(service),
    key: ready.key,
    refresh: (refreshToken) => refreshTokens(ready.config, refreshToken, fetchImpl),
    isRefused: (err) => err instanceof MicrosoftAuthError && (err.code === "invalid_grant" || err.code === "interaction_required"),
    label: "Microsoft 365",
  });
  return (org: string, opts?: { force?: boolean }) => source(org, "microsoft", opts);
}

export type MailboxProfile = { id: string; mailbox: string; displayName: string | null };

/** The signed-in mailbox (GET /me): its object id (the connection's tenant_id), address and name. */
export async function getProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<MailboxProfile> {
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("Could not reach Microsoft 365", "unknown", 502);
  }
  const json = (await res.json().catch(() => null)) as { id?: unknown; displayName?: unknown; mail?: unknown; userPrincipalName?: unknown; error?: { code?: unknown } } | null;
  if (res.status === 401) throw new ProviderError("Microsoft 365 refused the access token", "unauthorized", 401);
  if (res.status === 403) throw new ProviderError("Microsoft 365 refused access to this mailbox: connect again", "forbidden", 403);
  if (!res.ok || typeof json?.id !== "string") {
    const code = typeof json?.error?.code === "string" ? json.error.code.slice(0, 64) : `HTTP ${res.status}`;
    throw new ProviderError(`Microsoft 365 did not answer with the mailbox (${code})`, res.status >= 500 ? "unknown" : "failed", res.status);
  }
  const mailbox = (typeof json.mail === "string" && json.mail) || (typeof json.userPrincipalName === "string" && json.userPrincipalName) || "";
  return { id: json.id, mailbox: mailbox.replace(/[\r\n\t]+/g, " ").slice(0, 200), displayName: typeof json.displayName === "string" ? json.displayName.slice(0, 200) : null };
}
