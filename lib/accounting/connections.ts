import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cloudAuthorize, cloudBalance, cloudConfig, cloudTenant, cloudTokens, AccountingError, type CloudConfig } from "@/lib/accounting/cloud-adapters";
import type { AccountingId, ConnectionAdapter } from "@/lib/accounting/types";
import { KEY_VERSION, decryptSecret, encryptSecret, encryptionKey } from "@/lib/integrations/crypto";
import { beginConnect, companyXeroToken, disconnectCompany, disconnectAndRevoke, finishConnect, serviceDb, xeroReady } from "@/lib/integrations/server";
import { createTokenSource } from "@/lib/integrations/tokens";
import { hashState, newAuthorisation } from "@/lib/integrations/xero/oauth";

/** One connection contract. The Xero adapter retains its reviewed callback/tenant cleanup and send engine. */
export async function accountingConnection(id: AccountingId, context: { userClient: SupabaseClient; service: SupabaseClient; org: string; userId: string }): Promise<ConnectionAdapter | null> {
  const { userClient, service, org, userId } = context;
  let config: CloudConfig;
  let key: Buffer;
  if (id === "xero") {
    const ready = await xeroReady(process.env, service);
    if (!ready) return null;
    ({ config, key } = ready);
    return {
      id,
      begin: () => beginConnect(userClient, org, ready),
      finish: async (state, code) => (await finishConnect(service, org, userId, state, code, ready)).ok,
      disconnect: async () => { await disconnectCompany(userClient, service, org, ready); },
      checkInvoice: async (number) => {
        const connected = await companyXeroToken(service, org, ready);
        if (!connected) throw new AccountingError("refused");
        return cloudBalance(id, config, connected.token, connected.tenantId, number);
      },
    };
  }
  const found = cloudConfig(id);
  if (!found) return null;
  config = found;
  try { key = encryptionKey(); } catch { return null; }
  // New adapters stay disabled before their separately reviewed database update exists.
  const feature = await service.rpc("accounting_cloud_connections_ready");
  if (feature.error || feature.data !== true) return null;
  const db = serviceDb(service);
  const tokenSource = createTokenSource({ db, key, label: id === "sage" ? "Sage" : "QuickBooks",
    refresh: (refreshToken) => cloudTokens(id, config, { refreshToken }),
    isRefused: (err) => err instanceof AccountingError && err.reason === "refused" });
  return {
    id,
    async begin() {
      const auth = newAuthorisation();
      const { error } = await userClient.rpc("integration_oauth_start", { p_provider: id, p_state_hash: auth.stateHash,
        p_verifier_enc: encryptSecret(auth.verifier, { organizationId: org, provider: id, purpose: "pkce" }, key) });
      if (error) throw new AccountingError("refused");
      return cloudAuthorize(id, config, auth.state, auth.challenge);
    },
    async finish(state, code, realm) {
      const consumed = await db.rpc<{ verifier_enc: string }>("integration_oauth_consume", { p_org: org, p_user: userId, p_provider: id, p_state_hash: hashState(state) });
      const verifier = decryptSecret(consumed.verifier_enc, { organizationId: org, provider: id, purpose: "pkce" }, key);
      const tokens = await cloudTokens(id, config, { code, verifier });
      const tenant = await cloudTenant(id, config, tokens.accessToken, realm);
      await db.rpc("integration_store_connection", { p_org: org, p_user: userId, p_provider: id, p_tenant_id: tenant.id, p_tenant_name: tenant.name,
        p_external_connection_id: null,
        p_refresh_enc: encryptSecret(tokens.refreshToken, { organizationId: org, provider: id, purpose: "refresh" }, key),
        p_access_enc: encryptSecret(tokens.accessToken, { organizationId: org, provider: id, purpose: "access" }, key),
        p_access_expires_at: tokens.expiresAt.toISOString(), p_key_version: KEY_VERSION });
      return true;
    },
    disconnect: () => disconnectAndRevoke(userClient, id),
    async checkInvoice(number) {
      const { data, error } = await service.from("integration_connections").select("tenant_id,status").eq("organization_id", org).eq("provider", id).maybeSingle();
      if (error || data?.status !== "connected" || !data?.tenant_id) throw new AccountingError("refused");
      const token = await tokenSource(org, id);
      if (!token) throw new AccountingError("refused");
      return cloudBalance(id, config, token, data.tenant_id, number);
    },
  };
}

/** Disconnect must remain possible even after app credentials are removed. */
export async function disconnectAccounting(id: AccountingId, context: { userClient: SupabaseClient; service: SupabaseClient; org: string }) {
  if (id === "xero") {
    await disconnectCompany(context.userClient, context.service, context.org, await xeroReady(process.env, context.service));
  } else await disconnectAndRevoke(context.userClient, id);
}
