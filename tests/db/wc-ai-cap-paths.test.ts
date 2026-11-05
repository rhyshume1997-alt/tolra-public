/**
 * W-C database proof: the Tolra-provided AI cap is PER COMPANY, off by default, and stops every entry point (ai_helper_reserve for
 * roundup and rfq, ai_helper_reserve_assistant for the assistant) at that company's own limit. Decision (Rhys, 5 Nov): provided
 * default 1000p, settable per company by the platform owner only; the company's own-key helper keeps its separate 500p default.
 *
 * Runs only on the disposable database (verifyBackendIdentity first). It brings 145/146/147 in through the same fixture the other
 * post-144 proofs use, with no REST layer: every call is SQL as the role and claims the real caller would have. All data is
 * synthetic (slug prefix t-<run>-, e-mail <name>.<run>@example.test) and removed in afterAll; the platform switch row is put back.
 * Needs release 146 SQL as shipped: this file never edits it.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { destroySyntheticWorld, newRunId, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const KEY_ENC = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";
const DIGEST = "d".repeat(64);
const FEATURES = ["roundup", "rfq", "assistant"] as const;
type Feature = (typeof FEATURES)[number];
type Co = { id: string; user: string; email: string; session: string };

const runId = newRunId();
const companies = {} as Record<"A" | "B" | "C" | "D" | "E" | "F" | "G", Co>;
const owner = { id: randomUUID(), email: `wc-owner.${runId}@example.test`, session: randomUUID() };
let control: { enabled: boolean; api_key_enc: string | null; updated_by: string | null; updated_at: string } | undefined;

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code?: string; hint?: string; message: string };
const claims = (c: { id?: string; user?: string; email: string; session: string }) =>
  JSON.stringify({ sub: c.user ?? c.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: c.email, session_id: c.session });

/** One statement as a signed-in company admin (role authenticated, that company's claims), in its own connection and transaction. */
async function asAdmin(co: Co, sql: string, params: unknown[] = []): Promise<Outcome> {
  return withDb(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,TRUE), set_config('request.jwt.claim.sub',$2,TRUE)", [claims(co), co.user]);
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
/** One statement as another role with no company claims (service_role or anon), in its own transaction. */
async function asRole(role: "service_role" | "anon" | "authenticated", sql: string, params: unknown[] = []): Promise<Outcome> {
  return withDb(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
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
const setCap = (co: Co, pence: number) => asRole("service_role", "SELECT public.ai_helper_tolra_set_cap($1,$2,$3)", [co.id, pence, owner.id]);
const reserve = (co: Co, feature: Feature, pence = 100) =>
  feature === "assistant"
    ? asAdmin(co, "SELECT public.ai_helper_reserve_assistant($1,$2,10) AS r", [pence, DIGEST])
    : asAdmin(co, "SELECT public.ai_helper_reserve($1,$2,$3,10) AS r", [feature, pence, DIGEST]);
const answer = (o: Outcome) => (o.ok ? (o.value.r as { ok: boolean; reason?: string; key_source?: string; request_id?: string }) : null);
const owned = async <T>(fn: (db: Client) => Promise<T>) => withDb(fn);
const used = (co: Co) => owned(async (db) => {
  const r = await db.query("SELECT coalesce(sum(spent_pence + reserved_pence),0)::int AS n FROM public.ai_helper_usage WHERE organization_id=$1 AND month = date_trunc('month', now() AT TIME ZONE 'Europe/London')::date", [co.id]);
  return r.rows[0].n as number;
});
const capOf = (co: Co) => owned(async (db) => (await db.query("SELECT monthly_cap_pence FROM public.ai_helper_tolra_caps() WHERE organization_id=$1", [co.id])).rows[0].monthly_cap_pence as number);
const tolraRow = (co: Co) => owned(async (db) => (await db.query("SELECT enabled, monthly_cap_pence FROM public.ai_helper_tolra_companies WHERE organization_id=$1", [co.id])).rows[0] as { enabled: boolean; monthly_cap_pence: number } | undefined);
const requests = (co: Co) => owned(async (db) => (await db.query("SELECT status, refusal, key_source FROM public.ai_helper_requests WHERE organization_id=$1 ORDER BY created_at", [co.id])).rows as { status: string; refusal: string | null; key_source: string }[]);
/** Runs `n` reservations at once, each on its own connection, rotating the features. */
const burst = (co: Co, n: number, pence = 100) => Promise.all(Array.from({ length: n }, (_, i) => reserve(co, FEATURES[i % 3], pence)));
const oks = (outs: Outcome[]) => outs.filter((o) => answer(o)?.ok === true).length;
const caps = (outs: Outcome[]) => outs.filter((o) => answer(o)?.ok === false && answer(o)?.reason === "cap").length;

beforeAll(async () => {
  await verifyBackendIdentity();
  // WC_SKIP_FIXTURE=1 exists only for the fail-first proof, which runs this file against a copy of the database whose 146 functions were
  // deliberately broken (the fixture's own verify would refuse that copy, which is what it is for). It still needs 146 to be there.
  if (process.env.WC_SKIP_FIXTURE === "1") {
    expect((await withDb((db) => db.query("SELECT to_regclass('public.ai_helper_tolra_companies') AS t"))).rows[0].t).not.toBeNull();
  } else {
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  }
  await withDb(async (db) => {
    control = (await db.query("SELECT enabled, api_key_enc, updated_by, updated_at FROM public.ai_helper_tolra_control WHERE singleton")).rows[0];
    expect(control).toBeDefined();
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [owner.id, owner.email]);
    await db.query("INSERT INTO security_audit.platform_admins(user_id) VALUES($1)", [owner.id]);
    for (const key of ["A", "B", "C", "D", "E", "F", "G"] as const) {
      const co: Co = { id: randomUUID(), user: randomUUID(), email: `wc-admin-${key.toLowerCase()}.${runId}@example.test`, session: randomUUID() };
      companies[key] = co;
      await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [co.id, `WC AI cap ${key} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-${key.toLowerCase()}`]);
      await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [co.user, co.email]);
      await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic admin','admin',$3,TRUE,FALSE)", [co.user, co.email, co.id]);
      await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',TRUE)", [co.user, co.id]);
      await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [co.session, co.user]);
      await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [co.session, co.user, co.id]);
    }
    // The platform owner switches provided AI ON with a synthetic ciphertext (no provider is ever called here).
    await db.query("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2)", [KEY_ENC, owner.id]);
  });
}, 180_000);

