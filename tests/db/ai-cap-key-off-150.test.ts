/**
 * Post-144 release 150 (A150): the AI helper's own-key monthly cap defaults to 1000p, and replacing or removing an AI key switches that
 * company's AI off (explicit turn-on afterwards). Real SQL as the role and claims the real caller carries, on the disposable database only
 * (verifyBackendIdentity first). The verified fixture installs 145, 146, 147 and 150; the last cases roll 150 back and apply the shipped
 * release file again on a database that already holds companies with explicit caps, keys and AI on.
 *   - default 1000p: column default, status fallback, every function that makes a row (set_key, finance check, assistant) and no existing row moved;
 *   - key replace / remove / first save: roundup, rfq, assistant, finance check and the company's Tolra mode go off, in the same transaction, with
 *     one audit row (actor, company, codes only); the cap, the usage ledger and the request log are kept; turning on again is explicit;
 *   - a reservation already granted is settled as before (it completes at its cost, or is released at 0p), nothing is double-counted;
 *   - concurrency: own-key and provided mode, across roundup, rfq and assistant, never pass 1000p, per company; a key change racing a burst of
 *     reservations never deadlocks and never lets used + reserved pass the cap;
 *   - company isolation: A's key change touches nothing of B;
 *   - the platform key: replacing Tolra's key switches the platform switch off with an audit row; the first key keeps the asked switch.
 *   - one company cap across both modes: a reservation in either mode is refused unless used + reserved stays within least(own-key cap, Tolra cap),
 *     so switching between own key and Tolra-provided AI never reaches the higher cap, also under concurrency.
 * All data is synthetic (slug prefix t-<run>-, e-mail <name>.<run>@example.test) and removed in afterAll; the platform control row is put back.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { destroySyntheticWorld, newRunId, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
// A150_RELEASE_FILE exists only for the fail-first proof: the upgrade case then applies a deliberately broken copy of the release instead of the shipped file.
const RELEASE = process.env.A150_RELEASE_FILE ? readFileSync(process.env.A150_RELEASE_FILE, "utf8") : read("supabase/release/150_ai_cap_key_off.release.sql");
const DIGEST = "d".repeat(64);
const FEATURES = ["roundup", "rfq", "assistant"] as const;
type Feature = (typeof FEATURES)[number];
type Co = { id: string; user: string; office: string; email: string; officeEmail: string; session: string; officeSession: string };
const NAMES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "X"] as const;
type Name = (typeof NAMES)[number];

const runId = newRunId();
const companies = {} as Record<Name, Co>;
const owner = { id: randomUUID(), email: `a150-owner.${runId}@example.test` };
let control: { enabled: boolean; api_key_enc: string | null; updated_by: string | null; updated_at: string } | undefined;
/** A synthetic ciphertext in the stored form (never a real key). */
const enc = (tag: string) => `v1.${tag}${randomBytes(6).toString("hex")}.${randomBytes(11).toString("hex")}.${randomBytes(6).toString("hex")}`;

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code?: string; hint?: string; message: string };
const claims = (sub: string, email: string, session: string) => JSON.stringify({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", email, session_id: session });

async function as(role: "authenticated" | "service_role" | "anon", who: { sub: string; email: string; session: string } | null, sql: string, params: unknown[] = []): Promise<Outcome> {
  return withDb(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      if (who) await db.query("SELECT set_config('request.jwt.claims',$1,TRUE), set_config('request.jwt.claim.sub',$2,TRUE)", [claims(who.sub, who.email, who.session), who.sub]);
      const r = await db.query(sql, params);
      await db.query("COMMIT");
      return { ok: true as const, value: r.rows[0] ?? {} };
    } catch (e) {
      await db.query("ROLLBACK");
      const err = e as { code?: string; hint?: string; message: string };
      return { ok: false as const, code: err.code, hint: err.hint, message: err.message };
    }
  });
}
const admin = (co: Co, sql: string, params: unknown[] = []) => as("authenticated", { sub: co.user, email: co.email, session: co.session }, sql, params);
const office = (co: Co, sql: string, params: unknown[] = []) => as("authenticated", { sub: co.office, email: co.officeEmail, session: co.officeSession }, sql, params);
const service = (sql: string, params: unknown[] = []) => as("service_role", null, sql, params);
const owned = <T>(fn: (db: Client) => Promise<T>) => withDb(fn);
const value = (o: Outcome) => { if (!o.ok) throw new Error(`${o.code}: ${o.message}`); return o.value; };

const setKey = (co: Co, key: string | null, last4 = "wxyz") => admin(co, "SELECT public.ai_helper_set_key($1,$2) AS s", [key, key === null ? null : last4]);
const saveSettings = (co: Co, roundup: boolean, rfq: boolean, cap: number) => admin(co, "SELECT public.ai_helper_save_settings($1,$2,$3) AS s", [roundup, rfq, cap]);
const status = async (co: Co) => value(await admin(co, "SELECT public.ai_helper_status() AS s")).s as Record<string, unknown>;
const settingsRow = (co: Co) => owned(async (db) => (await db.query("SELECT roundup_enabled, rfq_enabled, assistant_enabled, finance_check_enabled, monthly_cap_pence, api_key_last4 FROM public.ai_helper_settings WHERE organization_id=$1", [co.id])).rows[0] as Record<string, unknown> | undefined);
const tolraRow = (co: Co) => owned(async (db) => (await db.query("SELECT enabled, monthly_cap_pence FROM public.ai_helper_tolra_companies WHERE organization_id=$1", [co.id])).rows[0] as { enabled: boolean; monthly_cap_pence: number } | undefined);
const usageRows = (co: Co) => owned(async (db) => (await db.query("SELECT month::text, spent_pence, reserved_pence FROM public.ai_helper_usage WHERE organization_id=$1 ORDER BY month", [co.id])).rows);
const requestRows = (co: Co) => owned(async (db) => (await db.query("SELECT id, status, cost_pence, reserved_pence, key_source FROM public.ai_helper_requests WHERE organization_id=$1 ORDER BY created_at, id", [co.id])).rows);
const secretCount = (co: Co) => owned(async (db) => Number((await db.query("SELECT count(*) AS n FROM public.ai_helper_secrets WHERE organization_id=$1", [co.id])).rows[0].n));
type AuditRow = { actor_user_id: string; actor_email: string; organization_id: string; entity_table: string; entity_id: string; metadata: Record<string, unknown> };
const forcedOff = (co: Co) => owned(async (db) => (await db.query("SELECT actor_user_id, actor_email, organization_id, entity_table, entity_id, metadata FROM security_audit.audit_log WHERE organization_id=$1 AND action='ai_forced_off_key_changed' ORDER BY created_at, id", [co.id])).rows as AuditRow[]);
const reserve = (co: Co, feature: Feature, pence = 100) =>
  feature === "assistant"
    ? admin(co, "SELECT public.ai_helper_reserve_assistant($1,$2,10) AS r", [pence, DIGEST])
    : admin(co, "SELECT public.ai_helper_reserve($1,$2,$3,10) AS r", [feature, pence, DIGEST]);
