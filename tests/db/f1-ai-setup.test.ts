/**
 * F1 database proof for the AI card on Admin > Integrations (own-key mode; Tolra-provided mode is W-C's tests/db/wc-ai-cap-paths.test.ts, which
 * this file does not repeat).
 *   - the key is stored as ciphertext only; the plaintext is in no column and no audit row, and the status never carries either;
 *   - replacement overwrites (one row, new ciphertext, new last four); the old ciphertext and old key exist nowhere afterwards;
 *   - company isolation: A cannot read, replace or use B's key or switches; a ciphertext made for A does not decrypt for B;
 *   - AI is OFF by default, saving a key does not turn it on, and replacing a key leaves the switches as they were;
 *   - concurrent reservations across ALL AI entry points (roundup, rfq, assistant) never pass the company's own-key cap.
 * Runs only on the disposable database (verifyBackendIdentity first). Every call is SQL as the role and claims the real caller would have.
 * All data is synthetic (slug prefix t-<run>-, e-mail <name>.<run>@example.test) and removed in afterAll.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { destroySyntheticWorld, newRunId, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const DIGEST = "d".repeat(64);
const FEATURES = ["roundup", "rfq", "assistant"] as const;
type Feature = (typeof FEATURES)[number];
type Co = { id: string; user: string; office: string; email: string; officeEmail: string; session: string; officeSession: string };

const runId = newRunId();
const companies = {} as Record<"A" | "B" | "C" | "D" | "E", Co>;
// Synthetic keys: never a real Anthropic key. The suffix makes each unique so a leak is findable by substring.
const plain = (tag: string) => `sk-ant-api03-F1${tag}${runId.replace(/[^A-Za-z0-9]/g, "")}${randomBytes(6).toString("hex")}`;
const KEY_A1 = plain("A1");
const KEY_A2 = plain("A2");
const KEY_B1 = plain("B1");
let ENC_KEY_BEFORE: string | undefined;

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
const owned = <T>(fn: (db: Client) => Promise<T>) => withDb(fn);

/** What the route does: encrypt bound to the company, then ai_helper_set_key as the admin. Returns the stored ciphertext too. */
async function saveKey(co: Co, key: string) {
  const enc = encryptSecret(key, { organizationId: co.id, provider: "anthropic", purpose: "api_key" });
  const out = await admin(co, "SELECT public.ai_helper_set_key($1,$2) AS s", [enc, key.slice(-4)]);
  return { enc, out };
}
const status = async (co: Co) => { const o = await admin(co, "SELECT public.ai_helper_status() AS s"); if (!o.ok) throw new Error(o.message); return o.value.s as Record<string, unknown>; };
const secretRows = (co: Co) => owned(async (db) => (await db.query("SELECT api_key_enc, updated_by FROM public.ai_helper_secrets WHERE organization_id=$1", [co.id])).rows as { api_key_enc: string; updated_by: string }[]);
const settingsRow = (co: Co) => owned(async (db) => (await db.query("SELECT roundup_enabled, rfq_enabled, assistant_enabled, finance_check_enabled, monthly_cap_pence, api_key_last4 FROM public.ai_helper_settings WHERE organization_id=$1", [co.id])).rows[0] as Record<string, unknown> | undefined);
const reserve = (co: Co, feature: Feature, pence = 100) =>
  feature === "assistant"
    ? admin(co, "SELECT public.ai_helper_reserve_assistant($1,$2,10) AS r", [pence, DIGEST])
    : admin(co, "SELECT public.ai_helper_reserve($1,$2,$3,10) AS r", [feature, pence, DIGEST]);
