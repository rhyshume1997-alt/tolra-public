/**
 * Migration 133 (working number): G3, the AI assistant, a third feature of the AI helper (101/103/122), on the local stack.
 *
 *   - Off by default: every company reads assistant_enabled FALSE; ai_helper_reserve_assistant is refused (ai_helper_off) even with the
 *     round-up and RFQ on, a key set and room under the cap, and nothing is reserved or logged as requested.
 *   - Only an admin switches it on (ai_helper_set_assistant through 101's caller check): office, workshop, viewer, a support session and
 *     an admin without the second step (company requires it) are refused; the change is audited (ai_helper_settings_updated).
 *   - Its own switch: assistant on does not turn on the round-up or RFQ, and they do not turn it on.
 *   - Roles for asking: office and admin may reserve; workshop and viewer may not.
 *   - The cap (122's 500p default, one guarded UPDATE): an assistant request is reserved BEFORE the model call like the others; no room
 *     or no key is a 'refused' request; 20 at once against room for 10 give exactly 10.
 *   - Two companies: one company's switch changes nothing of the other's; a reserve is always the caller's own company.
 *   - No write path: a signed-in user still cannot write any AI helper table directly, settle stays the service role's.
 *   - 103's ai_helper_reserve is untouched (its body and its two features): 133 replaces no existing function.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 101 suite does.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string; aal?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });
const DIGEST = "c".repeat(64);
const KEY_ENC = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";

const orgs: string[] = [];
async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `133 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-133-${label}-${counter}`]);
  orgs.push(id);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

async function supportMember(db: Client, org: string, p: Person) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
                  values ($1, $2, 'Tolra Support', 'admin', $3, true, false)`, [p.id, p.email, org]);
  await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
  const grant = randomUUID();
  await db.query(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
                  values ($1, $2, 'admin', true, true, now() + interval '2 hours', $3)`, [p.id, org, grant]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [p.session, p.id, org, grant]);
}

/** One API request: its own transaction, as role authenticated with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: p.aal ?? "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

type Result = { ok: true; value: Record<string, unknown> | null } | { ok: false; code: string; hint?: string };
async function call(p: Person, sql: string, params: unknown[] = []): Promise<Result> {
  try {
    const value = await as(p, async (db) => (await db.query<{ v: Record<string, unknown> | null }>(`select ${sql} as v`, params)).rows[0]?.v ?? null);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? "error", hint: (error as { hint?: string }).hint };
  }
}

const setAssistant = (p: Person, on: boolean | null) => call(p, "public.ai_helper_set_assistant($1)", [on]);
const save = (p: Person, roundup: boolean, rfq: boolean, cap: number) => call(p, "public.ai_helper_save_settings($1, $2, $3)", [roundup, rfq, cap]);
const setKey = (p: Person, enc: string | null, last4: string | null) => call(p, "public.ai_helper_set_key($1, $2)", [enc, last4]);
/** 103's reserve, unchanged by 133 (roundup and rfq only). */
const reserve = (p: Person, feature: string, estimate: number) => call(p, "public.ai_helper_reserve($1, $2, $3, $4)", [feature, estimate, DIGEST, 100]);
/** 133's reserve for the assistant. */
const reserveAssistant = (p: Person, estimate: number) => call(p, "public.ai_helper_reserve_assistant($1, $2, $3)", [estimate, DIGEST, 100]);

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const switches = async (org: string) => (await sql<{ roundup_enabled: boolean; rfq_enabled: boolean; assistant_enabled: boolean }>(
  "select roundup_enabled, rfq_enabled, assistant_enabled from public.ai_helper_settings where organization_id = $1", [org]))[0] ?? null;
const requests = (org: string, feature: string) => sql<{ status: string; refusal: string | null; reserved_pence: number }>(
  "select status, refusal, reserved_pence from public.ai_helper_requests where organization_id = $1 and feature = $2 order by created_at, id", [org, feature]);
const audit = (org: string, action: string) => sql<{ metadata: Record<string, unknown>; actor_user_id: string }>(
  "select metadata, actor_user_id from security_audit.audit_log where organization_id = $1 and action = $2 order by created_at, id", [org, action]);

/** The company's admin MFA requirement, set as setRequireAdminMfaForTest does (its guard trigger skipped for the test only). */
const requireAdminMfa = (org: string, value: boolean) => withDb(async (db) => {
  await db.query("begin");
  await db.query("set local session_replication_role = replica");
  await db.query("update public.organizations set require_admin_mfa = $2 where id = $1", [org, value]);
  await db.query("commit");
});

