/**
 * Migration 101 (working number): the AI admin helper's tables and functions, on the local stack.
 *
 *   - Off by default: a new company's status has both features off, no cap and no key; reserve refuses while a feature is off.
 *   - Roles: office and admin may reserve, settle and decide; only admin may change settings or the key; workshop and viewer get
 *     nothing; a support session gets nothing; an admin without the second step (company requires it) gets nothing.
 *   - The cap: reserved BEFORE the call in one guarded UPDATE: 20 requests at once against room for 10 give exactly 10, and the ledger
 *     never passes the cap; settle moves the actual cost (never above the reservation) to spent; a reservation left open over 10
 *     minutes is released; no key or no room is a 'refused' request and no reservation.
 *   - Decisions: once; approved only with a draft quote of the same company made after the suggestion; one quote per suggestion.
 *   - Audit: every request, refusal, suggestion, failure, approval, rejection and settings change writes its event (ids, feature,
 *     pence, counts only); the app's write_audit still refuses these names, so a client can't make one up.
 *   - Two companies: neither can read the other's settings, key, ledger or requests, nor settle or decide the other's requests; the
 *     key table can't be read by anyone signed in.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 095 suite does.
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
const DIGEST = "a".repeat(64);
const KEY_ENC = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";

const orgs: string[] = [];
async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `101 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-101-${label}-${counter}`]);
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

/** A platform owner's live support membership of `org`, chosen for the session under its grant (036). */
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

/** One function call as the person: its JSON answer, or the SQLSTATE it raised. */
async function call(p: Person, sql: string, params: unknown[] = []): Promise<{ ok: true; value: Record<string, unknown> | null } | { ok: false; code: string; hint?: string }> {
  try {
    const value = await as(p, async (db) => (await db.query<{ v: Record<string, unknown> | null }>(`select ${sql} as v`, params)).rows[0]?.v ?? null);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? "error", hint: (error as { hint?: string }).hint };
  }
}

const status = (p: Person) => call(p, "public.ai_helper_status()");
const save = (p: Person, roundup: boolean, rfq: boolean, cap: number) => call(p, "public.ai_helper_save_settings($1, $2, $3)", [roundup, rfq, cap]);
const setKey = (p: Person, enc: string | null, last4: string | null) => call(p, "public.ai_helper_set_key($1, $2)", [enc, last4]);
const reserve = (p: Person, feature: string, estimate: number) => call(p, "public.ai_helper_reserve($1, $2, $3, $4)", [feature, estimate, DIGEST, 100]);
const settle = (p: Person, id: unknown, statusName: string, failure: string | null, cost: number, output: unknown) =>
  call(p, "to_jsonb(public.ai_helper_settle($1, $2, $3, $4, $5, $6))", [id, statusName, failure, cost, "claude-opus-5-5", output === null ? null : JSON.stringify(output)]);
const decide = (p: Person, id: unknown, decision: string, quote: string | null) => call(p, "to_jsonb(public.ai_helper_decide($1, $2, $3))", [id, decision, quote]);

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const audit = (org: string, action: string) => sql<{ entity_id: string; metadata: Record<string, unknown>; actor_user_id: string }>(
  "select entity_id, metadata, actor_user_id from security_audit.audit_log where organization_id = $1 and action = $2 order by created_at, id", [org, action]);
const usage = (org: string) => sql<{ reserved_pence: number; spent_pence: number }>("select reserved_pence, spent_pence from public.ai_helper_usage where organization_id = $1", [org]);

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
      "public.quotes", "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from security_audit.platform_admins where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

