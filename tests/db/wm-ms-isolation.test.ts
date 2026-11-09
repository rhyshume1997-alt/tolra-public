/**
 * W-M (database half): Microsoft 365 per-company isolation proved with the app's REAL code against REAL SQL (migrations 000-137 + releases
 * 138-147 on a disposable PG16). The app code (beginMicrosoftConnect / finishMicrosoftConnect, getDelegatedAccessToken, selectProvider,
 * runMailboxPollPass) runs unchanged; its Supabase client is a thin adapter (wmClient below) that runs every rpc/select as one SQL
 * transaction as the given role. Only Microsoft is faked (token endpoint, /me, the inbox), keyed by the code or bearer token it receives, so
 * a wrong token reads as the OTHER company's mailbox. The unit half (filters recorded on a fake database) is tests/unit/wm-ms-isolation.test.ts.
 *
 * Not PostgREST (no HTTP, no PostgREST parsing); not Microsoft (see the report's "unproven").
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const hold = vi.hoisted(() => ({ service: null as unknown }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => hold.service }));

import { decryptSecret } from "@/lib/integrations/crypto";
import { beginMicrosoftConnect, finishMicrosoftConnect } from "@/lib/integrations/microsoft/connect";
import { runMailboxPollPass } from "@/lib/integrations/microsoft/inbox";
import { selectProvider } from "@/lib/email/send-company-email";
import { getDelegatedAccessToken } from "@/lib/integrations/microsoft/token-source";
import { hashState } from "@/lib/integrations/xero/oauth";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

const key = randomBytes(32);
const ready = { config: { clientId: "wm-client", clientSecret: "wm-secret", redirectUri: "https://app.example.test/api/integrations/microsoft/callback", tenant: "organizations" }, key };
const ctx = (org: string, purpose: "refresh" | "access" | "pkce") => ({ organizationId: org, provider: "microsoft", purpose });

let world: SyntheticWorld;
const alpha = () => world.tenants.alpha; // "JNR"
const beta = () => world.tenants.beta; // "Marpet"

// ---- the adapter: the app's supabase-js calls as real SQL, one transaction each, as `role` with the JWT claims ----------------------
type Result = { data: unknown; error: { code?: string; message: string; hint?: string } | null };
const ident = (n: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error(`bad identifier ${n}`); return `"${n}"`; };
async function inRole<T>(role: "service_role" | "authenticated", claims: Record<string, unknown> | undefined, fn: (db: import("pg").Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query(`set local role ${role}`);
      if (claims) await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims), String(claims.sub ?? "")]);
      const out = await fn(db);
      await db.query("commit");
      return out;
    } catch (err) {
      await db.query("rollback").catch(() => undefined);
      throw err;
    }
  });
}
const asError = (e: unknown) => { const x = e as { code?: string; message: string; hint?: string }; return { code: x.code, message: x.message, hint: x.hint }; };
function wmClient(role: "service_role" | "authenticated", claims?: Record<string, unknown>): SupabaseClient {
  const rpc = async (fn: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const names = Object.keys(args);
    const sql = `select * from public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")})`;
    try {
      const res = await inRole(role, claims, (db) => db.query(sql, names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]))));
      if (res.fields.length === 1 && res.fields[0].name === fn) return { data: res.rows[0]?.[fn] ?? null, error: null };
      return { data: res.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), error: null };
    } catch (e) {
      return { data: null, error: asError(e) };
    }
  };
  const from = (table: string) => {
    let cols = "*"; const where: Array<[string, unknown]> = [];
    const q = {
      select: (c: string) => { cols = c.split(",").map((x) => ident(x.trim())).join(", "); return q; },
      eq: (c: string, v: unknown) => { where.push([c, v]); return q; },
      maybeSingle: async (): Promise<Result> => {
        const sql = `select ${cols} from public.${ident(table)}${where.length ? ` where ${where.map(([c], i) => `${ident(c)} = $${i + 1}`).join(" and ")}` : ""}`;
        try {
          const res = await inRole(role, claims, (db) => db.query(sql, where.map(([, v]) => v)));
          if (res.rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
          return { data: res.rows[0] ?? null, error: null };
        } catch (e) {
          return { data: null, error: asError(e) };
        }
      },
    };
    return q;
  };
  return { rpc, from } as unknown as SupabaseClient;
}
const service = () => wmClient("service_role");
const adminClient = (t: { users: { admin: { id: string } } }) => wmClient("authenticated", { sub: t.users.admin.id, role: "authenticated", aud: "authenticated", aal: "aal2", session_id: randomUUID() });
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<R>(text, params)).rows);
async function ownerRefusal(text: string, params: unknown[] = []) {
  try { await owner(text, params); return null; } catch (e) { return asError(e); }
}

// ---- a fake Microsoft: tokens and mailboxes are keyed by what the code presents ------------------------------------------------------
/** code "code:<tag>" is a sign-in for the mailbox <tag>; it returns EWM-AT-<tag>-n / EWM-RT-<tag>-n. */
const ms = { tokenCalls: [] as string[], inbox: {} as Record<string, Array<{ id: string; subject: string; at: string }>>, inboxStatus: {} as Record<string, number>, inboxAuth: [] as string[], n: 0 };
const msFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/oauth2/v2.0/token")) {
    const body = init?.body as URLSearchParams;
    const code = body.get("code") ?? "";
    const tag = code.startsWith("code:") ? code.slice(5) : (body.get("refresh_token") ?? "").replace(/^EWM-RT-/, "").replace(/-\d+$/, "");
    ms.n += 1;
    ms.tokenCalls.push(`${body.get("grant_type")}:${tag}`);
    return Response.json({ access_token: `EWM-AT-${tag}-${ms.n}`, refresh_token: `EWM-RT-${tag}-${ms.n}`, expires_in: 3600, scope: "offline_access User.Read Mail.Send Mail.Read" });
  }
  if (url.includes("/me?")) {
    const bearer = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer EWM-AT-/, "").replace(/-\d+$/, "");
    return Response.json({ id: `oid-${bearer}`, mail: `office@${bearer}.example.test`, displayName: bearer });
  }
  if (url.includes("/me/mailFolders/inbox/messages")) {
    const auth = String((init?.headers as Record<string, string>).authorization);
    ms.inboxAuth.push(auth);
    const tag = auth.replace(/^Bearer EWM-AT-/, "").replace(/-\d+$/, "");
    if (ms.inboxStatus[tag]) return new Response("{}", { status: ms.inboxStatus[tag] });
    return Response.json({ value: (ms.inbox[tag] ?? []).map((m) => ({ id: m.id, internetMessageId: `<${m.id}@x>`, receivedDateTime: m.at, subject: m.subject, bodyPreview: m.subject, from: { emailAddress: { address: `cust@${tag}.example.test`, name: "Cust" } }, body: { content: m.subject } })) });
  }
  if (url.endsWith("/me/sendMail")) return new Response(null, { status: 202 });
  throw new Error(`unexpected Microsoft call ${url}`);
};