const A = { admin: person("a-admin"), office: person("a-office"), workshop: person("a-workshop"), viewer: person("a-viewer"), support: person("a-support") };
const B = { admin: person("b-admin"), office: person("b-office") };
let orgA = "";
let orgB = "";

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    orgA = await makeOrg(db, "alpha");
    orgB = await makeOrg(db, "beta");
    await member(db, orgA, A.admin, "admin");
    await member(db, orgA, A.office, "office");
    await member(db, orgA, A.workshop, "workshop");
    await member(db, orgA, A.viewer, "viewer");
    await supportMember(db, orgA, A.support);
    await member(db, orgB, B.admin, "admin");
    await member(db, orgB, B.office, "office");
  });
});

afterAll(async () => {
  const people = [...Object.values(A), ...Object.values(B)].map((p) => p.id);
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    for (const t of ["public.ai_helper_requests", "public.ai_helper_usage", "public.ai_helper_secrets", "public.ai_helper_settings", "security_audit.audit_log",
      "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from security_audit.platform_admins where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

describe("133: the assistant is off by default and only an admin switches it on", () => {
  it("the column is NOT NULL DEFAULT FALSE and no existing company has it on", async () => {
    expect(await sql("select is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'ai_helper_settings' and column_name = 'assistant_enabled'"))
      .toEqual([{ is_nullable: "NO", column_default: "false" }]);
    expect(await sql("select 1 from public.ai_helper_settings where assistant_enabled")).toHaveLength(0);
  });

  it("off: ai_helper_reserve_assistant refused even with the round-up and RFQ on, a key and room under the cap; nothing is reserved", async () => {
    expect(await save(A.admin, true, true, 500)).toMatchObject({ ok: true });
    expect(await setKey(A.admin, KEY_ENC, "WXYZ")).toMatchObject({ ok: true });
    expect(await switches(orgA)).toEqual({ roundup_enabled: true, rfq_enabled: true, assistant_enabled: false });
    for (const p of [A.admin, A.office]) expect(await reserveAssistant(p, 5)).toMatchObject({ ok: false, code: "42501", hint: "ai_helper_off" });
    expect(await requests(orgA, "assistant")).toEqual([]);
    expect(await audit(orgA, "ai_helper_requested")).toEqual([]);
    // The other two features still reserve (control).
    expect(await reserve(A.office, "roundup", 1)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("office, workshop, viewer and a support session cannot switch it on; nor can an admin without the second step", async () => {
    for (const p of [A.office, A.workshop, A.viewer, A.support]) expect(await setAssistant(p, true)).toMatchObject({ ok: false, code: "42501" });
    await requireAdminMfa(orgA, true);
    expect(await setAssistant({ ...A.admin, aal: "aal1" }, true)).toMatchObject({ ok: false, code: "42501" });
    await requireAdminMfa(orgA, false);
    expect((await switches(orgA))?.assistant_enabled).toBe(false);
    expect(await setAssistant(A.admin, null)).toMatchObject({ ok: false, code: "22023" });
  });

  it("the admin switches it on: audited; it does not change the round-up or RFQ, and they do not change it", async () => {
    expect(await setAssistant(A.admin, true)).toEqual({ ok: true, value: { assistant_enabled: true } });
    expect(await switches(orgA)).toEqual({ roundup_enabled: true, rfq_enabled: true, assistant_enabled: true });
    const events = await audit(orgA, "ai_helper_settings_updated");
    expect(events.at(-1)).toMatchObject({ actor_user_id: A.admin.id, metadata: { assistant_enabled: true, source: "ai_helper" } });
    expect(await save(A.admin, false, false, 500)).toMatchObject({ ok: true });
    expect(await switches(orgA)).toEqual({ roundup_enabled: false, rfq_enabled: false, assistant_enabled: true });
    expect(await reserve(A.office, "rfq", 1)).toMatchObject({ ok: false, code: "42501", hint: "ai_helper_off" });
  });
});

describe("133: asking (ai_helper_reserve_assistant) once it is on", () => {
  it("office and admin reserve an assistant request; workshop and viewer cannot", async () => {
    const r = await reserveAssistant(A.office, 5);
    expect(r).toMatchObject({ ok: true, value: { ok: true } });
    expect(JSON.stringify(r)).not.toContain("key_enc");
    expect(await reserveAssistant(A.admin, 5)).toMatchObject({ ok: true, value: { ok: true } });
    for (const p of [A.workshop, A.viewer, A.support]) expect(await reserveAssistant(p, 5)).toMatchObject({ ok: false, code: "42501" });
    expect((await requests(orgA, "assistant")).map((x) => x.status)).toEqual(["reserved", "reserved"]);
    expect((await audit(orgA, "ai_helper_requested")).filter((e) => e.metadata.feature === "assistant")).toHaveLength(2);
  });

  it("the cap: no room is a refused request with nothing reserved; 20 at once against room for 10 give exactly 10", async () => {
    await sql("update public.ai_helper_requests set status = 'expired', settled_at = now() where organization_id = $1 and status = 'reserved'", [orgA]);
    await sql("update public.ai_helper_usage set reserved_pence = 0, spent_pence = 0 where organization_id = $1", [orgA]);
    expect(await save(A.admin, false, false, 10)).toMatchObject({ ok: true });
    const before = (await requests(orgA, "assistant")).length;
    expect(await reserveAssistant(A.office, 11)).toMatchObject({ ok: true, value: { ok: false, reason: "cap" } });
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveAssistant(A.office, 1)));
    expect(results.filter((x) => x.ok && x.value?.ok === true)).toHaveLength(10);
    expect(results.filter((x) => x.ok && x.value?.reason === "cap")).toHaveLength(10);
    const ledger = (await sql<{ reserved_pence: number; spent_pence: number }>("select reserved_pence, spent_pence from public.ai_helper_usage where organization_id = $1", [orgA]))[0];
    expect(ledger.reserved_pence + ledger.spent_pence).toBeLessThanOrEqual(10);
    const after = await requests(orgA, "assistant");
    expect(after.slice(before).filter((x) => x.status === "refused").every((x) => x.refusal === "cap" && x.reserved_pence === 0)).toBe(true);
  });

  it("no key: a refused request (no_key), nothing reserved", async () => {
    expect(await setKey(A.admin, null, null)).toMatchObject({ ok: true });
    expect(await reserveAssistant(A.office, 1)).toMatchObject({ ok: true, value: { ok: false, reason: "no_key" } });
  });
});

describe("133: two companies, no write path", () => {
  it("company A's switch changes nothing of B's; B's office is refused while B is off; reserve is always the caller's company", async () => {
    expect(await switches(orgB)).toBeNull();
    expect(await reserveAssistant(B.office, 1)).toMatchObject({ ok: false, code: "42501", hint: "ai_helper_off" });
    expect(await setAssistant(B.admin, true)).toMatchObject({ ok: true });
    expect((await switches(orgA))?.assistant_enabled).toBe(true);
    expect(await setAssistant(B.admin, false)).toMatchObject({ ok: true });
    expect((await switches(orgA))?.assistant_enabled).toBe(true);
    expect(await sql("select 1 from public.ai_helper_requests where organization_id = $1 and feature = 'assistant'", [orgB])).toEqual([]);
  });

  it("nobody signed in can write the switch or the log directly; settle stays the service role's", async () => {
    for (const [text, params] of [
      ["update public.ai_helper_settings set assistant_enabled = true where organization_id = $1", [orgB]],
      ["insert into public.ai_helper_requests (organization_id, user_id, feature, month, status, input_digest, input_bytes) values ($1, $2, 'assistant', date_trunc('month', now())::date, 'suggested', $3, 1)", [orgA, A.admin.id, DIGEST]],
      ["select public.ai_helper_settle(gen_random_uuid(), 'suggested', null, 0, null, '{}'::jsonb)", []],
    ] as const) {
      await expect(as(A.admin, (db) => db.query(text, [...params]))).rejects.toMatchObject({ code: "42501" });
    }
    expect((await switches(orgB))?.assistant_enabled).toBe(false);
  });

  it("103's ai_helper_reserve is untouched: it still refuses 'assistant' (and any unknown feature) as invalid", async () => {
    expect(await reserve(A.office, "assistant", 1)).toMatchObject({ ok: false, code: "22023" });
    expect(await reserve(A.office, "chat", 1)).toMatchObject({ ok: false, code: "22023" });
    expect((await sql<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')"))[0].v)
      .toBe("c75e470a73e4d0e7508a27125f6f9e9c");
  });
});