const answer = (o: Outcome) => (o.ok ? (o.value.r as { ok: boolean; reason?: string; request_id?: string; key_source?: string }) : null);
const used = (co: Co) => owned(async (db) => (await db.query("SELECT coalesce(sum(spent_pence + reserved_pence),0)::int AS n FROM public.ai_helper_usage WHERE organization_id=$1 AND month = date_trunc('month', now() AT TIME ZONE 'Europe/London')::date", [co.id])).rows[0].n as number);
const reservedNow = (co: Co) => owned(async (db) => (await db.query("SELECT coalesce(sum(reserved_pence),0)::int AS n FROM public.ai_helper_usage WHERE organization_id=$1", [co.id])).rows[0].n as number);
const burst = (co: Co, n: number, pence = 100) => Promise.all(Array.from({ length: n }, (_, i) => reserve(co, FEATURES[i % 3], pence)));
const oks = (outs: Outcome[]) => outs.filter((o) => answer(o)?.ok === true).length;
const caps = (outs: Outcome[]) => outs.filter((o) => answer(o)?.ok === false && answer(o)?.reason === "cap").length;
const settle = (requestId: string, status: "suggested" | "failed", cost: number) =>
  status === "suggested"
    ? service("SELECT public.ai_helper_settle($1,'suggested',NULL,$2,'claude-test',$3::jsonb)", [requestId, cost, JSON.stringify({ lines: [] })])
    : service("SELECT public.ai_helper_settle($1,'failed','unavailable',$2,NULL,NULL)", [requestId, cost]);
/** What the upgrade case compares: every row of every AI table, as one digest per table. */
const digests = () => owned(async (db) => {
  const out: Record<string, string> = {};
  for (const t of ["ai_helper_settings", "ai_helper_secrets", "ai_helper_usage", "ai_helper_requests", "ai_helper_tolra_companies", "ai_helper_tolra_control"]) {
    out[t] = (await db.query(`SELECT coalesce(md5(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text)),'none') AS d FROM public.${t} t`)).rows[0].d;
  }
  return out;
});
/** The cases that need all switches on without writing the cap (a row that only ever carried the column default) set them as the database owner. */
const turnAllOn = (co: Co) => owned((db) => db.query("UPDATE public.ai_helper_settings SET roundup_enabled=TRUE, rfq_enabled=TRUE, assistant_enabled=TRUE, finance_check_enabled=TRUE WHERE organization_id=$1", [co.id]));
const allOff = (r: Record<string, unknown> | undefined) => expect(r).toMatchObject({ roundup_enabled: false, rfq_enabled: false, assistant_enabled: false, finance_check_enabled: false });
const allOn = (r: Record<string, unknown> | undefined) => expect(r).toMatchObject({ roundup_enabled: true, rfq_enabled: true, assistant_enabled: true, finance_check_enabled: true });
const platformEvents = () => owned(async (db) => (await db.query("SELECT actor_user_id, organization_id, entity_id, metadata FROM security_audit.audit_log WHERE organization_id IS NULL AND action='ai_forced_off_key_changed' ORDER BY created_at, id")).rows);

beforeAll(async () => {
  await verifyBackendIdentity();
  // A150_SKIP_FIXTURE=1 exists only for the fail-first proof, which runs this file against a copy of the database whose release 150 was deliberately
  // broken (the fixture's own verify refuses such a copy, which is what it is for). The copy is still checked by verifyBackendIdentity above.
  if (process.env.A150_SKIP_FIXTURE !== "1") await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  await withDb(async (db) => {
    control = (await db.query("SELECT enabled, api_key_enc, updated_by, updated_at FROM public.ai_helper_tolra_control WHERE singleton")).rows[0];
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [owner.id, owner.email]);
    await db.query("INSERT INTO security_audit.platform_admins(user_id) VALUES($1)", [owner.id]);
    for (const key of NAMES) {
      const lower = key.toLowerCase();
      const co: Co = { id: randomUUID(), user: randomUUID(), office: randomUUID(), email: `a150-admin-${lower}.${runId}@example.test`, officeEmail: `a150-office-${lower}.${runId}@example.test`, session: randomUUID(), officeSession: randomUUID() };
      companies[key] = co;
      await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [co.id, `A150 ${key} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-${lower}`]);
      for (const [id, email, role, session] of [[co.user, co.email, "admin", co.session], [co.office, co.officeEmail, "office", co.officeSession]] as const) {
        await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
        await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,TRUE,FALSE)", [id, email, role, co.id]);
        await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,TRUE)", [id, co.id, role]);
        await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
        await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, co.id]);
      }
    }
  });
}, 240_000);

afterAll(async () => {
  await withDb(async (db) => {
    if (control) await db.query("UPDATE public.ai_helper_tolra_control SET enabled=$1, api_key_enc=$2, updated_by=$3, updated_at=$4 WHERE singleton", [control.enabled, control.api_key_enc, control.updated_by, control.updated_at]);
    await db.query("DELETE FROM security_audit.platform_admins WHERE user_id=$1", [owner.id]);
  });
  await destroySyntheticWorld(runId);
  await withDb((db) => db.query("DELETE FROM auth.users WHERE id=$1", [owner.id]));
}, 120_000);