/** The app's own Connect flow for a company's admin: begin (as the admin), Microsoft returns `code:<tag>`, finish (service). */
async function connect(t: typeof alpha extends () => infer R ? R : never, tag: string, code = `code:${tag}`) {
  const url = new URL(await beginMicrosoftConnect(adminClient(t), t.id, ready));
  const state = url.searchParams.get("state") ?? "";
  const outcome = await finishMicrosoftConnect(service(), t.id, t.users.admin.id, state, code, ready, { fetchImpl: msFetch });
  return { outcome, state, url };
}
const conn = (org: string) => owner<{ status: string; tenant_id: string | null; tenant_name: string | null }>("select status, tenant_id, tenant_name from public.integration_connections where organization_id=$1 and provider='microsoft'", [org]);
const disconnect = (t: { users: { admin: { id: string } } }) => adminClient(t).rpc("integration_disconnect", { p_provider: "microsoft" });
const bearer = (tag: string) => new RegExp(`^Bearer EWM-AT-${tag}-\\d+$`);

const sentWith: string[] = [];
async function sendAs(org: string) {
  const provider = await selectProvider(org, { env: {}, fetch: (async (u: string, init?: { headers?: Record<string, string> }) => { sentWith.push(String(init?.headers?.Authorization)); return new Response(null, { status: 202 }); }) as never });
  if (!provider || provider === "refused") return provider;
  await provider.send({ to: ["acc@customer.test"], cc: [], subject: "s", text: "t", attachments: [] });
  return provider.name;
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  hold.service = service();
  process.env.INTEGRATIONS_ENCRYPTION_KEY = key.toString("base64");
  process.env.MS_CLIENT_ID = ready.config.clientId;
  process.env.MS_CLIENT_SECRET = ready.config.clientSecret;
  process.env.NEXT_PUBLIC_SITE_URL = "https://app.example.test";
});