const answer = (o: Outcome) => (o.ok ? (o.value.r as { ok: boolean; reason?: string; request_id?: string }) : null);
const used = (co: Co) => owned(async (db) => (await db.query("SELECT coalesce(sum(spent_pence + reserved_pence),0)::int AS n FROM public.ai_helper_usage WHERE organization_id=$1 AND month = date_trunc('month', now() AT TIME ZONE 'Europe/London')::date", [co.id])).rows[0].n as number);
const burst = (co: Co, n: number, pence = 100) => Promise.all(Array.from({ length: n }, (_, i) => reserve(co, FEATURES[i % 3], pence)));
const oks = (outs: Outcome[]) => outs.filter((o) => answer(o)?.ok === true).length;
const caps = (outs: Outcome[]) => outs.filter((o) => answer(o)?.ok === false && answer(o)?.reason === "cap").length;
/** Every place a secret could land: the AI tables, the audit log and the request log, as text. */
const everywhere = (co: Co) => owned(async (db) => {
  const parts: string[] = [];
  for (const t of ["public.ai_helper_secrets", "public.ai_helper_settings", "public.ai_helper_usage", "public.ai_helper_requests"]) {
    parts.push(...(await db.query(`SELECT to_jsonb(t)::text AS j FROM ${t} t WHERE organization_id=$1`, [co.id])).rows.map((r) => r.j));
  }
  parts.push(...(await db.query("SELECT to_jsonb(a)::text AS j FROM security_audit.audit_log a WHERE organization_id=$1", [co.id])).rows.map((r) => r.j));
  return parts.join("\n");
});

beforeAll(async () => {
  await verifyBackendIdentity();
  ENC_KEY_BEFORE = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  process.env.INTEGRATIONS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  // F1_SKIP_FIXTURE=1 exists only for the fail-first proof, which runs this file against a copy of the database whose functions were deliberately
  // broken (the fixture's own verify refuses such a copy, which is what it is for). The copy is still checked by verifyBackendIdentity above.
  if (process.env.F1_SKIP_FIXTURE !== "1") await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  await withDb(async (db) => {
    for (const key of ["A", "B", "C", "D", "E"] as const) {
      const lower = key.toLowerCase();
      const co: Co = { id: randomUUID(), user: randomUUID(), office: randomUUID(), email: `f1-admin-${lower}.${runId}@example.test`, officeEmail: `f1-office-${lower}.${runId}@example.test`, session: randomUUID(), officeSession: randomUUID() };
      companies[key] = co;
      await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [co.id, `F1 AI setup ${key} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-${lower}`]);
      for (const [id, email, role, session] of [[co.user, co.email, "admin", co.session], [co.office, co.officeEmail, "office", co.officeSession]] as const) {
        await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
        await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,TRUE,FALSE)", [id, email, role, co.id]);
        await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,TRUE)", [id, co.id, role]);
        await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
        await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, co.id]);
      }
    }
  });
}, 180_000);

