/**
 * Migration 103: the AI helper's key and settle are the server's (pre-go-live security review, S2/S3).
 *
 *   - ai_helper_reserve's answer carries no key (it is { ok, request_id }).
 *   - No signed-in user may execute ai_helper_settle: not the requester, not an admin, not another company (privilege and a real call,
 *     in SQL and through the API); nothing is settled by them. The service role settles once; the actual cost moves to spent and the
 *     audit row names the person who asked. The service role reads the key table; no signed-in user can.
 *   - supabase/verify/ai_helper_service_role_103.sql answers TRUE on every row; 101's verify passes with 103 and after its rollback;
 *     the rollback puts 101's bodies and settle grant back (inside a transaction that is rolled back) and the release applies again.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 093 and 101 suites do; then the two synthetic
 * companies through PostgREST.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });
const KEY_ENC = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";
const DIGEST = "c".repeat(64);

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `103 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-103-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false)`, [p.id, p.email, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request as the person (role authenticated, their claims), in its own transaction. */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/** One call as the server's service role (no person), in its own transaction. */
async function asService<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { code?: string; message: string; hint?: string };
  }
};
const rows = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);

const W = { A: "", C: "", aAdmin: person("a-admin"), aOffice: person("a-office"), cOffice: person("c-office") };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.C = await makeOrg(db, "c");
    await member(db, W.A, W.aAdmin, "admin");
    await member(db, W.A, W.aOffice, "office");
    await member(db, W.C, W.cOffice, "office");
    await db.query("insert into public.ai_helper_settings (organization_id, rfq_enabled, monthly_cap_pence) values ($1, true, 500)", [W.A]);
    await db.query("insert into public.ai_helper_secrets (organization_id, api_key_enc) values ($1, $2)", [W.A, KEY_ENC]);
  });
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

describe("S2/S3 in SQL: the AI helper key and settle", () => {
  let request = "";

  it("reserve's answer carries no key", async () => {
    const value = await as(W.aOffice, async (db) => (await db.query<{ v: Record<string, unknown> }>("select public.ai_helper_reserve('rfq', 5, $1, 10) as v", [DIGEST])).rows[0].v);
    expect(value).toMatchObject({ ok: true });
    expect(Object.keys(value).sort()).toEqual(["ok", "request_id"]);
    expect(JSON.stringify(value)).not.toContain(KEY_ENC);
    request = String(value.request_id);
  });

  it("no signed-in user may execute settle: not the requester, an admin or another company (privilege and a real call); nothing is settled", async () => {
    const [grants] = await rows<{ anon: boolean; authed: boolean; service: boolean; pub: boolean }>(
      "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authed, " +
      "has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service, " +
      "exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub",
      ["public.ai_helper_settle(uuid,text,text,integer,text,jsonb)"]);
    expect(grants).toEqual({ anon: false, authed: false, service: true, pub: false });
    for (const p of [W.aOffice, W.aAdmin, W.cOffice]) {
      expect(await errorOf(as(p, (db) => db.query("select public.ai_helper_settle($1, 'suggested', null, 0, 'made-up-model', '{\"kind\": \"rfq\", \"lines\": []}'::jsonb)", [request]))))
        .toMatchObject({ code: "42501", message: expect.stringMatching(/^permission denied for function ai_helper_settle/) });
    }
    expect((await rows<{ status: string }>("select status from public.ai_helper_requests where id = $1", [request]))[0].status).toBe("reserved");
    expect(await rows("select 1 from security_audit.audit_log where entity_id = $1 and action = 'ai_helper_suggested'", [request])).toEqual([]);
  });

  it("the service role settles once: actual cost to spent, the audit row names the person who asked; the key is readable by it only", async () => {
    await asService((db) => db.query("select public.ai_helper_settle($1, 'suggested', null, 3, 'claude-opus-5-5', '{\"kind\": \"rfq\", \"lines\": [{}]}'::jsonb)", [request]));
    expect((await rows("select status, cost_pence, model from public.ai_helper_requests where id = $1", [request]))[0]).toEqual({ status: "suggested", cost_pence: 3, model: "claude-opus-5-5" });
    expect((await rows<{ reserved_pence: number; spent_pence: number }>("select reserved_pence, spent_pence from public.ai_helper_usage where organization_id = $1", [W.A]))[0])
      .toEqual({ reserved_pence: 0, spent_pence: 3 });
    const audit = await rows<{ actor_user_id: string; actor_email: string; metadata: Record<string, unknown> }>(
      "select actor_user_id, actor_email, metadata from security_audit.audit_log where entity_id = $1 and action = 'ai_helper_suggested'", [request]);
    expect(audit).toEqual([{ actor_user_id: W.aOffice.id, actor_email: W.aOffice.email, metadata: { feature: "rfq", model: "claude-opus-5-5", cost_pence: 3, lines: 1, source: "ai_helper" } }]);
    // Once only; a bad shape is refused.
    expect(await errorOf(asService((db) => db.query("select public.ai_helper_settle($1, 'failed', 'invalid', 0, null, null)", [request])))).toMatchObject({ code: "42501" });
    expect(await errorOf(asService((db) => db.query("select public.ai_helper_settle($1, 'suggested', 'invalid', 0, null, '{}'::jsonb)", [request])))).toMatchObject({ code: "22023" });
    expect(await asService(async (db) => (await db.query<{ k: string }>("select api_key_enc as k from public.ai_helper_secrets where organization_id = $1", [W.A])).rows)).toEqual([{ k: KEY_ENC }]);
    for (const p of [W.aAdmin, W.cOffice]) expect(await errorOf(as(p, (db) => db.query("select api_key_enc from public.ai_helper_secrets")))).toMatchObject({ code: "42501" });
  });
});