afterAll(async () => {
  if (!world) return;
  const orgs = [alpha().id, beta().id];
  // Remove what this file wrote, in an order the foreign keys allow, before the harness removes the companies.
  for (const t of ["rfqs", "inbound_emails", "integration_mailbox_sync", "integration_sends", "integration_oauth_states", "integration_secrets", "integration_connections"]) {
    await owner(`delete from public.${t} where organization_id = any($1::uuid[])`, [orgs]).catch(() => undefined);
  }
  await destroySyntheticWorld(world.runId);
});

describe("(2) company A with no connection while B is connected", () => {
  it("B connects its own mailbox; A (not connected) gets a null token and no Microsoft provider, never B's", async () => {
    const b = await connect(beta(), "marpet");
    expect(b.outcome).toEqual({ ok: true, mailbox: "office@marpet.example.test", mailRead: true });
    expect(await getDelegatedAccessToken(alpha().id)).toBeNull();
    expect(await sendAs(alpha().id)).toBeNull(); // no Resend configured here: the e-mail would be a draft
    expect(sentWith).toHaveLength(0);
    expect(await sendAs(beta().id)).toBe("microsoft");
    expect(sentWith).toHaveLength(1);
    expect(sentWith[0]).toMatch(bearer("marpet"));
  });
});