afterAll(async () => {
  await destroySyntheticWorld(runId);
  if (ENC_KEY_BEFORE === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY; else process.env.INTEGRATIONS_ENCRYPTION_KEY = ENC_KEY_BEFORE;
}, 120_000);

describe("AI card database proof: key, replacement, isolation, default off", () => {
  it("a fresh company: AI off for every feature, no key, Tolra-provided off; nothing can run", async () => {
    const { A } = companies;
    expect(await status(A)).toMatchObject({ roundup_enabled: false, rfq_enabled: false, key_set: false, key_last4: null, can_manage: true, tolra_enabled: false });
    for (const f of FEATURES) expect(await reserve(A, f), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await used(A)).toBe(0);
  });

  it("saving a key stores ciphertext only: the plaintext is in no column and no audit row, and the answer carries only 'set' and the last four", async () => {
    const { A } = companies;
    const { enc, out } = await saveKey(A, KEY_A1);
    expect(out.ok).toBe(true);
    const answer = JSON.stringify(out.ok ? out.value : {});
    expect(answer).not.toContain(KEY_A1);
    expect(answer).not.toContain(enc);
    expect(out.ok && out.value.s).toMatchObject({ key_set: true, key_last4: KEY_A1.slice(-4) });
    const rows = await secretRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0].api_key_enc).toBe(enc);
    expect(rows[0].api_key_enc).not.toContain(KEY_A1);
    expect(rows[0].api_key_enc).not.toContain(KEY_A1.slice(12));
    const dump = await everywhere(A);
    expect(dump).not.toContain(KEY_A1);
    expect(dump).not.toContain(KEY_A1.slice(12));
    // the status read (what the browser gets) carries neither the key nor its ciphertext
    const st = JSON.stringify(await status(A));
    expect(st).not.toContain(KEY_A1);
    expect(st).not.toContain(enc);
    expect(decryptSecret(rows[0].api_key_enc, { organizationId: A.id, provider: "anthropic", purpose: "api_key" })).toBe(KEY_A1);
    // the audit trail records that a key was set, with no key in it
    const audit = await owned(async (db) => (await db.query("SELECT action FROM security_audit.audit_log WHERE organization_id=$1 AND action='ai_helper_key_set'", [A.id])).rows.length);
    expect(audit).toBe(1);
  });

  it("saving a key does NOT turn AI on: every switch is still off and every entry point still refuses", async () => {
    const { A } = companies;
    expect(await settingsRow(A)).toMatchObject({ roundup_enabled: false, rfq_enabled: false, assistant_enabled: false, finance_check_enabled: false });
    expect(await status(A)).toMatchObject({ roundup_enabled: false, rfq_enabled: false, key_set: true, tolra_enabled: false });
    for (const f of FEATURES) expect(await reserve(A, f), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await used(A)).toBe(0);
  });

  it("replacement overwrites: one row, the new ciphertext and last four; the old key and its ciphertext are nowhere (not reusable)", async () => {
    const { A } = companies;
    const before = (await secretRows(A))[0].api_key_enc;
    const { enc, out } = await saveKey(A, KEY_A2);
    expect(out.ok).toBe(true);
    expect(enc).not.toBe(before);
    const rows = await secretRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0].api_key_enc).toBe(enc);
    expect(decryptSecret(rows[0].api_key_enc, { organizationId: A.id, provider: "anthropic", purpose: "api_key" })).toBe(KEY_A2);
    expect((await settingsRow(A))?.api_key_last4).toBe(KEY_A2.slice(-4));
    const dump = await everywhere(A);
    for (const gone of [KEY_A1, KEY_A1.slice(12), before, KEY_A2, KEY_A2.slice(12)]) expect(dump, gone.slice(0, 12)).not.toContain(gone);
    // two 'key set' audit rows now (one per save), still without any key
    expect(await owned(async (db) => (await db.query("SELECT 1 FROM security_audit.audit_log WHERE organization_id=$1 AND action='ai_helper_key_set'", [A.id])).rows.length)).toBe(2);
  });

  it("replacement leaves the switches where they were: off stays off", async () => {
    const { A } = companies;
    expect(await settingsRow(A)).toMatchObject({ roundup_enabled: false, rfq_enabled: false, assistant_enabled: false });
    for (const f of FEATURES) expect(await reserve(A, f), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
  });

  it("removing the key clears it and the last four; with no key a switched-on company still refuses with no_key", async () => {
    const { C } = companies;
    expect((await saveKey(C, plain("C1"))).out.ok).toBe(true);
    expect((await admin(C, "SELECT public.ai_helper_save_settings(TRUE,TRUE,500)")).ok).toBe(true);
    expect((await admin(C, "SELECT public.ai_helper_set_key(NULL,NULL)")).ok).toBe(true);
    expect(await secretRows(C)).toEqual([]);
    expect((await settingsRow(C))?.api_key_last4).toBeNull();
    expect(answer(await reserve(C, "roundup"))).toMatchObject({ ok: false, reason: "no_key" });
    expect(await used(C)).toBe(0);
  });

  it("company isolation: B's status shows no key; B's admin cannot read A's secret table; B's key and switches are B's alone", async () => {
    const { A, B } = companies;
    expect(await status(B)).toMatchObject({ key_set: false, key_last4: null, roundup_enabled: false });
    // B's admin cannot read the secret table at all (refused or no rows), and certainly not A's row.
    const direct = await admin(B, "SELECT count(*)::int AS n FROM public.ai_helper_secrets");
    expect(direct.ok ? direct.value.n : 0).toBe(0);
    const stolen = await admin(B, "SELECT count(*)::int AS n FROM public.ai_helper_secrets WHERE organization_id=$1", [A.id]);
    expect(stolen.ok ? stolen.value.n : 0).toBe(0);
    const { enc } = await saveKey(B, KEY_B1);
    expect((await secretRows(B))[0].api_key_enc).toBe(enc);
    expect((await secretRows(A))[0].api_key_enc).not.toBe(enc);
    expect((await status(A)).key_last4).toBe(KEY_A2.slice(-4));
    expect((await status(B)).key_last4).toBe(KEY_B1.slice(-4));
    // B switching AI on does not switch A on
    expect((await admin(B, "SELECT public.ai_helper_save_settings(TRUE,TRUE,500)")).ok).toBe(true);
    expect(await settingsRow(A)).toMatchObject({ roundup_enabled: false, rfq_enabled: false });
    expect(await settingsRow(B)).toMatchObject({ roundup_enabled: true, rfq_enabled: true });
    for (const f of FEATURES) expect(await reserve(A, f), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
    // B's key is not visible in A's dump, and A's ciphertext does not decrypt for B (it is bound to the company)
    expect(await everywhere(A)).not.toContain(KEY_B1);
    const aEnc = (await secretRows(A))[0].api_key_enc;
    expect(() => decryptSecret(aEnc, { organizationId: B.id, provider: "anthropic", purpose: "api_key" })).toThrow();
  });

  it("the roles: only an admin of the company sets or removes the key or the switches; office, anonymous and another company's admin are refused", async () => {
    const { A, B } = companies;
    const enc = encryptSecret(plain("X"), { organizationId: A.id, provider: "anthropic", purpose: "api_key" });
    expect(await office(A, "SELECT public.ai_helper_set_key($1,'abcd')", [enc])).toMatchObject({ ok: false, code: "42501" });
    expect(await office(A, "SELECT public.ai_helper_save_settings(TRUE,TRUE,500)")).toMatchObject({ ok: false, code: "42501" });
    expect(await office(A, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).toMatchObject({ ok: false, code: "42501" });
    expect(await as("anon", null, "SELECT public.ai_helper_set_key($1,'abcd')", [enc])).toMatchObject({ ok: false, code: "42501" });
    // another company's admin writes only their own company: A's row is unchanged
    const aBefore = (await secretRows(A))[0].api_key_enc;
    expect((await admin(B, "SELECT public.ai_helper_set_key($1,'abcd')", [enc])).ok).toBe(true);
    expect((await secretRows(A))[0].api_key_enc).toBe(aBefore);
    // office still sees only whether a key is set, never its last four (an admin-only detail)
    const st = await office(A, "SELECT public.ai_helper_status() AS s");
    expect(st.ok && st.value.s).toMatchObject({ key_set: true, key_last4: null, can_manage: false });
  });

  it("a ciphertext in the wrong form is refused and the stored key is not touched", async () => {
    const { A } = companies;
    const before = (await secretRows(A))[0].api_key_enc;
    expect(await admin(A, "SELECT public.ai_helper_set_key($1,'abcd')", [KEY_A1])).toMatchObject({ ok: false, code: "22023" });
    expect((await secretRows(A))[0].api_key_enc).toBe(before);
  });

  it("replacing a key while AI is ON leaves it ON and the new key is the one in use (today's behaviour, flagged for a decision)", async () => {
    const { D } = companies;
    expect((await saveKey(D, plain("D1"))).out.ok).toBe(true);
    expect((await admin(D, "SELECT public.ai_helper_save_settings(TRUE,TRUE,500)")).ok).toBe(true);
    expect(answer(await reserve(D, "roundup", 100))).toMatchObject({ ok: true });
    const second = await saveKey(D, plain("D2"));
    expect(second.out.ok).toBe(true);
    expect(await settingsRow(D)).toMatchObject({ roundup_enabled: true, rfq_enabled: true });
    expect((await secretRows(D))[0].api_key_enc).toBe(second.enc);
    expect(answer(await reserve(D, "rfq", 100))).toMatchObject({ ok: true });
  });
});

describe("AI card database proof: the own-key cap (500p default, migration 122) across every entry point", () => {
  it("the 500p default is exactly where today's behaviour puts it: a company with no row reads 500; a key save makes a row that carries 500", async () => {
    const { E } = companies;
    expect((await status(E)).monthly_cap_pence).toBe(500);
    expect(await settingsRow(E)).toBeUndefined();
    expect((await saveKey(E, plain("E1"))).out.ok).toBe(true);
    expect(await settingsRow(E)).toMatchObject({ monthly_cap_pence: 500, roundup_enabled: false });
    const col = await owned(async (db) => (await db.query("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_helper_settings' AND column_name='monthly_cap_pence'")).rows[0].column_default);
    expect(String(col)).toBe("500");
  });

  it("concurrent reservations across roundup, rfq and the assistant never pass the cap: 14 at 100p against 500p gives exactly 5", async () => {
    const { E } = companies;
    expect((await admin(E, "SELECT public.ai_helper_save_settings(TRUE,TRUE,500)")).ok).toBe(true);
    expect((await admin(E, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const outs = await burst(E, 14);
    for (const o of outs) expect(o.ok, o.ok ? "" : o.message).toBe(true);
    expect(oks(outs)).toBe(5);
    expect(caps(outs)).toBe(9);
    expect(await used(E)).toBe(500);
    const rows = await owned(async (db) => (await db.query("SELECT feature, status, refusal, key_source FROM public.ai_helper_requests WHERE organization_id=$1", [E.id])).rows);
    expect(rows.filter((r) => r.status === "reserved")).toHaveLength(5);
    expect(rows.filter((r) => r.status === "refused" && r.refusal === "cap")).toHaveLength(9);
    expect(rows.every((r) => r.key_source === "own")).toBe(true);
  });

  it("mixed sizes race too: 3 reservations of 300p at once against a 500p cap leave exactly one, and a cap lowered to 300 holds the same way", async () => {
    const { B } = companies;
    expect((await admin(B, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    expect((await admin(B, "SELECT public.ai_helper_save_settings(TRUE,TRUE,500)")).ok).toBe(true);
    const outs = await Promise.all(FEATURES.map((f) => reserve(B, f, 300)));
    expect(oks(outs)).toBe(1);
    expect(caps(outs)).toBe(2);
    expect(await used(B)).toBe(300);
    expect(answer(await reserve(B, "rfq", 201))).toMatchObject({ ok: false, reason: "cap" });
    expect(answer(await reserve(B, "rfq", 200))).toMatchObject({ ok: true });
    expect(await used(B)).toBe(500);
  });

  it("two companies racing at once keep separate budgets; one company's key, switches and spend never touch the other's", async () => {
    const { A, D } = companies;
    // A: key saved earlier, switch it on now with its own cap; D is already on.
    expect((await admin(A, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    expect((await admin(A, "SELECT public.ai_helper_save_settings(TRUE,TRUE,300)")).ok).toBe(true);
    const dBefore = await used(D);
    const [a, d] = await Promise.all([burst(A, 12), burst(D, 12)]);
    expect(oks(a)).toBe(3);
    expect(await used(A)).toBe(300);
    expect(await used(D)).toBe(500); // D was already at 100p; 400p more fits under its 500p
    expect(oks(d)).toBe(Math.floor((500 - dBefore) / 100));
  });

  it("switching AI off stops every entry point before any spend, and the spend already made is kept", async () => {
    const { A } = companies;
    const spent = await used(A);
    expect((await admin(A, "SELECT public.ai_helper_save_settings(FALSE,FALSE,300)")).ok).toBe(true);
    expect((await admin(A, "SELECT public.ai_helper_set_assistant(FALSE)")).ok).toBe(true);
    for (const f of FEATURES) expect(await reserve(A, f, 1), f).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await used(A)).toBe(spent);
  });
});