afterAll(async () => {
  await withDb(async (db) => {
    if (control) await db.query("UPDATE public.ai_helper_tolra_control SET enabled=$1, api_key_enc=$2, updated_by=$3, updated_at=$4 WHERE singleton", [control.enabled, control.api_key_enc, control.updated_by, control.updated_at]);
    await db.query("DELETE FROM security_audit.platform_admins WHERE user_id=$1", [owner.id]);
  });
  await destroySyntheticWorld(runId);
  await withDb((db) => db.query("DELETE FROM auth.users WHERE id=$1", [owner.id]));
}, 120_000);

describe("provided AI cap: per company, off by default, every entry point", () => {
  it("is off for every company by default: all three entry points refuse with the off hint and write nothing", async () => {
    const { A, B, C } = companies;
    const status = await asAdmin(B, "SELECT public.ai_helper_status() AS s");
    expect(status.ok && status.value.s).toMatchObject({ tolra_available: true, tolra_enabled: false, tolra_cap_pence: 1000 });
    for (const co of [A, B, C]) {
      for (const f of FEATURES) expect(await reserve(co, f), `${f}`).toMatchObject({ ok: false, hint: "ai_helper_off" });
      expect(await used(co)).toBe(0);
      expect(await requests(co)).toEqual([]);
    }
    // Setting a cap is not switching a company on.
    expect((await setCap(A, 500)).ok).toBe(true);
    expect(await tolraRow(A)).toEqual({ enabled: false, monthly_cap_pence: 500 });
    for (const f of FEATURES) expect(await reserve(A, f)).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await used(A)).toBe(0);
    // Every other company is still on the default, and no row means off.
    for (const co of [B, C]) expect(await capOf(co)).toBe(1000);
    expect(await tolraRow(B)).toBeUndefined();
  });

  it("only the service role can set a cap: signed-in company admins, anonymous callers and a non-owner id are refused", async () => {
    const { A, B } = companies;
    expect(await asAdmin(A, "SELECT public.ai_helper_tolra_set_cap($1,900,$2)", [B.id, owner.id])).toMatchObject({ ok: false, code: "42501" });
    expect(await asAdmin(A, "SELECT public.ai_helper_tolra_set_cap($1,900,$2)", [A.id, owner.id])).toMatchObject({ ok: false, code: "42501" });
    expect(await asAdmin(A, "SELECT * FROM public.ai_helper_tolra_caps()")).toMatchObject({ ok: false, code: "42501" });
    expect(await asRole("anon", "SELECT public.ai_helper_tolra_set_cap($1,900,$2)", [A.id, owner.id])).toMatchObject({ ok: false, code: "42501" });
    expect(await asRole("service_role", "SELECT public.ai_helper_tolra_set_cap($1,900,$2)", [A.id, A.user])).toMatchObject({ ok: false, code: "42501", message: expect.stringContaining("Owner required") });
    expect(await asAdmin(A, "UPDATE public.ai_helper_tolra_companies SET monthly_cap_pence=99999 WHERE organization_id=$1", [A.id])).toMatchObject({ ok: false, code: "42501" });
    expect(await capOf(A)).toBe(500);
    expect(await capOf(B)).toBe(1000);
  });

  it("a company chooses provided AI itself; that changes `enabled` and never its cap", async () => {
    const { A, B, D } = companies;
    expect((await setCap(D, 0)).ok).toBe(true);
    for (const co of [A, B, D]) expect((await asAdmin(co, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).ok).toBe(true);
    expect(await tolraRow(A)).toEqual({ enabled: true, monthly_cap_pence: 500 });
    expect(await tolraRow(B)).toEqual({ enabled: true, monthly_cap_pence: 1000 });
    expect(await tolraRow(D)).toEqual({ enabled: true, monthly_cap_pence: 0 });
    expect(await tolraRow(companies.C)).toBeUndefined();
  });

  it("each company stops at ITS cap through all three entry points: A at 500p, B at the 1000p default, D at 0p; C (not on provided AI) never runs", async () => {
    const { A, B, C, D } = companies;
    const a = []; const b = [];
    for (let i = 0; i < 15; i++) a.push(await reserve(A, FEATURES[i % 3]));
    for (let i = 0; i < 15; i++) b.push(await reserve(B, FEATURES[i % 3]));
    expect(oks(a)).toBe(5);
    expect(caps(a)).toBe(10);
    expect(oks(b)).toBe(10);
    expect(caps(b)).toBe(5);
    expect(await used(A)).toBe(500);
    expect(await used(B)).toBe(1000);
    for (const o of [...a, ...b]) if (answer(o)?.ok) expect(answer(o)?.key_source).toBe("tolra");
    // The first attempt of each feature at A fits (no feature has a cap of its own): ok/ok/ok, then rotation continues on the same budget.
    expect(a.slice(0, 3).map((o) => answer(o)?.ok)).toEqual([true, true, true]);
    // D's cap is 0: nothing fits, for any feature.
    for (const f of FEATURES) expect(answer(await reserve(D, f, 1))).toMatchObject({ ok: false, reason: "cap" });
    expect(await used(D)).toBe(0);
    // C is on no provided plan and has no own key or switch: refused off, no spend.
    for (const f of FEATURES) expect(await reserve(C, f)).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await used(C)).toBe(0);
    // Refusals are logged against the right company, as provided-mode cap refusals.
    const refusedA = (await requests(A)).filter((r) => r.status === "refused");
    expect(refusedA).toHaveLength(10);
    expect(refusedA.every((r) => r.refusal === "cap" && r.key_source === "tolra")).toBe(true);
  });

  it("changing one company's cap changes only that company; below used refuses; out-of-range refuses", async () => {
    const { A, B, C, D } = companies;
    expect(await capOf(B)).toBe(1000);
    expect((await setCap(A, 1000)).ok).toBe(true);
    expect(await capOf(A)).toBe(1000);
    expect(await capOf(B)).toBe(1000);
    expect(await capOf(D)).toBe(0);
    expect(await capOf(C)).toBe(1000);
    // B is still full at 1000, A now has room for exactly 5 more.
    expect(answer(await reserve(B, "rfq"))).toMatchObject({ ok: false, reason: "cap" });
    const more = [];
    for (let i = 0; i < 8; i++) more.push(await reserve(A, FEATURES[i % 3]));
    expect(oks(more)).toBe(5);
    expect(await used(A)).toBe(1000);
    expect(await used(B)).toBe(1000);
    // Below what is already used or reserved: refused with the hint, cap unchanged.
    expect(await setCap(A, 999)).toMatchObject({ ok: false, code: "22023", hint: "cap_below_usage" });
    expect(await capOf(A)).toBe(1000);
    for (const bad of [-1, 100001]) expect(await setCap(A, bad)).toMatchObject({ ok: false, code: "22023" });
    expect((await setCap(A, 1000)).ok).toBe(true); // equal to used is allowed
    // Raising D from 0 lets D run, and nobody else moves.
    expect((await setCap(D, 300)).ok).toBe(true);
    expect(answer(await reserve(D, "assistant", 300))).toMatchObject({ ok: true });
    expect(answer(await reserve(D, "assistant", 1))).toMatchObject({ ok: false, reason: "cap" });
    expect(await capOf(A)).toBe(1000);
    expect(await capOf(B)).toBe(1000);
  });

  it("the company's own-key limit cannot raise the provided cap; since release 150 (one company cap, the lower of the two) it can lower it", async () => {
    const { A } = companies;
    // A is full at 1000p of provided use. An own-key limit of 100000p does not make room.
    expect((await asAdmin(A, "SELECT public.ai_helper_save_settings(TRUE,TRUE,100000)")).ok).toBe(true);
    expect(answer(await reserve(A, "roundup"))).toMatchObject({ ok: false, reason: "cap" });
    // With the provided cap raised by 100p, an own-key limit of 1p now stops the provided request (release 150: least of the two caps).
    expect((await setCap(A, 1100)).ok).toBe(true);
    expect((await asAdmin(A, "SELECT public.ai_helper_save_settings(TRUE,TRUE,1)")).ok).toBe(true);
    expect(answer(await reserve(A, "roundup"))).toMatchObject({ ok: false, reason: "cap" });
    // With the own-key limit back above it, the provided cap binds again: exactly the 100p of room, then cap.
    expect((await asAdmin(A, "SELECT public.ai_helper_save_settings(TRUE,TRUE,100000)")).ok).toBe(true);
    expect(answer(await reserve(A, "roundup"))).toMatchObject({ ok: true, key_source: "tolra" });
    expect(answer(await reserve(A, "roundup"))).toMatchObject({ ok: false, reason: "cap" });
    expect(await capOf(A)).toBe(1100);
  });

  it("the company's own-key helper (not provided AI) now defaults to 1000p as well (release 150; it was 500p): a pin of the default", async () => {
    const { C } = companies;
    expect((await asAdmin(C, "SELECT public.ai_helper_set_key($1,'abcd')", [KEY_ENC])).ok).toBe(true);
    expect((await asAdmin(C, "SELECT public.ai_helper_set_assistant(TRUE)")).ok).toBe(true);
    const status = await asAdmin(C, "SELECT public.ai_helper_status() AS s");
    expect(status.ok && status.value.s).toMatchObject({ monthly_cap_pence: 1000, tolra_enabled: false, tolra_cap_pence: 1000 });
    const r = [];
    for (let i = 0; i < 12; i++) r.push(await reserve(C, "assistant"));
    expect(oks(r)).toBe(10);
    expect(caps(r)).toBe(2);
    // The own-key reserve does not name its source in the answer; the request log does.
    expect((await requests(C)).every((x) => x.key_source === "own")).toBe(true);
    expect(await used(C)).toBe(1000);
  });

  it("concurrent reservations never pass a company's own cap, and two companies racing at once keep separate budgets", async () => {
    const { E, F } = companies;
    expect((await setCap(E, 300)).ok).toBe(true);
    expect((await setCap(F, 500)).ok).toBe(true);
    for (const co of [E, F]) expect((await asAdmin(co, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).ok).toBe(true);
    const [e, f] = await Promise.all([burst(E, 14), burst(F, 14)]);
    for (const o of [...e, ...f]) expect(o.ok, o.ok ? "" : o.message).toBe(true);
    expect(oks(e)).toBe(3);
    expect(caps(e)).toBe(11);
    expect(oks(f)).toBe(5);
    expect(caps(f)).toBe(9);
    expect(await used(E)).toBe(300);
    expect(await used(F)).toBe(500);
    // Settling a failed request at zero cost gives its 100p back to that company only.
    const first = e.map(answer).find((x) => x?.ok)!.request_id!;
    await owned((db) => db.query("SELECT public.ai_helper_settle($1,'failed','unavailable',0,NULL,NULL)", [first]));
    expect(await used(E)).toBe(200);
    expect(await used(F)).toBe(500);
    expect(answer(await reserve(E, "rfq"))).toMatchObject({ ok: true });
    expect(answer(await reserve(E, "rfq"))).toMatchObject({ ok: false, reason: "cap" });
  });

  it("switching off is real: platform off, company off or no key all refuse every entry point before any spend, and the caps survive", async () => {
    const { E, F, G } = companies;
    // A live reserved request (1p of room made for it): Tolra's ciphertext is readable by the server for it only while the platform switch is on.
    expect((await setCap(F, 501)).ok).toBe(true);
    const live = answer(await reserve(F, "roundup", 1));
    expect(live).toMatchObject({ ok: true, key_source: "tolra" });
    const readKey = (req: string, org: string) => asRole("service_role", "SELECT public.ai_helper_tolra_key($1,$2) AS k", [req, org]);
    const keyOn = await readKey(live!.request_id!, F.id);
    expect(keyOn.ok && keyOn.value.k).toBe(KEY_ENC);
    const key = await readKey(live!.request_id!, E.id); // another company's id with this request: nothing
    expect(key.ok && key.value.k).toBeNull();
    const spent = { e: await used(E), f: await used(F) };
    const capsBefore = { e: await capOf(E), f: await capOf(F) };

    // Platform switch off.
    await owned((db) => db.query("SELECT public.ai_helper_tolra_configure(FALSE,NULL,$1)", [owner.id]));
    for (const co of [E, F]) for (const f of FEATURES) expect(await reserve(co, f, 1), `${f} platform off`).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect({ e: await used(E), f: await used(F) }).toEqual(spent);
    const keyOff = await readKey(live!.request_id!, F.id);
    expect(keyOff.ok && keyOff.value.k).toBeNull();
    // A company cannot switch itself on while the platform is off, and gets no row.
    expect(await asAdmin(G, "SELECT public.ai_helper_set_tolra_mode(TRUE)")).toMatchObject({ ok: false, code: "42501" });
    expect(await tolraRow(G)).toBeUndefined();

    // No key cannot be switched on at all: the table refuses `enabled` without a key.
    await owned(async (db) => {
      await db.query("BEGIN");
      await db.query("UPDATE public.ai_helper_tolra_control SET api_key_enc=NULL WHERE singleton");
      await expect(db.query("UPDATE public.ai_helper_tolra_control SET enabled=TRUE WHERE singleton")).rejects.toMatchObject({ code: "23514" });
      await db.query("ROLLBACK");
    });

    // Switched back on: no cap was touched, and each company is still held to its own.
    await owned((db) => db.query("SELECT public.ai_helper_tolra_configure(TRUE,NULL,$1)", [owner.id]));
    expect(await capOf(E)).toBe(capsBefore.e);
    expect(await capOf(F)).toBe(capsBefore.f);
    expect(answer(await reserve(F, "rfq"))).toMatchObject({ ok: false, reason: "cap" });

    // Company switch off: refused again for every entry point, and its cap is kept for when it comes back.
    expect((await asAdmin(E, "SELECT public.ai_helper_set_tolra_mode(FALSE)")).ok).toBe(true);
    for (const f of FEATURES) expect(await reserve(E, f, 1)).toMatchObject({ ok: false, hint: "ai_helper_off" });
    expect(await capOf(E)).toBe(300);
    expect(await used(E)).toBe(spent.e);
  });
});
