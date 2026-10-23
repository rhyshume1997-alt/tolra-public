import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { KEY_VERSION, encryptSecret, encryptionKey, decryptSecret } from "@/lib/integrations/crypto";
import { type EngineDb, type EngineDeps, type RunSummary, runSends } from "@/lib/integrations/engine";
import { createTokenSource } from "@/lib/integrations/tokens";
import type { Mappings, ProviderId } from "@/lib/integrations/types";
import { createXeroClient } from "@/lib/integrations/xero/client";
import {
  type XeroConfig, type XeroConnection, XeroAuthError, authorizeUrl, chooseConnection, deleteConnection, exchangeCode, hashState, listConnections,
  newAuthorisation, refreshTokens, removableConnections, xeroConfig,
} from "@/lib/integrations/xero/oauth";

// The server's side of the integrations layer: the service-role database (migration 084's server-only functions), the encryption key and
// the Xero configuration, put together for the routes under app/api/integrations. The browser never receives a token, a code or a key.

export class DbError extends Error {
  constructor(message: string, readonly code?: string, readonly hint?: string) {
    super(message);
    this.name = "DbError";
  }
}

export function serviceDb(client: SupabaseClient): EngineDb {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new DbError(error.message, error.code, (error as { hint?: string }).hint);
      return data as T;
    },
    async mappings(org: string, provider: ProviderId): Promise<Mappings> {
      const { data, error } = await client.from("integration_mappings").select("kind, tolra_key, external_code").eq("organization_id", org).eq("provider", provider);
      if (error) throw new DbError(error.message, error.code);
      const out: Mappings = { salesAccount: null, creditAccount: null, taxRates: {} };
      for (const row of (data ?? []) as Array<{ kind: string; tolra_key: string; external_code: string }>) {
        if (row.kind === "sales_account") out.salesAccount = row.external_code;
        else if (row.kind === "credit_account") out.creditAccount = row.external_code;
        else if (row.kind === "tax_rate") out.taxRates[row.tolra_key] = row.external_code;
      }
      return out;
    },
    async contact(org: string, provider: ProviderId, customer: string) {
      const { data, error } = await client.from("integration_contacts").select("state, external_contact_id, problem")
        .eq("organization_id", org).eq("provider", provider).eq("customer_name", customer.trim()).maybeSingle();
      if (error) throw new DbError(error.message, error.code);
      return (data as { state: "ok" | "problem"; external_contact_id: string | null; problem: string | null } | null) ?? null;
    },
  };
}

/** Xero is usable on this server: the app's configuration and the encryption key are both set (names only; Rhys sets the values). */
export function xeroReady(env: Record<string, string | undefined> = process.env): { config: XeroConfig; key: Buffer } | null {
  const config = xeroConfig(env);
  if (!config) return null;
  try {
    return { config, key: encryptionKey(env) };
  } catch {
    return null;
  }
}

function engineDeps(db: EngineDb, ready: { config: XeroConfig; key: Buffer }): EngineDeps {
  return {
    db,
    accessToken: createTokenSource({
      db, key: ready.key,
      refresh: (refreshToken) => refreshTokens(ready.config, refreshToken),
      isRefused: (err) => err instanceof XeroAuthError,
    }),
    provider: (accessToken, tenantId) => createXeroClient({ accessToken, tenantId }),
  };
}

/** Sends what one company has queued (bounded: a few documents per call; the rest go on the next call). */
export function sendQueued(client: SupabaseClient, org: string, ready: { config: XeroConfig; key: Buffer },
                           opts?: { maxDocuments?: number; budgetMs?: number; only?: { docType: "invoice" | "credit_note"; docId: string } }): Promise<RunSummary> {
  return runSends(org, "xero", engineDeps(serviceDb(client), ready), opts);
}

/** Connect, step 1: the state and PKCE verifier are kept (as the signed-in admin: the database checks admin and two-step) and Xero's URL returned. */
export async function beginConnect(userClient: SupabaseClient, org: string, ready: { config: XeroConfig; key: Buffer }): Promise<string> {
  const auth = newAuthorisation();
  const { error } = await userClient.rpc("integration_oauth_begin", {
    p_provider: "xero", p_state_hash: auth.stateHash,
    p_verifier_enc: encryptSecret(auth.verifier, { organizationId: org, provider: "xero", purpose: "pkce" }, ready.key),
  });
  if (error) throw new DbError(error.message, error.code, (error as { hint?: string }).hint);
  return authorizeUrl(ready.config, auth.state, auth.challenge);
}

export type ConnectOutcome = { ok: true; tenantName: string } | { ok: false; reason: string };

/**
 * Connect, steps 2 and 3 (the callback): the state is used up for this admin and company; the code is exchanged (client secret, PKCE);
 * the organisation this consent connected is taken (exactly one, never guessed); the tokens are encrypted and stored. When the connection
 * is refused (several organisations ticked, the organisation linked to another company, this company linked to another), only a
 * connection this consent newly created for an organisation no Tolra company uses is removed again at Xero (removableConnections): a
 * connection another company relies on, or one that existed before, is never touched.
 */