describe("release 150: the own-key cap defaults to 1000p", () => {
  it("column default, status for a company with no row, and every function that makes a row read 1000; an explicit cap stays as set", async () => {
    const { A, B, C, D } = companies;
    const col = await owned((db) => db.query("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_helper_settings' AND column_name='monthly_cap_pence'"));
    expect(String(col.rows[0].column_default)).toBe("1000");
    expect(await settingsRow(A)).toBeUndefined();
    expect((await status(A)).monthly_cap_pence).toBe(1000);
    expect((await status(A)).tolra_cap_pence).toBe(1000);
    expect((await setKey(A, enc("a1"))).ok).toBe(true);
    expect(await settingsRow(A)).toMatchObject({ monthly_cap_pence: 1000, roundup_enabled: false });
    expect((await admin(B, "SELECT public.ai_helper_set_finance_check(TRUE)")).ok).toBe(true);
    expect(await settingsRow(B)).toMatchObject({ monthly_cap_pence: 1000, finance_check_enabled: true });
    expect((await admin(C, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    expect(await settingsRow(C)).toMatchObject({ monthly_cap_pence: 1000, assistant_enabled: true });
    expect((await saveSettings(D, true, true, 700)).ok).toBe(true);
    expect(await settingsRow(D)).toMatchObject({ monthly_cap_pence: 700 });
    expect((await status(D)).monthly_cap_pence).toBe(700);
  });
});

describe("release 150: concurrency at the new default, own key and provided, across every entry point", () => {
  it("own key: 25 reservations of 100p across roundup, rfq and assistant at once give exactly 10 ok against the 1000p default; used is exactly 1000", async () => {
    const { E } = companies;
    expect((await setKey(E, enc("e1"))).ok).toBe(true);
    await turnAllOn(E);
    expect(await settingsRow(E)).toMatchObject({ monthly_cap_pence: 1000 }); // a row that only ever carried the default
    const outs = await burst(E, 25);
    expect(oks(outs)).toBe(10);
    expect(caps(outs)).toBe(15);
    expect(await used(E)).toBe(1000);
    expect((await requestRows(E)).filter((r) => r.status === "reserved")).toHaveLength(10);
  });

  it("own key, mixed sizes: three 400p reservations at once against 1000p give exactly two; a second company racing at the same time keeps its own budget", async () => {
    const { F, G } = companies;
    for (const co of [F, G]) { expect((await setKey(co, enc("f1"))).ok).toBe(true); await turnAllOn(co); }
    const both = await Promise.all([burst(F, 3, 400), burst(G, 25)]);
    expect(oks(both[0])).toBe(2);
    expect(await used(F)).toBe(800);
    expect(oks(both[1])).toBe(10);
    expect(await used(G)).toBe(1000);
  });

  it("provided mode: a company on Tolra AI with the 1000p default also stops at exactly 10 of 25, while the own-key company beside it does the same", async () => {
    const { H, I } = companies;
    await owned((db) => db.query("UPDATE public.ai_helper_tolra_control SET enabled=FALSE, api_key_enc=NULL WHERE singleton"));
    await owned((db) => db.query("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2)", [enc("p1"), owner.id]));
    expect((await admin(H, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).ok).toBe(true);
    expect(await tolraRow(H)).toEqual({ enabled: true, monthly_cap_pence: 1000 });
    expect((await setKey(I, enc("i1"))).ok).toBe(true);
    await turnAllOn(I);
    const [h, i] = await Promise.all([burst(H, 25), burst(I, 25)]);
    expect(oks(h)).toBe(10);
    expect(h.filter((o) => answer(o)?.ok).every((o) => answer(o)?.key_source === "tolra")).toBe(true);
    expect(await used(H)).toBe(1000);
    expect(oks(i)).toBe(10);
    expect(await used(I)).toBe(1000);
  });
});

describe("release 150: replacing or removing the own key switches AI off", () => {
  it("replace: roundup, rfq, assistant and finance check go off in the same call; cap, usage and requests are kept; one audit row carries actor, company and codes only; nothing runs until it is turned on again", async () => {
    const { J } = companies;
    expect((await setKey(J, enc("j1"), "j1j1")).ok).toBe(true);
    expect((await saveSettings(J, true, true, 700)).ok).toBe(true);
    expect((await admin(J, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    expect((await admin(J, "SELECT public.ai_helper_set_finance_check(TRUE)")).ok).toBe(true);
    allOn(await settingsRow(J));
    const r1 = answer(await reserve(J, "roundup", 100));
    expect(r1?.ok).toBe(true);
    expect((await settle(r1!.request_id!, "suggested", 40)).ok).toBe(true);
    const before = { usage: await usageRows(J), requests: await requestRows(J) };
    expect(await forcedOff(J)).toHaveLength(0);

    const newKey = enc("j2");
    const out = await setKey(J, newKey, "j2j2");
    expect(out.ok).toBe(true);
    expect(value(out).s).toMatchObject({ roundup_enabled: false, rfq_enabled: false, key_set: true, key_last4: "j2j2", monthly_cap_pence: 700 });
    allOff(await settingsRow(J));
    expect(await settingsRow(J)).toMatchObject({ monthly_cap_pence: 700, api_key_last4: "j2j2" });
    expect({ usage: await usageRows(J), requests: await requestRows(J) }).toEqual(before);
    const events = await forcedOff(J);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: J.user, actor_email: J.email, organization_id: J.id, entity_table: "ai_helper_settings", entity_id: J.id });
    expect(events[0].metadata).toEqual({ reason: "key_replaced", roundup_was_on: true, rfq_was_on: true, assistant_was_on: true, finance_check_was_on: true, tolra_was_on: false, source: "ai_helper" });
    expect(JSON.stringify(events[0])).not.toContain(newKey);
    for (const f of FEATURES) expect(await reserve(J, f), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await used(J)).toBe(40);

    // Explicit reactivation through the existing function: the cap the company set is still the cap.
    expect((await saveSettings(J, true, true, 700)).ok).toBe(true);
    expect(answer(await reserve(J, "rfq", 100))?.ok).toBe(true);
    expect(answer(await reserve(J, "roundup", 100))?.ok).toBe(true);
  });

  it("a limit change (what the AI card's Save limit sends) persists, leaves every switch as it was, keeps the usage rows and writes no force-off row; out-of-range values are refused", async () => {
    const { J } = companies;
    expect((await saveSettings(J, true, true, 700)).ok).toBe(true);
    expect((await admin(J, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    expect((await admin(J, "SELECT public.ai_helper_set_finance_check(TRUE)")).ok).toBe(true);
    const switches = async () => { const row = (await settingsRow(J))!; return { roundup_enabled: row.roundup_enabled, rfq_enabled: row.rfq_enabled, assistant_enabled: row.assistant_enabled, finance_check_enabled: row.finance_check_enabled }; };
    const before = { sw: await switches(), usage: await usageRows(J), requests: await requestRows(J), events: (await forcedOff(J)).length, keys: await secretCount(J) };
    allOn(await settingsRow(J));
    // The route's calls: save_settings with the switches as they are and the new cap, then the finance check and assistant as they are.
    // Release 150: the lowest accepted limit is this month's spent + reserved (J has use from the cases above); 0 is refused while it has use.
    const floor = await used(J);
    expect(floor).toBeGreaterThan(0);
    expect(await saveSettings(J, true, true, 0)).toMatchObject({ ok: false, code: "22023", hint: "cap_below_usage" });
    for (const pence of [1550, floor, 100000, 700]) {
      expect((await saveSettings(J, true, true, pence)).ok).toBe(true);
      expect((await admin(J, "SELECT public.ai_helper_set_finance_check(TRUE)")).ok).toBe(true);
      expect((await admin(J, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
      expect(await settingsRow(J)).toMatchObject({ monthly_cap_pence: pence });
      expect((await status(J)).monthly_cap_pence).toBe(pence);
      expect(await switches()).toEqual(before.sw);
    }
    expect({ usage: await usageRows(J), requests: await requestRows(J), events: (await forcedOff(J)).length, keys: await secretCount(J) }).toEqual({ usage: before.usage, requests: before.requests, events: before.events, keys: before.keys });
    expect(await saveSettings(J, true, true, 100001)).toMatchObject({ ok: false, code: "22023" });
    expect(await saveSettings(J, true, true, -1)).toMatchObject({ ok: false, code: "22023" });
    expect(await office(J, "SELECT public.ai_helper_save_settings(TRUE,TRUE,900)")).toMatchObject({ ok: false, code: "42501" });
    expect(await settingsRow(J)).toMatchObject({ monthly_cap_pence: 700 });
    // On a company that has AI off, a limit-only change leaves it off.
    const { K } = companies;
    expect((await setKey(K, enc("k9"))).ok).toBe(true);
    expect((await saveSettings(K, false, false, 1234)).ok).toBe(true);
    allOff(await settingsRow(K));
    expect(await settingsRow(K)).toMatchObject({ monthly_cap_pence: 1234 });
  });

  it("remove: the same switches go off, the key is gone (no_key), the audit row says key_removed", async () => {
    const { K } = companies;
    expect((await setKey(K, enc("k1"))).ok).toBe(true);
    expect((await saveSettings(K, true, false, 300)).ok).toBe(true);
    expect((await admin(K, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const out = await setKey(K, null);
    expect(out.ok).toBe(true);
    expect(value(out).s).toMatchObject({ key_set: false, key_last4: null, roundup_enabled: false, monthly_cap_pence: 300 });
    expect(await secretCount(K)).toBe(0);
    allOff(await settingsRow(K));
    const events = await forcedOff(K);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ reason: "key_removed", roundup_was_on: true, rfq_was_on: false, assistant_was_on: true });
    for (const f of FEATURES) expect(await reserve(K, f), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
  });

  it("a first save or a replacement while everything is already off writes no force-off row; a company on Tolra AI that stores its own key has the Tolra mode switched off", async () => {
    const { L, M } = companies;
    expect((await setKey(L, enc("l1"))).ok).toBe(true);
    expect((await setKey(L, enc("l2"))).ok).toBe(true);
    expect(await forcedOff(L)).toHaveLength(0);
    expect(await tolraRow(L)).toBeUndefined();
    expect((await admin(M, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).ok).toBe(true);
    expect(await tolraRow(M)).toMatchObject({ enabled: true, monthly_cap_pence: 1000 });
    expect((await setKey(M, enc("m1"))).ok).toBe(true);
    expect(await tolraRow(M)).toMatchObject({ enabled: false, monthly_cap_pence: 1000 });
    allOff(await settingsRow(M));
    const events = await forcedOff(M);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ reason: "key_saved", tolra_was_on: true, roundup_was_on: true });
    expect((await status(M)).tolra_enabled).toBe(false);
  });

  it("only an admin can change the key: office and anonymous callers are refused and nothing is switched off; the internal force-off is callable by nobody", async () => {
    const { N } = companies;
    expect((await setKey(N, enc("n1"))).ok).toBe(true);
    await turnAllOn(N);
    expect(await office(N, "SELECT public.ai_helper_set_key($1,$2)", [enc("n2"), "abcd"])).toMatchObject({ ok: false, code: "42501" });
    expect(await office(N, "SELECT public.ai_helper_set_key(NULL,NULL)")).toMatchObject({ ok: false, code: "42501" });
    expect(await as("anon", null, "SELECT public.ai_helper_set_key($1,$2)", [enc("n3"), "abcd"])).toMatchObject({ ok: false });
    expect(await admin(N, "SELECT public._ai_helper_force_off($1,'key_removed')", [N.id])).toMatchObject({ ok: false, code: "42501" });
    expect(await service("SELECT public._ai_helper_force_off($1,'key_removed')", [N.id])).toMatchObject({ ok: false, code: "42501" });
    allOn(await settingsRow(N));
    expect(await forcedOff(N)).toHaveLength(0);
  });

  it("a malformed key is refused and nothing changes (the switches stay on, no audit row)", async () => {
    const { N } = companies;
    expect(await setKey(N, "sk-ant-not-a-ciphertext")).toMatchObject({ ok: false, code: "22023" });
    allOn(await settingsRow(N));
    expect(await forcedOff(N)).toHaveLength(0);
  });

  it("company isolation: P's replacement and removal change nothing of Q (switches, cap, key, usage, requests, audit)", async () => {
    const { P, Q } = companies;
    for (const co of [P, Q]) { expect((await setKey(co, enc("pq"))).ok).toBe(true); expect((await saveSettings(co, true, true, 900)).ok).toBe(true); await turnAllOn(co); }
    expect(answer(await reserve(Q, "assistant", 100))?.ok).toBe(true);
    const snap = async () => ({ row: await settingsRow(Q), usage: await usageRows(Q), requests: await requestRows(Q), secrets: await secretCount(Q), events: await forcedOff(Q) });
    const qBefore = await snap();
    expect((await setKey(P, enc("p2"))).ok).toBe(true);
    expect((await setKey(P, null)).ok).toBe(true);
    allOff(await settingsRow(P));
    expect(await forcedOff(P)).toHaveLength(1); // the replacement switched it off; the removal then found everything already off
    expect(await snap()).toEqual(qBefore);
    allOn(await settingsRow(Q));
    expect(answer(await reserve(Q, "rfq", 100))?.ok).toBe(true);
  });
});

describe("release 150: a reservation already granted when the key changes", () => {
  it("is settled as before: it completes at its cost (replace) or is released at 0p (removal); nothing is counted twice and the ledger is kept", async () => {
    const { P } = companies;
    expect((await setKey(P, enc("x1"))).ok).toBe(true);
    expect((await saveSettings(P, true, true, 1000)).ok).toBe(true);
    const base = await used(P);
    const a = answer(await reserve(P, "roundup", 100));
    const b = answer(await reserve(P, "rfq", 150));
    expect(a?.ok && b?.ok).toBe(true);
    expect(await reservedNow(P)).toBe(250);
    expect((await setKey(P, enc("x2"))).ok).toBe(true); // switches AI off while both are in flight
    allOff(await settingsRow(P));
    expect(await reservedNow(P)).toBe(250); // the reservations are neither dropped nor charged by the key change
    expect((await settle(a!.request_id!, "suggested", 60)).ok).toBe(true); // completes
    expect(await reservedNow(P)).toBe(150);
    expect(await used(P)).toBe(base + 60 + 150);
    expect((await setKey(P, null)).ok).toBe(true);
    expect((await settle(b!.request_id!, "failed", 0)).ok).toBe(true); // the app finds no key: released at 0p
    expect(await reservedNow(P)).toBe(0);
    expect(await used(P)).toBe(base + 60);
    expect((await settle(b!.request_id!, "failed", 0)).ok).toBe(false); // already closed: no second settle
    expect((await requestRows(P)).filter((r) => r.status === "reserved")).toHaveLength(0);
  });

  it("a key change racing a burst of reservations never deadlocks and never lets used pass the cap: each answer is ok, cap or off; each ok stays reserved until settled", async () => {
    const { Q } = companies;
    expect((await saveSettings(Q, true, true, 500)).ok).toBe(true);
    await turnAllOn(Q);
    const startUsed = await used(Q);
    const reservedBefore = await reservedNow(Q);
    const outs = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) => reserve(Q, FEATURES[i % 3], 100)),
      setKey(Q, enc("r1")), setKey(Q, enc("r2")),
    ]);
    const reservations = outs.slice(0, 12);
    expect(outs.slice(12).every((o) => o.ok)).toBe(true);
    for (const o of reservations) expect(o.ok ? answer(o)?.ok === true || answer(o)?.reason === "cap" : o.hint === "ai_helper_off").toBe(true);
    expect(await used(Q)).toBeLessThanOrEqual(500);
    expect((await used(Q)) - startUsed).toBe(oks(reservations) * 100);
    allOff(await settingsRow(Q));
    for (const o of reservations) if (answer(o)?.ok) expect((await settle(answer(o)!.request_id!, "failed", 0)).ok).toBe(true);
    expect(await reservedNow(Q)).toBe(reservedBefore);
  });
});

describe("release 150: replacing the platform key", () => {
  it("the first key keeps the asked switch; a replacement switches the platform off with an audit row, companies' own rows are untouched and provided AI stops until the owner turns it on again", async () => {
    const { H, I } = companies;
    await owned((db) => db.query("UPDATE public.ai_helper_tolra_control SET enabled=FALSE, api_key_enc=NULL WHERE singleton"));
    expect(value(await service("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2) AS s", [enc("t1"), owner.id])).s).toEqual({ enabled: true, key_set: true });
    expect((await admin(I, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).ok).toBe(true);
    await owned((db) => db.query("UPDATE public.ai_helper_requests SET status='failed', failure='unavailable', cost_pence=0, settled_at=now() WHERE organization_id=$1 AND status='reserved'", [I.id]));
    await owned((db) => db.query("UPDATE public.ai_helper_usage SET spent_pence=0, reserved_pence=0 WHERE organization_id=$1", [I.id]));
    const granted = answer(await reserve(I, "roundup", 100));
    expect(granted).toMatchObject({ ok: true, key_source: "tolra" });
    expect(value(await service("SELECT public.ai_helper_tolra_key($1,$2) AS k", [granted!.request_id, I.id])).k).not.toBeNull();
    const eventsBefore = (await platformEvents()).length;

    expect(value(await service("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2) AS s", [enc("t2"), owner.id])).s).toEqual({ enabled: false, key_set: true });
    const events = await platformEvents();
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events[events.length - 1]).toMatchObject({ actor_user_id: owner.id, organization_id: null, entity_id: "singleton", metadata: { reason: "key_replaced", scope: "platform", tolra_was_on: true, source: "platform_owner" } });
    expect(await tolraRow(I)).toMatchObject({ enabled: true, monthly_cap_pence: 1000 }); // the company's own row is not touched
    expect(await reserve(I, "rfq")).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await reserve(H, "assistant")).toMatchObject({ ok: false, hint: "ai_helper_off" });
    // The reservation granted before the change: its key lookup now finds nothing (the app settles failed at 0p), and settle still works.
    expect(value(await service("SELECT public.ai_helper_tolra_key($1,$2) AS k", [granted!.request_id, I.id])).k).toBeNull();
    expect(await reservedNow(I)).toBe(100);
    expect((await settle(granted!.request_id!, "failed", 0)).ok).toBe(true);
    expect(await reservedNow(I)).toBe(0);

    // A replacement while the platform switch is already off writes no second row and stays off; the owner turns it on explicitly.
    expect(value(await service("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2) AS s", [enc("t3"), owner.id])).s).toEqual({ enabled: false, key_set: true });
    expect(await platformEvents()).toHaveLength(eventsBefore + 1);
    expect(value(await service("SELECT public.ai_helper_tolra_configure(TRUE,NULL,$1) AS s", [owner.id])).s).toEqual({ enabled: true, key_set: true });
    expect(answer(await reserve(I, "rfq"))?.ok).toBe(true);
    // A company or an anonymous caller cannot reach it.
    expect((await admin(I, "SELECT public.ai_helper_tolra_configure(TRUE,$1,$2)", [enc("t4"), owner.id])).ok).toBe(false);
    expect((await as("anon", null, "SELECT public.ai_helper_tolra_configure(TRUE,$1,$2)", [enc("t5"), owner.id])).ok).toBe(false);
  });
});

describe("release 150: one company cap across own-key and Tolra-provided AI", () => {
  /** The platform switch on with a key (the platform-key case elsewhere in this file may have left it off). */
  const platformOn = () => owned((db) => db.query("SELECT public.ai_helper_tolra_configure(TRUE, CASE WHEN (SELECT api_key_enc FROM public.ai_helper_tolra_control WHERE singleton) IS NULL THEN $1 END, $2)", [enc("pc"), owner.id]));
  const setTolraCap = (co: Co, cap: number) => service("SELECT public.ai_helper_tolra_set_cap($1,$2,$3)", [co.id, cap, owner.id]);
  const tolraMode = (co: Co, on: boolean) => admin(co, "SELECT public.ai_helper_set_tolra_mode($1)", [on]);
  const capRefusals = (co: Co) => owned(async (db) => (await db.query("SELECT key_source, count(*)::int AS n FROM public.ai_helper_requests WHERE organization_id=$1 AND status='refused' AND refusal='cap' GROUP BY key_source ORDER BY key_source", [co.id])).rows as Array<{ key_source: string; n: number }>);
  const inSequence = async (co: Co, n: number, pence = 100) => { const out: Outcome[] = []; for (let i = 0; i < n; i++) out.push(await reserve(co, FEATURES[i % 3], pence)); return out; };

  it("(a) own 1000 + Tolra 1000: spent up to the cap in own-key mode, switching to Tolra mode is refused (cap); raising the Tolra cap to 5000 still leaves the own 1000 binding", async () => {
    const { R } = companies;
    expect((await setKey(R, enc("r1"))).ok).toBe(true);
    expect((await saveSettings(R, true, true, 1000)).ok).toBe(true);
    expect((await admin(R, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const own = await inSequence(R, 12);
    expect(oks(own)).toBe(10);
    expect(caps(own)).toBe(2);
    // Half of it settled at cost (spent), half still reserved: both count.
    const granted = own.filter((o) => answer(o)?.ok).map((o) => answer(o)!.request_id as string);
    for (const id of granted.slice(0, 5)) expect((await settle(id, "suggested", 100)).ok).toBe(true);
    expect(await used(R)).toBe(1000);
    await platformOn();
    expect((await tolraMode(R, true)).ok).toBe(true);
    expect(await tolraRow(R)).toEqual({ enabled: true, monthly_cap_pence: 1000 });
    for (const feature of FEATURES) expect(answer(await reserve(R, feature, 1))).toMatchObject({ ok: false, reason: "cap" });
    expect((await setTolraCap(R, 5000)).ok).toBe(true);
    for (const feature of FEATURES) expect(answer(await reserve(R, feature, 100))).toMatchObject({ ok: false, reason: "cap" });
    expect(await used(R)).toBe(1000);
    expect(await reservedNow(R)).toBe(500);
    expect(await capRefusals(R)).toEqual([{ key_source: "own", n: 2 }, { key_source: "tolra", n: 6 }]);
    // Back to own-key mode: the own cap still binds.
    expect((await tolraMode(R, false)).ok).toBe(true);
    expect((await saveSettings(R, true, true, 1000)).ok).toBe(true);
    expect(answer(await reserve(R, "roundup", 1))).toMatchObject({ ok: false, reason: "cap" });
  });

  it("(b) the own-key cap lowered below the Tolra cap binds in Tolra mode: own 500, Tolra 5000, ten 100p reservations in Tolra mode give exactly 5", async () => {
    const { S } = companies;
    expect((await setKey(S, enc("s1"))).ok).toBe(true);
    expect((await saveSettings(S, true, true, 500)).ok).toBe(true);
    await platformOn();
    expect((await tolraMode(S, true)).ok).toBe(true);
    expect((await setTolraCap(S, 5000)).ok).toBe(true);
    expect(await settingsRow(S)).toMatchObject({ monthly_cap_pence: 500, roundup_enabled: true, rfq_enabled: true, assistant_enabled: true });
    const out = await inSequence(S, 10);
    expect(oks(out)).toBe(5);
    expect(caps(out)).toBe(5);
    expect(out.filter((o) => answer(o)?.ok).every((o) => answer(o)?.key_source === "tolra")).toBe(true);
    expect(await used(S)).toBe(500);
    expect(await capRefusals(S)).toEqual([{ key_source: "tolra", n: 5 }]);
    // A larger single request that would pass 500 is refused and nothing is left reserved by it.
    expect(answer(await reserve(S, "rfq", 1))).toMatchObject({ ok: false, reason: "cap" });
    expect(await reservedNow(S)).toBe(500);
  });

  it("(c) a Tolra cap lower than the own-key cap binds in own-key mode: Tolra 300 (company not on Tolra mode), own 1000, six 100p own-key reservations give exactly 3", async () => {
    const { T } = companies;
    expect((await setTolraCap(T, 300)).ok).toBe(true);
    expect(await tolraRow(T)).toEqual({ enabled: false, monthly_cap_pence: 300 });
    expect((await setKey(T, enc("t1"))).ok).toBe(true);
    expect((await saveSettings(T, true, true, 1000)).ok).toBe(true);
    expect((await admin(T, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const out = await inSequence(T, 6);
    expect(oks(out)).toBe(3);
    expect(caps(out)).toBe(3);
    expect(out.filter((o) => answer(o)?.ok).every((o) => answer(o)?.key_source !== "tolra")).toBe(true);
    expect(await used(T)).toBe(300);
    expect(await capRefusals(T)).toEqual([{ key_source: "own", n: 3 }]);
  });

  it("(d) concurrency: 25 reservations at once per company, in both modes, never pass least(own, Tolra): Tolra mode own 700 / Tolra 5000 gives 7, own-key mode own 5000 / Tolra 400 gives 4", async () => {
    const { U, V } = companies;
    expect((await setKey(U, enc("u1"))).ok).toBe(true);
    expect((await saveSettings(U, true, true, 700)).ok).toBe(true);
    await platformOn();
    expect((await tolraMode(U, true)).ok).toBe(true);
    expect((await setTolraCap(U, 5000)).ok).toBe(true);
    expect((await setTolraCap(V, 400)).ok).toBe(true);
    expect((await setKey(V, enc("v1"))).ok).toBe(true);
    expect((await saveSettings(V, true, true, 5000)).ok).toBe(true);
    expect((await admin(V, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const [u, v] = await Promise.all([burst(U, 25), burst(V, 25)]);
    expect(u.every((o) => o.ok)).toBe(true);
    expect(v.every((o) => o.ok)).toBe(true);
    expect(oks(u)).toBe(7);
    expect(caps(u)).toBe(18);
    expect(await used(U)).toBe(700);
    expect(oks(v)).toBe(4);
    expect(caps(v)).toBe(21);
    expect(await used(V)).toBe(400);
  });
});

describe("release 150: the own-key cap cannot be set below this month's spent + reserved", () => {
  const settingsAudits = (co: Co) => owned(async (db) => Number((await db.query("SELECT count(*) AS n FROM security_audit.audit_log WHERE organization_id=$1 AND action='ai_helper_settings_updated'", [co.id])).rows[0].n));
  it("a cap below spent + reserved is refused (22023 cap_below_usage) and changes nothing; equal to it is accepted and binds; out-of-range keeps its plain 22023", async () => {
    const { W } = companies;
    expect((await setKey(W, enc("w1"))).ok).toBe(true);
    expect((await saveSettings(W, true, true, 1000)).ok).toBe(true);
    const granted = [];
    for (let i = 0; i < 3; i++) granted.push(answer(await reserve(W, "roundup"))!.request_id as string);
    expect((await settle(granted[0], "suggested", 100)).ok).toBe(true);
    expect(await used(W)).toBe(300);
    const audits = await settingsAudits(W);
    for (const cap of [299, 1, 0]) expect(await saveSettings(W, false, false, cap)).toMatchObject({ ok: false, code: "22023", hint: "cap_below_usage" });
    expect(await settingsRow(W)).toMatchObject({ monthly_cap_pence: 1000, roundup_enabled: true, rfq_enabled: true });
    expect(await settingsAudits(W)).toBe(audits);
    expect(await saveSettings(W, true, true, 100001)).toMatchObject({ ok: false, code: "22023" });
    expect((await saveSettings(W, true, true, 300)).ok).toBe(true);
    expect(await settingsRow(W)).toMatchObject({ monthly_cap_pence: 300 });
    expect(await settingsAudits(W)).toBe(audits + 1);
    expect(answer(await reserve(W, "rfq", 1))).toMatchObject({ ok: false, reason: "cap" });
    // Releasing a reservation (failed at 0p) makes room again, and a cap down to the new use is then accepted.
    expect((await settle(granted[1], "failed", 0)).ok).toBe(true);
    expect((await saveSettings(W, true, true, 200)).ok).toBe(true);
    // An office user still cannot change the cap.
    expect((await office(W, "SELECT public.ai_helper_save_settings(TRUE,TRUE,5000) AS s")).ok).toBe(false);
  });

  it("a cap cut racing a burst of reservations: if the cut is accepted, used + reserved never ends above it; if refused, never above the old cap", async () => {
    const { X } = companies;
    expect((await setKey(X, enc("x1"))).ok).toBe(true);
    expect((await saveSettings(X, true, true, 2000)).ok).toBe(true);
    expect((await admin(X, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const [outs, cut] = await Promise.all([burst(X, 15), saveSettings(X, true, true, 600)]);
    expect(outs.every((o) => o.ok)).toBe(true);
    const total = await used(X);
    expect(total).toBe(oks(outs) * 100);
    if (cut.ok) {
      expect(total).toBeLessThanOrEqual(600);
      expect(await settingsRow(X)).toMatchObject({ monthly_cap_pence: 600 });
    } else {
      expect(cut).toMatchObject({ code: "22023", hint: "cap_below_usage" });
      expect(total).toBeLessThanOrEqual(2000);
      expect(await settingsRow(X)).toMatchObject({ monthly_cap_pence: 2000 });
    }
  });
});

describe("release 150 on a database that already holds companies, caps, keys and AI on", () => {
  it("rolls back to exactly 101, 122 and 146, then the shipped release is applied again: no existing row changes, switches stay on until a key changes AFTER 150", async () => {
    const { A, B, C, D, N } = companies;
    // 1. Roll 150 back: the default is 500 again and the key functions are the old ones (a key change no longer switches anything off).
    await owned((db) => db.query(read("supabase/release/150_ai_cap_key_off.rollback.sql")));
    const pre = await owned(async (db) => (await db.query(`SELECT (SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_helper_settings' AND column_name='monthly_cap_pence') AS d,
      (SELECT md5(regexp_replace(prosrc,'\\s','','g')) FROM pg_proc WHERE oid=to_regprocedure('public.ai_helper_set_key(text,text)')) AS k,
      (SELECT md5(regexp_replace(prosrc,'\\s','','g')) FROM pg_proc WHERE oid=to_regprocedure('public._ai_helper_status_own_key()')) AS s,
      (SELECT md5(regexp_replace(prosrc,'\\s','','g')) FROM pg_proc WHERE oid=to_regprocedure('public.ai_helper_tolra_configure(boolean,text,uuid)')) AS c,
      to_regprocedure('public._ai_helper_force_off(uuid,text)') IS NULL AS gone`)).rows[0]);
    expect(pre).toEqual({ d: "500", k: "a6680aba0f169e5331110ba388f05e49", s: "3ef44c838451b46ea14030164d9b1384", c: "a100254532a8b9635e0b2b0952801b60", gone: true });
    // 2. Companies as production has them: an explicit cap (A 700), an explicit 500 (B), a row that only carries the old default (C: key save), all with a key and AI on.
    const ids = [A.id, B.id, C.id, D.id, N.id];
    await owned((db) => db.query("DELETE FROM public.ai_helper_settings WHERE organization_id = ANY($1)", [ids]));
    await owned((db) => db.query("DELETE FROM public.ai_helper_secrets WHERE organization_id = ANY($1)", [ids]));
    for (const [co, cap] of [[A, 700], [B, 500]] as const) { expect((await setKey(co, enc("u1"))).ok).toBe(true); expect((await saveSettings(co, true, true, cap)).ok).toBe(true); }
    expect((await setKey(C, enc("u3"))).ok).toBe(true);
    await turnAllOn(C);
    expect(await settingsRow(C)).toMatchObject({ monthly_cap_pence: 500 });
    expect((await status(D)).monthly_cap_pence).toBe(500);
    const aBefore = (await forcedOff(A)).length;
    expect((await setKey(A, enc("u4"))).ok).toBe(true); // old behaviour: replacing leaves AI on
    expect(await settingsRow(A)).toMatchObject({ roundup_enabled: true, rfq_enabled: true, monthly_cap_pence: 700 });
    expect(await forcedOff(A)).toHaveLength(aBefore);
    const beforeDigest = await digests();
    const beforeRows = await Promise.all([A, B, C].map((c) => settingsRow(c)));

    // 3. Apply the shipped release file. It checks its own before and after image of every settings row inside the transaction.
    await owned((db) => db.query(RELEASE));
    expect(await digests()).toEqual(beforeDigest);
    expect(await Promise.all([A, B, C].map((c) => settingsRow(c)))).toEqual(beforeRows);
    const verify = await owned((db) => db.query(read("supabase/verify/ai_cap_key_off_150.sql")));
    expect(verify.rows.length).toBeGreaterThan(8);
    expect(verify.rows.filter((r) => r.ok !== true)).toEqual([]);
    expect(verify.rows.some((r) => /^info: \d+ existing ai_helper_settings rows carry 500/.test(String(r.check_name)))).toBe(true);
    const marker = await owned((db) => db.query(read("supabase/verify/release_preflight.sql")));
    const state = (name: string) => marker.rows.find((r) => r.check === name)?.value;
    expect(state("post-144 marker 150 ai_cap_key_off")).toBe("applied");
    expect(state("post-144 marker 146 tolra_provided_ai")).toBe("applied");
    expect(state("marker 122 ai helper cap default")).toBe("applied");
    // A second apply is refused and changes nothing.
    await expect(owned((db) => db.query(RELEASE))).rejects.toThrow(/150/);
    expect(await digests()).toEqual(beforeDigest);

    // 4. After 150: the old rows still read what they read and AI stays on for them; new rows get 1000; a key change NOW forces AI off.
    expect((await status(D)).monthly_cap_pence).toBe(1000); // no row: the fallback moved
    expect(await settingsRow(B)).toMatchObject({ monthly_cap_pence: 500, roundup_enabled: true });
    expect(await settingsRow(C)).toMatchObject({ monthly_cap_pence: 500, roundup_enabled: true, assistant_enabled: true });
    expect(answer(await reserve(A, "roundup"))?.ok).toBe(true);
    expect((await setKey(D, enc("u5"))).ok).toBe(true);
    expect(await settingsRow(D)).toMatchObject({ monthly_cap_pence: 1000 });
    expect((await setKey(A, enc("u6"))).ok).toBe(true);
    allOff(await settingsRow(A));
    expect(await settingsRow(A)).toMatchObject({ monthly_cap_pence: 700 });
    allOn(await settingsRow(C)); // C's key did not change: still on
    expect(await forcedOff(A)).toHaveLength(aBefore + 1);
  });

  it("the one statement an owner could run later to raise only rows that carry the old default: it picks C (default only) and leaves A (explicit 700) and B (explicit 500) alone; run here inside a rolled back transaction", async () => {
    const { A, B, C } = companies;
    const ONE_STATEMENT = `UPDATE public.ai_helper_settings s SET monthly_cap_pence = 1000
      WHERE s.monthly_cap_pence = 500
        AND NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = s.organization_id AND a.action = 'ai_helper_settings_updated'
                          AND a.entity_table = 'ai_helper_settings' AND a.metadata ? 'monthly_cap_pence')
      RETURNING s.organization_id`;
    const picked = await withDb(async (db) => {
      await db.query("BEGIN");
      try { return (await db.query(ONE_STATEMENT)).rows.map((r) => r.organization_id as string); } finally { await db.query("ROLLBACK"); }
    });
    expect(picked).toContain(C.id);
    expect(picked).not.toContain(A.id);
    expect(picked).not.toContain(B.id);
    expect(await settingsRow(C)).toMatchObject({ monthly_cap_pence: 500 }); // rolled back: nothing applied
  });
});