describe("(1)+(4) each company connects its own mailbox, stores its own token, and sends only from it", () => {
  it("A connects separately (its own admin, its own state); two connections, two secret rows, ciphertext only, nothing of A's in B's row", async () => {
    sentWith.length = 0;
    const a = await connect(alpha(), "jnr");
    expect(a.outcome).toEqual({ ok: true, mailbox: "office@jnr.example.test", mailRead: true });
    expect(await conn(alpha().id)).toEqual([{ status: "connected", tenant_id: "oid-jnr", tenant_name: "office@jnr.example.test" }]);
    expect(await conn(beta().id)).toEqual([{ status: "connected", tenant_id: "oid-marpet", tenant_name: "office@marpet.example.test" }]);
    const rows = await owner<{ organization_id: string; refresh_token_enc: string; access_token_enc: string }>("select organization_id, refresh_token_enc, access_token_enc from public.integration_secrets where provider='microsoft' and organization_id = any($1::uuid[])", [[alpha().id, beta().id]]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.refresh_token_enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(r.access_token_enc).toMatch(/^v1\./);
      expect(r.refresh_token_enc + r.access_token_enc).not.toContain("EWM-");
    }
    const rowA = rows.find((r) => r.organization_id === alpha().id)!, rowB = rows.find((r) => r.organization_id === beta().id)!;
    expect(decryptSecret(rowA.access_token_enc, ctx(alpha().id, "access"), key)).toMatch(/^EWM-AT-jnr-/);
    expect(decryptSecret(rowB.access_token_enc, ctx(beta().id, "access"), key)).toMatch(/^EWM-AT-marpet-/);
    // A's ciphertext does not open under B's context, in either slot.
    expect(() => decryptSecret(rowA.access_token_enc, ctx(beta().id, "access"), key)).toThrow(/could not be decrypted/);
    expect(() => decryptSecret(rowA.refresh_token_enc, ctx(beta().id, "refresh"), key)).toThrow(/could not be decrypted/);
    // The tables are not readable by an API session at all.
    const apiRead = await wmClient("authenticated", { sub: alpha().users.admin.id, role: "authenticated", aal: "aal2" }).from("integration_secrets").select("refresh_token_enc").maybeSingle();
    expect(apiRead.error?.code).toBe("42501");
  });

  it("with both connected: a send for A carries A's token, a send for B carries B's (real lease, real SQL)", async () => {
    sentWith.length = 0;
    expect(await sendAs(alpha().id)).toBe("microsoft");
    expect(await sendAs(beta().id)).toBe("microsoft");
    expect(sentWith).toHaveLength(2);
    expect(sentWith[0]).toMatch(bearer("jnr"));
    expect(sentWith[1]).toMatch(bearer("marpet"));
    expect(sentWith.filter((a) => /marpet/.test(a))).toHaveLength(1); // exactly one request carried B's token, and it was B's send
  });

  it("A's lease returns only A's row: the lease function for A never yields B's ciphertext", async () => {
    const lease = await service().rpc("integration_token_lease", { p_org: alpha().id, p_provider: "microsoft", p_holder: "00000000-0000-4000-8000-0000000000aa", p_seconds: 30 });
    const row = lease.data as { access_token_enc: string };
    expect(decryptSecret(row.access_token_enc, ctx(alpha().id, "access"), key)).toMatch(/^EWM-AT-jnr-/);
    expect(() => decryptSecret(row.access_token_enc, ctx(beta().id, "access"), key)).toThrow();
    await service().rpc("integration_token_release", { p_org: alpha().id, p_provider: "microsoft", p_holder: "00000000-0000-4000-8000-0000000000aa" });
  });

  it("a ciphertext copied from A's row into B's row does not decrypt for B: B sends nothing, is marked needs_reconnect, A is untouched", async () => {
    sentWith.length = 0;
    const saved = (await owner<{ refresh_token_enc: string; access_token_enc: string; access_expires_at: string }>("select refresh_token_enc, access_token_enc, access_expires_at from public.integration_secrets where organization_id=$1 and provider='microsoft'", [beta().id]))[0];
    await owner(`update public.integration_secrets b set refresh_token_enc=a.refresh_token_enc, access_token_enc=a.access_token_enc, access_expires_at=a.access_expires_at
                 from public.integration_secrets a where a.organization_id=$1 and a.provider='microsoft' and b.organization_id=$2 and b.provider='microsoft'`, [alpha().id, beta().id]);
    expect(await getDelegatedAccessToken(beta().id)).toBeNull();
    await expect(sendAs(beta().id)).rejects.toThrow("Microsoft 365 needs to be connected again"); // fails closed: no send, no fallback
    expect(sentWith).toHaveLength(0);
    expect((await conn(beta().id))[0].status).toBe("needs_reconnect");
    expect((await conn(alpha().id))[0].status).toBe("connected");
    expect(await sendAs(alpha().id)).toBe("microsoft");
    expect(sentWith).toHaveLength(1);
    expect(sentWith[0]).toMatch(bearer("jnr"));
    // Put B's own secret back and let B reconnect through the app's flow.
    await owner("update public.integration_secrets set refresh_token_enc=$1, access_token_enc=$2, access_expires_at=$3 where organization_id=$4 and provider='microsoft'", [saved.refresh_token_enc, saved.access_token_enc, saved.access_expires_at, beta().id]);
    expect((await connect(beta(), "marpet")).outcome).toMatchObject({ ok: true });
    expect((await conn(beta().id))[0].status).toBe("connected");
  });

  it("A needs_reconnect: A gets null (no token, nothing sent), B's token is never used for it; B keeps sending", async () => {
    sentWith.length = 0;
    await service().rpc("integration_mark_needs_reconnect", { p_org: alpha().id, p_provider: "microsoft", p_reason: "wm test" });
    expect(await getDelegatedAccessToken(alpha().id)).toBeNull();
    await expect(sendAs(alpha().id)).rejects.toThrow("Microsoft 365 needs to be connected again"); // fails closed: no send, no fallback
    expect(sentWith).toHaveLength(0);
    expect(await sendAs(beta().id)).toBe("microsoft");
    expect(sentWith[0]).toMatch(bearer("marpet"));
    expect((await connect(alpha(), "jnr")).outcome).toMatchObject({ ok: true }); // A signs in again
    sentWith.length = 0;
    expect(await sendAs(alpha().id)).toBe("microsoft");
    expect(sentWith[0]).toMatch(bearer("jnr"));
  });
});