export async function finishConnect(service: SupabaseClient, org: string, userId: string, state: string, code: string, ready: { config: XeroConfig; key: Buffer },
                                    deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<ConnectOutcome> {
  const db = serviceDb(service);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const consumed = await db.rpc<{ verifier_enc: string }>("integration_oauth_consume", { p_org: org, p_user: userId, p_provider: "xero", p_state_hash: hashState(state) });
  const verifier = decryptSecret(consumed.verifier_enc, { organizationId: org, provider: "xero", purpose: "pkce" }, ready.key);
  const tokens = await exchangeCode(ready.config, code, verifier, fetchImpl);
  const chosen = chooseConnection(await listConnections(tokens.accessToken, fetchImpl), tokens.authEventId);
  const cleanUp = async (touched: XeroConnection[]) => {
    const linked = await linkedTenantIds(service);
    // Can't tell which organisations are in use: remove nothing.
    if (!linked) return;
    for (const c of removableConnections(touched, linked, (deps.now ?? Date.now)())) {
      // Read again right before the delete: another company's Connect to the same new organisation may have been stored meanwhile (one
      // Xero login, two companies, a second apart). If any company now uses it, or the list can't be read, it is kept.
      const current = await linkedTenantIds(service);
      if (!current || current.has(c.tenantId)) continue;
      await deleteConnection(tokens.accessToken, c.id, fetchImpl);
    }
  };
  if (!chosen.ok) {
    await cleanUp(chosen.fresh);
    return { ok: false, reason: chosen.reason === "several" ? "choose_one" : "no_organisation" };
  }
  try {
    await db.rpc("integration_store_connection", {
      p_org: org, p_user: userId, p_provider: "xero", p_tenant_id: chosen.connection.tenantId, p_tenant_name: chosen.connection.tenantName,
      p_external_connection_id: chosen.connection.id,
      p_refresh_enc: encryptSecret(tokens.refreshToken, { organizationId: org, provider: "xero", purpose: "refresh" }, ready.key),
      p_access_enc: encryptSecret(tokens.accessToken, { organizationId: org, provider: "xero", purpose: "access" }, ready.key),
      p_access_expires_at: tokens.expiresAt.toISOString(), p_key_version: KEY_VERSION,
    });
  } catch (err) {
    await cleanUp([chosen.connection]);
    const hint = err instanceof DbError ? err.hint : undefined;
    return { ok: false, reason: hint === "tenant_in_use" || (err instanceof DbError && err.code === "23505") ? "tenant_in_use" : hint === "disconnect_first" ? "disconnect_first" : "store_failed" };
  }
  return { ok: true, tenantName: chosen.connection.tenantName };
}

/** Every Xero organisation a Tolra company is linked to (connected or waiting to connect again): never removed by a refused Connect. */
async function linkedTenantIds(service: SupabaseClient): Promise<Set<string> | null> {
  const { data, error } = await service.from("integration_connections").select("tenant_id").eq("provider", "xero").neq("status", "disconnected");
  if (error) return null;
  return new Set(((data ?? []) as Array<{ tenant_id: string | null }>).flatMap((r) => (r.tenant_id ? [r.tenant_id] : [])));
}

/**
 * Disconnect: the token is taken under the lease first (server side), then the database disconnects as the signed-in admin (admin and
 * two-step checked there; the tokens are deleted), then this app's connection to that one organisation is removed at Xero (best effort).
 */
export async function disconnectCompany(userClient: SupabaseClient, service: SupabaseClient, org: string, ready: { config: XeroConfig; key: Buffer } | null): Promise<{ removedAtXero: boolean }> {
  const { data: conn } = await service.from("integration_connections").select("external_connection_id, status").eq("organization_id", org).eq("provider", "xero").maybeSingle();
  let token: string | null = null;
  if (ready && conn && (conn as { status: string }).status !== "disconnected") {
    token = await engineDeps(serviceDb(service), ready).accessToken(org, "xero").catch(() => null);
  }
  const { error } = await userClient.rpc("integration_disconnect", { p_provider: "xero" });
  if (error) throw new DbError(error.message, error.code, (error as { hint?: string }).hint);
  const connectionId = (conn as { external_connection_id: string | null } | null)?.external_connection_id;
  return { removedAtXero: token && connectionId ? await deleteConnection(token, connectionId) : false };
}

/** The daily sweep's dependencies (lib/integrations/sweep.ts) for the cron route: every company connected to Xero, renewed and sent. */
export function sweepDeps(service: SupabaseClient, ready: { config: XeroConfig; key: Buffer }) {
  const deps = engineDeps(serviceDb(service), ready);
  return {
    async connected() {
      const { data, error } = await service.from("integration_connections").select("organization_id, provider").eq("status", "connected");
      if (error) throw new DbError(error.message, error.code);
      return ((data ?? []) as Array<{ organization_id: string; provider: ProviderId }>).map((r) => ({ organizationId: r.organization_id, provider: r.provider }));
    },
    renew: (org: string, provider: ProviderId) => deps.accessToken(org, provider, { force: true }),
    send: (org: string) => sendQueued(service, org, ready),
  };
}