describe("101: off by default, roles", () => {
  it("a new company: both features off, no cap, no key; reserve refuses while off", async () => {
    // No settings row at all (nothing is inserted by the migration or by a status read): it reads as off with a cap of 0.
    expect(await sql("select 1 from public.ai_helper_settings where organization_id = $1", [orgA])).toHaveLength(0);
    expect(await sql<{ v: unknown }>("select column_default as v from information_schema.columns where table_schema = 'public' and table_name = 'ai_helper_settings' and column_name in ('roundup_enabled', 'rfq_enabled', 'monthly_cap_pence') order by column_name"))
      .toEqual([{ v: "0" }, { v: "false" }, { v: "false" }]);
    expect(await reserve(A.admin, "roundup", 1)).toMatchObject({ ok: false, code: "42501", hint: "ai_helper_off" });
    expect(await status(A.office)).toEqual({ ok: true, value: { roundup_enabled: false, rfq_enabled: false, monthly_cap_pence: 0, key_set: false, key_last4: null, month_spent_pence: 0, month_reserved_pence: 0, can_manage: false } });
    expect(await reserve(A.office, "rfq", 5)).toMatchObject({ ok: false, code: "42501", hint: "ai_helper_off" });
    expect(await sql("select 1 from public.ai_helper_requests where organization_id = $1", [orgA])).toHaveLength(0);
    expect(await sql("select 1 from public.ai_helper_settings where organization_id = $1", [orgA])).toHaveLength(0);
  });

  it("workshop and viewer get nothing from any function; office may not change settings or the key", async () => {
    for (const p of [A.workshop, A.viewer]) {
      for (const r of [await status(p), await reserve(p, "rfq", 1), await save(p, true, true, 100), await setKey(p, KEY_ENC, "WXYZ"), await settle(p, randomUUID(), "failed", "invalid", 0, null), await decide(p, randomUUID(), "rejected", null)]) {
        expect(r).toMatchObject({ ok: false, code: "42501" });
      }
    }
    expect(await save(A.office, true, true, 100)).toMatchObject({ ok: false, code: "42501" });
    expect(await setKey(A.office, KEY_ENC, "WXYZ")).toMatchObject({ ok: false, code: "42501" });
  });

  it("nobody signed in can write the tables directly or read the key table", async () => {
    for (const statement of [
      ["insert into public.ai_helper_settings (organization_id, rfq_enabled) values ($1, true)", [orgA]],
      ["update public.ai_helper_usage set spent_pence = 0 where organization_id = $1", [orgA]],
      ["delete from public.ai_helper_requests where organization_id = $1", [orgA]],
      ["select * from public.ai_helper_secrets", []],
      ["select public._ai_helper_audit($1, 'ai_helper_approved', 'ai_helper_requests', 'x', '{}'::jsonb)", [orgA]],
    ] as const) {
      await expect(as(A.admin, (db) => db.query(statement[0], [...statement[1]]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("admin turns features on, sets the cap and the key (only the last four come back); every change is audited", async () => {
    expect(await save(A.admin, true, true, 100)).toMatchObject({ ok: true, value: { roundup_enabled: true, rfq_enabled: true, monthly_cap_pence: 100, key_set: false } });
    expect(await setKey(A.admin, "sk-ant-plain-text-key", "WXYZ")).toMatchObject({ ok: false, code: "22023" });
    expect(await setKey(A.admin, KEY_ENC, "WXYZ")).toMatchObject({ ok: true, value: { key_set: true, key_last4: "WXYZ" } });
    expect(await status(A.office)).toMatchObject({ ok: true, value: { key_set: true, key_last4: null } });
    expect((await audit(orgA, "ai_helper_settings_updated"))[0].metadata).toEqual({ roundup_enabled: true, rfq_enabled: true, monthly_cap_pence: 100, source: "ai_helper" });
    expect(await audit(orgA, "ai_helper_key_set")).toHaveLength(1);
    expect(JSON.stringify(await sql("select old_data, new_data, metadata from security_audit.audit_log where organization_id = $1", [orgA]))).not.toContain(KEY_ENC);
  });

  it("a support session and an admin without the second step get nothing", async () => {
    expect(await reserve(A.support, "rfq", 1)).toMatchObject({ ok: false, code: "42501" });
    expect(await status(A.support)).toMatchObject({ ok: false, code: "42501" });
    // Set as the database owner with triggers off: 065's guard refuses the switch while an admin has no authenticator app.
    const mfa = (on: boolean) => withDb(async (db) => {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("update public.organizations set require_admin_mfa = $2 where id = $1", [orgA, on]);
      await db.query("commit");
    });
    await mfa(true);
    const aal1 = { ...A.admin, aal: "aal1" };
    expect(await reserve(aal1, "rfq", 1)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(aal1, false, false, 0)).toMatchObject({ ok: false, code: "42501" });
    await mfa(false);
  });
});

describe("101: the cap", () => {
  it("reserve hands back the key and a request id, audited; settle moves the actual cost (never above the reservation) to spent", async () => {
    const r = await reserve(A.office, "rfq", 10);
    expect(r).toMatchObject({ ok: true, value: { ok: true, key_enc: KEY_ENC } });
    const id = (r as unknown as { value: { request_id: string } }).value.request_id;
    expect(await usage(orgA)).toEqual([{ reserved_pence: 10, spent_pence: 0 }]);
    expect((await audit(orgA, "ai_helper_requested")).at(-1)).toMatchObject({ entity_id: id, actor_user_id: A.office.id, metadata: { feature: "rfq", estimate_pence: 10, input_bytes: 100 } });
    // Someone else (even an admin) can't settle it; a bad shape is refused.
    expect(await settle(A.admin, id, "suggested", null, 1, { kind: "rfq", lines: [] })).toMatchObject({ ok: false, code: "42501" });
    expect(await settle(A.office, id, "suggested", "invalid", 1, { lines: [] })).toMatchObject({ ok: false, code: "22023" });
    expect(await settle(A.office, id, "suggested", null, 99, { kind: "rfq", lines: [{}, {}] })).toMatchObject({ ok: true });
    expect(await usage(orgA)).toEqual([{ reserved_pence: 0, spent_pence: 10 }]);
    expect((await audit(orgA, "ai_helper_suggested")).at(-1)?.metadata).toEqual({ feature: "rfq", model: "claude-opus-5-5", cost_pence: 10, lines: 2, source: "ai_helper" });
    // Once only.
    expect(await settle(A.office, id, "failed", "invalid", 0, null)).toMatchObject({ ok: false, code: "42501" });
  });

  it("20 requests at once against room for 9 give exactly 9; the ledger never passes the cap; the rest are refused and audited", async () => {
    const before = (await usage(orgA))[0];
    const room = 100 - before.spent_pence - before.reserved_pence; // 90
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(A.office, "rfq", 10)));
    const passed = results.filter((r) => r.ok && (r.value as { ok: boolean }).ok);
    const refused = results.filter((r) => r.ok && !(r.value as { ok: boolean }).ok);
    expect(passed).toHaveLength(Math.floor(room / 10));
    expect(refused).toHaveLength(20 - passed.length);
    for (const r of refused) expect((r as unknown as { value: Record<string, unknown> }).value).toMatchObject({ ok: false, reason: "cap" });
    const after = (await usage(orgA))[0];
    expect(after.reserved_pence + after.spent_pence).toBeLessThanOrEqual(100);
    expect(after.reserved_pence).toBe(passed.length * 10);
    expect((await audit(orgA, "ai_helper_refused")).length).toBeGreaterThanOrEqual(refused.length);
    // Failed calls settle at what they cost (here nothing); the reservations come back.
    for (const r of passed) await settle(A.office, (r as unknown as { value: { request_id: string } }).value.request_id, "failed", "unavailable", 0, null);
    expect((await usage(orgA))[0]).toEqual({ reserved_pence: 0, spent_pence: before.spent_pence });
    expect((await audit(orgA, "ai_helper_failed")).at(-1)?.metadata).toMatchObject({ reason: "unavailable", cost_pence: 0 });
  });

  it("two requests at once against a cap that fits only one: exactly one passes, every time; the other is refused 'cap'", async () => {
    for (let round = 0; round < 10; round += 1) {
      const used = (await usage(orgA))[0];
      expect(await save(A.admin, true, true, used.spent_pence + used.reserved_pence + 10)).toMatchObject({ ok: true });
      const pair = await Promise.all([reserve(A.office, "rfq", 10), reserve(A.admin, "rfq", 10)]);
      const passed = pair.filter((r) => r.ok && (r.value as { ok: boolean }).ok);
      expect(passed, `round ${round}`).toHaveLength(1);
      expect(pair.filter((r) => r.ok && (r.value as { ok: boolean; reason?: string }).reason === "cap"), `round ${round}`).toHaveLength(1);
      const after = (await usage(orgA))[0];
      expect(after.spent_pence + after.reserved_pence).toBe(used.spent_pence + used.reserved_pence + 10);
      const winner = pair.indexOf(passed[0]) === 0 ? A.office : A.admin;
      await settle(winner, (passed[0] as unknown as { value: { request_id: string } }).value.request_id, "failed", "unavailable", 0, null);
    }
    expect(await save(A.admin, true, true, 100)).toMatchObject({ ok: true });
  });

  it("a reservation left open over 10 minutes is released by the next reserve; its late answer still records the spend", async () => {
    const r = await reserve(A.office, "roundup", 5);
    const id = (r as unknown as { value: { request_id: string } }).value.request_id;
    await sql("update public.ai_helper_requests set created_at = now() - interval '11 minutes' where id = $1", [id]);
    const next = await reserve(A.office, "roundup", 5);
    expect((await sql<{ status: string }>("select status from public.ai_helper_requests where id = $1", [id]))[0].status).toBe("expired");
    expect((await usage(orgA))[0].reserved_pence).toBe(5);
    expect(await settle(A.office, id, "suggested", null, 3, { kind: "roundup" })).toMatchObject({ ok: true });
    expect((await usage(orgA))[0].reserved_pence).toBe(5);
    await settle(A.office, (next as unknown as { value: { request_id: string } }).value.request_id, "failed", "unavailable", 0, null);
  });

  it("no key: refused before any reservation", async () => {
    await withDb(async (db) => {
      await db.query("insert into public.ai_helper_settings (organization_id, rfq_enabled, monthly_cap_pence) values ($1, true, 500)", [orgB]);
    });
    expect(await reserve(B.office, "rfq", 5)).toMatchObject({ ok: true, value: { ok: false, reason: "no_key" } });
    expect(await usage(orgB)).toEqual([]);
    // The round-up switch is still off for beta.
    expect(await reserve(B.office, "roundup", 5)).toMatchObject({ ok: false, hint: "ai_helper_off" });
  });
});

describe("101: decisions and audit", () => {
  let suggestion = "";
  let quote = "";
  beforeAll(async () => {
    const r = await reserve(A.office, "rfq", 5);
    suggestion = (r as unknown as { value: { request_id: string } }).value.request_id;
    await settle(A.office, suggestion, "suggested", null, 1, { kind: "rfq", lines: [{}] });
    quote = (await sql<{ id: string }>("insert into public.quotes (organization_id, quote_ref, customer, status) values ($1, $2, 'Acme', 'draft') returning id", [orgA, `QUO-AI-${run}`]))[0].id;
  });

  it("approved needs a draft quote of the same company made after the suggestion", async () => {
    const old = (await sql<{ id: string }>("insert into public.quotes (organization_id, quote_ref, customer, status, created_at) values ($1, $2, 'Acme', 'draft', now() - interval '1 day') returning id", [orgA, `QUO-OLD-${run}`]))[0].id;
    const betaQuote = (await sql<{ id: string }>("insert into public.quotes (organization_id, quote_ref, customer, status) values ($1, $2, 'Beta', 'draft') returning id", [orgB, `QUO-B-${run}`]))[0].id;
    for (const q of [old, betaQuote, randomUUID()]) expect(await decide(A.office, suggestion, "approved", q)).toMatchObject({ ok: false, code: "42501" });
    expect(await decide(A.office, suggestion, "approved", null)).toMatchObject({ ok: false, code: "22023" });
    expect(await decide(A.office, suggestion, "approved", quote)).toMatchObject({ ok: true });
    expect((await sql("select status, result_quote_id, decided_by from public.ai_helper_requests where id = $1", [suggestion]))[0]).toEqual({ status: "approved", result_quote_id: quote, decided_by: A.office.id });
    expect((await audit(orgA, "ai_helper_approved")).at(-1)).toMatchObject({ entity_id: suggestion, metadata: { feature: "rfq", quote_id: quote } });
  });

  it("once only, and one quote per suggestion; a round-up has nothing to decide", async () => {
    expect(await decide(A.office, suggestion, "rejected", null)).toMatchObject({ ok: false, code: "42501" });
    const r = await reserve(A.office, "rfq", 5);
    const other = (r as unknown as { value: { request_id: string } }).value.request_id;
    await settle(A.office, other, "suggested", null, 1, { kind: "rfq", lines: [] });
    expect(await decide(A.office, other, "approved", quote)).toMatchObject({ ok: false, code: "42501" });
    expect(await decide(A.admin, other, "rejected", null)).toMatchObject({ ok: true });
    expect((await audit(orgA, "ai_helper_rejected")).at(-1)).toMatchObject({ entity_id: other, metadata: { feature: "rfq", source: "ai_helper" } });
    const round = (await sql<{ id: string }>("select id from public.ai_helper_requests where organization_id = $1 and feature = 'roundup' and status = 'suggested' limit 1", [orgA]))[0].id;
    expect(await decide(A.office, round, "rejected", null)).toMatchObject({ ok: false, code: "42501" });
  });

  it("the app's write_audit still refuses these event names: a client can't make one up", async () => {
    for (const action of ["ai_helper_approved", "ai_helper_requested", "ai_helper_suggested", "ai_helper_settings_updated"]) {
      await expect(as(A.admin, (db) => db.query("select public.write_audit($1, 'ai_helper_requests', $2, null, null, '{}'::jsonb, null, null)", [action, suggestion]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("audit metadata is ids, feature, pence and counts only", async () => {
    const rows = await sql<{ metadata: Record<string, unknown> }>("select metadata from security_audit.audit_log where organization_id = $1 and action like 'ai\\_helper\\_%'", [orgA]);
    const keys = new Set(rows.flatMap((r) => Object.keys(r.metadata)));
    expect([...keys].sort()).toEqual(["cost_pence", "estimate_pence", "feature", "input_bytes", "lines", "model", "monthly_cap_pence", "quote_id", "reason", "rfq_enabled", "roundup_enabled", "source"]);
  });
});

describe("101: two companies", () => {
  it("beta sees none of alpha's settings, ledger or requests, and only its own status", async () => {
    for (const table of ["ai_helper_settings", "ai_helper_usage", "ai_helper_requests"]) {
      const seen = await as(B.admin, async (db) => (await db.query(`select organization_id from public.${table}`)).rows);
      expect(seen.every((r) => r.organization_id === orgB), table).toBe(true);
      const alphaSeen = await as(A.office, async (db) => (await db.query(`select organization_id from public.${table}`)).rows);
      expect(alphaSeen.length, table).toBeGreaterThan(0);
      expect(alphaSeen.every((r) => r.organization_id === orgA), table).toBe(true);
    }
    expect(await status(B.admin)).toMatchObject({ ok: true, value: { key_set: false, rfq_enabled: true, roundup_enabled: false, monthly_cap_pence: 500 } });
    await expect(as(B.admin, (db) => db.query("select api_key_enc from public.ai_helper_secrets"))).rejects.toMatchObject({ code: "42501" });
  });

  it("the cap: only an admin changes it, and only for their own company", async () => {
    const capOf = async (org: string) => (await sql<{ c: number }>("select monthly_cap_pence as c from public.ai_helper_settings where organization_id = $1", [org]))[0]?.c;
    const alpha = await capOf(orgA);
    const beta = await capOf(orgB);
    expect(await save(B.office, true, true, 1)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(A.office, true, true, 1)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(B.admin, false, true, 250)).toMatchObject({ ok: true, value: { monthly_cap_pence: 250 } });
    expect(await capOf(orgB)).toBe(250);
    expect(await capOf(orgA)).toBe(alpha);
    expect(await save(A.admin, true, true, 100001)).toMatchObject({ ok: false, code: "22023" });
    expect(await capOf(orgA)).toBe(alpha);
    expect(await save(B.admin, false, true, beta)).toMatchObject({ ok: true });
  });

  it("beta can't settle or decide alpha's requests, and a beta key never reaches alpha", async () => {
    const r = await reserve(A.office, "rfq", 5);
    const id = (r as unknown as { value: { request_id: string } }).value.request_id;
    expect(await settle(B.office, id, "failed", "invalid", 0, null)).toMatchObject({ ok: false, code: "42501" });
    await settle(A.office, id, "suggested", null, 1, { kind: "rfq", lines: [] });
    expect(await decide(B.admin, id, "rejected", null)).toMatchObject({ ok: false, code: "42501" });
    expect((await sql<{ status: string }>("select status from public.ai_helper_requests where id = $1", [id]))[0].status).toBe("suggested");
    await setKey(B.admin, "v1.dddddddddddddddd.eeeeeeeeeeeeeeeeeeeeee.ffffffffffff", "BETA");
    const a = await reserve(A.office, "rfq", 1);
    expect((a as unknown as { value: { key_enc: string } }).value.key_enc).toBe(KEY_ENC);
    await settle(A.office, (a as unknown as { value: { request_id: string } }).value.request_id, "failed", "unavailable", 0, null);
  });
});