describe("two companies through the API (alpha, beta)", () => {
  let world: SyntheticWorld;
  const c = {} as Record<"alphaAdmin" | "alphaOffice" | "betaAdmin" | "betaOffice", SupabaseClient>;
  const service = () => adminClient();

  beforeAll(async () => {
    world = await createSyntheticWorld();
    c.alphaAdmin = await signedInClient(world.tenants.alpha.users.admin);
    c.alphaOffice = await signedInClient(world.tenants.alpha.users.office);
    c.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    c.betaOffice = await signedInClient(world.tenants.beta.users.office);
    await withDb(async (db) => {
      for (const org of [world.tenants.alpha.id, world.tenants.beta.id]) {
        await db.query("insert into public.ai_helper_settings (organization_id, rfq_enabled, monthly_cap_pence) values ($1, true, 100)", [org]);
        await db.query("insert into public.ai_helper_secrets (organization_id, api_key_enc) values ($1, $2)", [org, KEY_ENC]);
      }
    });
  });

  afterAll(async () => {
    if (world) await destroySyntheticWorld(world.runId);
  });

  it("reserve's answer carries no key in either company; nobody signed in, in either company, can settle alpha's request; the service role can", async () => {
    for (const client of [c.alphaOffice, c.betaOffice]) {
      const reserved = await client.rpc("ai_helper_reserve", { p_feature: "rfq", p_estimate_pence: 1, p_input_digest: "d".repeat(64), p_input_bytes: 1 });
      expect(reserved.error).toBeNull();
      expect(Object.keys(reserved.data as Record<string, unknown>).sort()).toEqual(["ok", "request_id"]);
      expect(JSON.stringify(reserved.data)).not.toContain(KEY_ENC);
    }
    const reserved = await c.alphaOffice.rpc("ai_helper_reserve", { p_feature: "rfq", p_estimate_pence: 1, p_input_digest: "e".repeat(64), p_input_bytes: 1 });
    const id = (reserved.data as { request_id: string }).request_id;
    for (const client of Object.values(c)) {
      const settled = await client.rpc("ai_helper_settle", { p_request: id, p_status: "suggested", p_failure: null, p_cost_pence: 0, p_model: "made-up", p_output: { kind: "rfq", lines: [] } });
      expect(settled.error).toMatchObject({ code: "42501" });
    }
    expect((await service().from("ai_helper_requests").select("status").eq("id", id).single()).data).toEqual({ status: "reserved" });
    expect((await service().rpc("ai_helper_settle", { p_request: id, p_status: "failed", p_failure: "unavailable", p_cost_pence: 0, p_model: null, p_output: null })).error).toBeNull();
    expect((await service().from("ai_helper_requests").select("status").eq("id", id).single()).data).toEqual({ status: "failed" });
  });

  it("the key table: no signed-in user of either company reads it", async () => {
    for (const client of Object.values(c)) expect((await client.from("ai_helper_secrets").select("api_key_enc")).error).not.toBeNull();
  });
});

describe("103 release files on the local stack", () => {
  it("the verify script answers TRUE on every row, and so does 101's", async () => {
    const result = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/ai_helper_service_role_103.sql"))).rows);
    expect(result).toHaveLength(4);
    expect(result.filter((r) => !r.ok)).toEqual([]);
    const v101 = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/ai_helper_101.sql"))).rows);
    // 122 makes the cap default 500, so 101's off_by_default row reads FALSE by design; 122's own verify checks the new default.
    expect(v101.filter((r) => !r.ok).map((r) => r.check_name)).toEqual(["off_by_default"]);
    const v122 = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/ai_helper_cap_default_122.sql"))).rows);
    expect(v122).toHaveLength(3);
    expect(v122.filter((r) => !r.ok)).toEqual([]);
  });

  it("the rollback puts 101's bodies and settle grant back; the release then applies again, twice (all rolled back)", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        // 122 (cap default 500) sits on top of 101: take it away first, as 101's own verify (cap default 0) is checked below.
        await db.query(unwrapped(read("supabase/release/122_ai_helper_cap_default.rollback.sql")));
        await db.query(unwrapped(read("supabase/release/103_ai_helper_service_role.rollback.sql")));
        const after = Object.fromEntries((await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/ai_helper_service_role_103.sql"))).rows.map((r) => [r.check_name, r.ok]));
        expect(after).toMatchObject({ reserve_returns_no_key: false, settle_service_role_only: false, secrets_service_role_only: true, other_app_functions_signed_in_only: true });
        expect((await db.query("select has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE') as v")).rows[0].v).toBe(true);
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/ai_helper_101.sql"))).rows.every((r) => r.ok)).toBe(true);
        // 102 is untouched by 103's rollback.
        expect((await db.query<{ ok: boolean }>(read("supabase/verify/security_guards_102.sql"))).rows.every((r) => r.ok)).toBe(true);
        for (let i = 0; i < 2; i += 1) {
          await db.query(unwrapped(read("supabase/release/103_ai_helper_service_role.release.sql")));
          expect((await db.query<{ ok: boolean }>(read("supabase/verify/ai_helper_service_role_103.sql"))).rows.every((r) => r.ok)).toBe(true);
        }
      } finally {
        await db.query("rollback");
      }
    });
  });
});