describe("(5) one mailbox cannot be live-connected to two companies", () => {
  it("the unique index (provider, tenant_id) WHERE status <> 'disconnected' refuses a second live row for the same mailbox", async () => {
    const idx = await owner<{ indexdef: string }>("select indexdef from pg_indexes where indexname='integration_connections_one_company_per_tenant'");
    expect(idx[0].indexdef).toMatch(/UNIQUE INDEX .*\(provider, tenant_id\) WHERE \(status <> 'disconnected'::text\)/);
    const refused = await ownerRefusal("update public.integration_connections set tenant_id='oid-jnr' where organization_id=$1 and provider='microsoft'", [beta().id]);
    expect(refused).toMatchObject({ code: "23505" });
    expect(refused?.message).toContain("integration_connections_one_company_per_tenant");
  });

  it("through the app's Connect: B signing in to A's mailbox is refused (mailbox_in_use); B's own connection and token are unchanged", async () => {
    const before = (await owner<{ access_token_enc: string }>("select access_token_enc from public.integration_secrets where organization_id=$1", [beta().id]))[0];
    const r = await connect(beta(), "jnr", "code:jnr");
    expect(r.outcome).toEqual({ ok: false, reason: "mailbox_in_use" });
    expect(await conn(beta().id)).toEqual([{ status: "connected", tenant_id: "oid-marpet", tenant_name: "office@marpet.example.test" }]);
    expect((await owner<{ access_token_enc: string }>("select access_token_enc from public.integration_secrets where organization_id=$1", [beta().id]))[0]).toEqual(before);
  });

  it("after A disconnects (the app's own Disconnect, as A's admin), B can connect that mailbox; A then cannot take it back", async () => {
    expect((await disconnect(alpha())).error).toBeNull();
    expect((await conn(alpha().id))[0].status).toBe("disconnected");
    expect(await owner("select 1 from public.integration_secrets where organization_id=$1", [alpha().id])).toHaveLength(0); // A's tokens are gone
    expect(await getDelegatedAccessToken(alpha().id)).toBeNull();
    // B is on its own mailbox: it must disconnect it first before moving to another (084's disconnect_first), so use B's own admin to do so.
    expect((await connect(beta(), "jnr", "code:jnr")).outcome).toEqual({ ok: false, reason: "disconnect_first" });
    expect((await disconnect(beta())).error).toBeNull();
    expect((await connect(beta(), "jnr", "code:jnr")).outcome).toMatchObject({ ok: true, mailbox: "office@jnr.example.test" });
    expect((await connect(alpha(), "jnr")).outcome).toEqual({ ok: false, reason: "mailbox_in_use" });
    // Put each company back on its own mailbox for what follows.
    expect((await disconnect(beta())).error).toBeNull();
    expect((await connect(alpha(), "jnr")).outcome).toMatchObject({ ok: true });
    expect((await connect(beta(), "marpet")).outcome).toMatchObject({ ok: true });
    sentWith.length = 0;
    await sendAs(alpha().id); await sendAs(beta().id);
    expect(sentWith[0]).toMatch(bearer("jnr"));
    expect(sentWith[1]).toMatch(bearer("marpet"));
  });
});

describe("(7) the shared app: each company's Connect is its own sign-in, bound to the company, the admin, one use and 10 minutes", () => {
  it("the state in Connect is random, kept only as a hash for (company, admin, provider) with a 10 minute expiry", async () => {
    const url = new URL(await beginMicrosoftConnect(adminClient(alpha()), alpha().id, ready));
    const state = url.searchParams.get("state") ?? "";
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const row = (await owner<{ organization_id: string; user_id: string; state_hash: string; expires_in: number; consumed_at: string | null }>(
      "select organization_id, user_id, state_hash, extract(epoch from (expires_at - now()))::int as expires_in, consumed_at from public.integration_oauth_states where state_hash=$1", [hashState(state)]))[0];
    expect(row).toMatchObject({ organization_id: alpha().id, user_id: alpha().users.admin.id, state_hash: hashState(state), consumed_at: null });
    expect(row.expires_in).toBeGreaterThan(540);
    expect(row.expires_in).toBeLessThanOrEqual(600);
    expect(row.state_hash).not.toBe(state);
  });

  it("the callback of a state started for A, arriving with B's session (B's company and admin), stores nothing for either company", async () => {
    const url = new URL(await beginMicrosoftConnect(adminClient(alpha()), alpha().id, ready));
    const state = url.searchParams.get("state") ?? "";
    const before = await owner("select organization_id, status, tenant_id from public.integration_connections where organization_id = any($1::uuid[]) order by 1", [[alpha().id, beta().id]]);
    const secretsBefore = await owner("select organization_id, access_token_enc from public.integration_secrets where organization_id = any($1::uuid[]) order by 1", [[alpha().id, beta().id]]);
    // The route passes (session company, session user): here B and B's admin.
    await expect(finishMicrosoftConnect(service(), beta().id, beta().users.admin.id, state, "code:marpet", ready, { fetchImpl: msFetch })).rejects.toMatchObject({ hint: "oauth_state_invalid" });
    // The session's user is not an admin of A, and A's admin is not an admin of B: both mismatches refused.
    await expect(finishMicrosoftConnect(service(), alpha().id, beta().users.admin.id, state, "code:marpet", ready, { fetchImpl: msFetch })).rejects.toMatchObject({ code: "42501" });
    await expect(finishMicrosoftConnect(service(), beta().id, alpha().users.admin.id, state, "code:jnr", ready, { fetchImpl: msFetch })).rejects.toBeTruthy();
    expect(await owner("select organization_id, status, tenant_id from public.integration_connections where organization_id = any($1::uuid[]) order by 1", [[alpha().id, beta().id]])).toEqual(before);
    expect(await owner("select organization_id, access_token_enc from public.integration_secrets where organization_id = any($1::uuid[]) order by 1", [[alpha().id, beta().id]])).toEqual(secretsBefore);
    // The state is still unused: A's own admin, in A's session, can complete it, and it is A's mailbox that is stored.
    const ok = await finishMicrosoftConnect(service(), alpha().id, alpha().users.admin.id, state, "code:jnr", ready, { fetchImpl: msFetch });
    expect(ok).toMatchObject({ ok: true, mailbox: "office@jnr.example.test" });
    // Single use: a replay of the same state is refused.
    await expect(finishMicrosoftConnect(service(), alpha().id, alpha().users.admin.id, state, "code:jnr", ready, { fetchImpl: msFetch })).rejects.toMatchObject({ hint: "oauth_state_invalid" });
  });

  it("an admin who belongs to both companies: A's state used in B's session is refused (the state is bound to the company, not just the person)", async () => {
    const url = new URL(await beginMicrosoftConnect(adminClient(alpha()), alpha().id, ready));
    const state = url.searchParams.get("state") ?? "";
    const add = await service().rpc("add_member", { p_org: beta().id, p_email: alpha().users.admin.email, p_role: "admin" });
    expect(add.error).toBeNull();
    try {
      await expect(finishMicrosoftConnect(service(), beta().id, alpha().users.admin.id, state, "code:marpet", ready, { fetchImpl: msFetch })).rejects.toMatchObject({ hint: "oauth_state_invalid" });
      expect((await conn(beta().id))[0].tenant_id).toBe("oid-marpet");
    } finally {
      await owner("delete from public.organization_members where organization_id=$1 and user_id=$2", [beta().id, alpha().users.admin.id]);
    }
  });

  it("an expired state is refused", async () => {
    const url = new URL(await beginMicrosoftConnect(adminClient(alpha()), alpha().id, ready));
    const state = url.searchParams.get("state") ?? "";
    await owner("update public.integration_oauth_states set expires_at = now() - interval '1 second' where state_hash=$1", [hashState(state)]);
    await expect(finishMicrosoftConnect(service(), alpha().id, alpha().users.admin.id, state, "code:jnr", ready, { fetchImpl: msFetch })).rejects.toMatchObject({ hint: "oauth_state_invalid" });
  });
});

describe("(6) inbox: the pass reads each company with its own token and records only into it", () => {
  const inbound = (org: string) => owner<{ graph_message_id: string }>("select graph_message_id from public.inbound_emails where organization_id=$1 order by 1", [org]).then((r) => r.map((x) => x.graph_message_id));
  const sync = (org: string) => owner<{ last_error: string | null; mail_read: boolean; checkpoint: string | null }>("select last_error, mail_read, checkpoint from public.integration_mailbox_sync where organization_id=$1", [org]).then((r) => r[0]);

  it("real SQL pass: A's messages (read with A's token) land in A only, B's in B only; a failing B (Microsoft 403) does not stop A and is only B's error code", async () => {
    // Make sure both companies are connected to their own mailboxes and readable.
    for (const [t, tag] of [[alpha(), "jnr"], [beta(), "marpet"]] as const) if ((await conn(t.id))[0].status !== "connected") await connect(t, tag);
    ms.inbox = {
      jnr: [{ id: "jnr-1", subject: "JNR enquiry 1", at: new Date(Date.now() - 600_000).toISOString() }, { id: "jnr-2", subject: "JNR enquiry 2", at: new Date(Date.now() - 300_000).toISOString() }],
      marpet: [{ id: "marpet-1", subject: "Marpet enquiry", at: new Date(Date.now() - 400_000).toISOString() }],
    };
    ms.inboxStatus = { marpet: 403 }; // B's reading is refused by Microsoft
    ms.inboxAuth = [];
    const first = await runMailboxPollPass({ service: service(), ready, fetchImpl: msFetch, minIntervalSeconds: 0 });
    expect(first).toMatchObject({ companies: 2, checked: 2, failed: 1, inserted: 2 });
    expect(await inbound(alpha().id)).toEqual(["jnr-1", "jnr-2"]);
    expect(await inbound(beta().id)).toEqual([]);
    expect((await sync(alpha().id)).last_error).toBeNull();
    expect((await sync(alpha().id)).checkpoint).not.toBeNull();
    expect(await sync(beta().id)).toMatchObject({ last_error: "consent", mail_read: false });
    // Each Graph call carried exactly one company's token.
    expect(ms.inboxAuth.filter((a) => /EWM-AT-jnr-/.test(a))).toHaveLength(1);
    expect(ms.inboxAuth.filter((a) => /EWM-AT-marpet-/.test(a))).toHaveLength(1);

    // B reads again (consent restored): its message goes to B only; A's rows are unchanged (idempotent, nothing crossed).
    ms.inboxStatus = {};
    await service().rpc("mailbox_sync_connected", { p_org: beta().id, p_mailbox_id: "oid-marpet", p_mail_read: true });
    const second = await runMailboxPollPass({ service: service(), ready, fetchImpl: msFetch, minIntervalSeconds: 0 });
    expect(second.checked).toBe(2);
    expect(await inbound(beta().id)).toEqual(["marpet-1"]);
    expect(await inbound(alpha().id)).toEqual(["jnr-1", "jnr-2"]);
    const subjects = await owner<{ organization_id: string; subject: string }>("select organization_id, subject from public.inbound_emails where organization_id = any($1::uuid[])", [[alpha().id, beta().id]]);
    expect(subjects.filter((s) => s.organization_id === alpha().id).every((s) => s.subject.startsWith("JNR"))).toBe(true);
    expect(subjects.filter((s) => s.organization_id === beta().id).every((s) => s.subject.startsWith("Marpet"))).toBe(true);
  });

  it("mailbox_record_inbound refuses a company whose mailbox is not readable (disconnected): nothing is recorded for it, even while B is readable", async () => {
    expect((await disconnect(alpha())).error).toBeNull();
    const before = await inbound(alpha().id);
    const r = await service().rpc("mailbox_record_inbound", { p_org: alpha().id, p_graph_message_id: "jnr-forged", p_internet_message_id: "<x>", p_from_address: "x@y.test", p_from_name: "x", p_subject: "forged", p_received_at: new Date().toISOString(), p_body_preview: "x", p_body_text: "x" });
    expect(r.error).toMatchObject({ code: "42501", hint: "mailbox_not_readable" });
    expect(await inbound(alpha().id)).toEqual(before);
    const pass = await runMailboxPollPass({ service: service(), ready, fetchImpl: msFetch, minIntervalSeconds: 0 });
    expect(pass.companies).toBe(1); // only B is due
    expect(await getDelegatedAccessToken(alpha().id)).toBeNull();
    expect(await getDelegatedAccessToken(beta().id)).toMatch(/^EWM-AT-marpet-/);
  });
});
