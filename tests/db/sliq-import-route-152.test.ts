/**
 * Release 152 (supabase/release/152_sliq_import_route.release.sql, phase 152 after 151): the SliQ go-live import route, end to end
 * below PostgREST.
 *
 * Synthetic SliQ-shaped CSV files -> lib/sliq-validate (must be ok) -> lib/sliq-import-build -> lib/sliq-import-route (preflight,
 * planned batches) -> import_sliq_preflight / import_sliq_batch, each call ONE transaction as the `authenticated` role with an admin's
 * JWT claims (as PostgREST runs it). Proves: preflight writes nothing; twice-run changes nothing; a killed batch and a failed batch
 * leave nothing and a retry completes once; the map and the data can't diverge (map kept / data wiped refuses loudly, map lost / data
 * kept refuses, never duplicates); counters only rise and numbering continues; balances equal the source; restore -> import again
 * gives identical results; credit notes; a hand-typed customer, an unresolvable invoice customer, a moved counter, an INV gap, a
 * different export and an oversized preflight are refused; the company comes from the session only; MFA, role and support rules
 * hold; the definer census of 152.
 *
 * Runs in CI like every tests/db file (TEST_DATABASE_URL, the disposable Supabase stack; isolation-checked): the post-144 release
 * fixture installs 145..152 (152 freshly applied onto 151 where it is not yet), then everything here runs in companies of its own
 * (slug t-<run>-...), removed afterwards by destroySyntheticWorld. Ranked with the post-144 proofs (tests/support/db-release-sequencer.ts).
 * The two proofs that need whole-database copies (restore before / after the import, and the rollback on an installed clone) are
 * in tests/local/sliq-import-152-clones.test.ts, run by hand with vitest.local.config.ts; they are not part of CI.
 * Not PostgREST: request size limits, the 8 s statement_timeout of the hosted API and its error mapping are not proved here.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { MAPPING, N_CRD, N_INV, syntheticFiles } from "../support/sliq-152";
import { recordsCreated } from "@/lib/sliq-card";
import { sourceTotalsFromValidated, validateAndBuild } from "@/lib/sliq-import-build";
import type { ValidationReport } from "@/lib/sliq-validate";
import { type DbRow, reconcile } from "@/lib/sliq-reconcile/reconcile";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Rpc, type SliqBatchResult, type SliqPayload, planSliqBatches, sliqPreflight, sliqRunBatches } from "@/lib/sliq-import-route";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-sliq-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;


let pool: Pool;
let payload: SliqPayload;
let report: ValidationReport;
const org = randomUUID();
const otherOrg = randomUUID();
const uid = randomUUID();
const otherUid = randomUUID();
const officeUid = randomUUID();
const claims = (sub: string, aal = "aal2") => ({ sub, role: "authenticated", aal, email: `${sub.slice(0, 8)}@example.test` });

function openPool() {
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 4 });
  // The killed-connection test ends a backend on purpose; an idle pooled client then reports it here (not an unhandled error).
  const killed = (e: Error) => { if (!/terminat/i.test(e.message)) throw e; };
  pool.on("error", killed);
  pool.on("connect", (client) => { client.on("error", killed); });
}

/** rpc(fn, namedArgs) as PostgREST would run it: one transaction, role authenticated, the caller's claims. */
function rpcAs(sub: string | null, aal = "aal2", role = "authenticated"): Rpc {
  return async (fn, args) => {
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query(`set local role ${role}`);
      if (sub) await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(sub, aal)), sub]);
      const names = Object.keys(args);
      const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
      const { rows } = await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, values);
      await db.query("commit");
      return { data: rows[0].r, error: null };
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      const err = e as { message: string; code?: string; hint?: string };
      return { data: null, error: { message: err.message, code: err.code, hint: err.hint } };
    } finally {
      db.release();
    }
  };
}
const rpc = () => rpcAs(uid);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}

/** Everything the import can change for the company, as text: counts, money, counters, map, audit rows. */
async function state(o: string = org) {
  const [r] = await q(`select
    (select count(*) from customers where organization_id = $1)::int as customers,
    (select count(*) from suppliers where organization_id = $1)::int as suppliers,
    (select count(*) from invoices where organization_id = $1)::int as invoices,
    (select count(*) from invoice_payments where organization_id = $1)::int as payments,
    (select coalesce(sum(total), 0)::text from invoices where organization_id = $1) as invoiced,
    (select coalesce(sum(amount_paid), 0)::text from invoices where organization_id = $1) as paid,
    (select coalesce(sum(amount), 0)::text from invoice_payments where organization_id = $1) as payments_sum,
    (select count(*) from credit_notes where organization_id = $1)::int as credit_notes,
    (select coalesce(sum(credited_amount), 0)::text from invoices where organization_id = $1) as credited,
    (select count(*) from invoices v where organization_id = $1 and amount_paid <> coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id = v.id), 0))::int as paid_mismatch,
    (select count(*) from (select lower(name) from customers where organization_id = $1 group by 1 having count(*) > 1) d)::int as dup_customers,
    (select count(*) from (select invoice_ref from invoices where organization_id = $1 group by 1 having count(*) > 1) d)::int as dup_invoices,
    (select last from doc_counters where organization_id = $1 and prefix = 'INV') as inv_counter,
    (select count(*) from import_source_rows where organization_id = $1)::int as map_rows,
    (select count(*) from import_source_batches where organization_id = $1)::int as batches`, [o]);
  return r;
}

async function sqlFileRows(o: string = org): Promise<DbRow[]> {
  const sql = readFileSync(path.resolve(__dirname, "../../supabase/verify/sliq_reconcile.sql"), "utf8").replace("00000000-0000-0000-0000-000000000000", o);
  const db = await pool.connect();
  try {
    const res = (await db.query(sql)) as unknown as { rows: DbRow[] }[];
    return (Array.isArray(res) ? res : [res]).flatMap((r) => r.rows ?? []).filter((r) => r && "metric" in r);
  } finally { db.release(); }
}
let countersBefore: Record<string, number> = {};
/** The import's identifiers: each map row's (entity, source row id) with the record's own name or number, and the record id. */
async function identity(o: string = org) {
  return q<{ k: string; id: string }>(`select m.entity || '|' || m.source_row_id || '|' || coalesce(c.name, s.name, v.invoice_ref || '|' || v.customer, y.amount::text, n.credit_ref) as k,
      coalesce(m.customer_id, m.supplier_id, m.invoice_id, m.payment_id, m.credit_note_id)::text as id
    from import_source_rows m left join customers c on c.id = m.customer_id left join suppliers s on s.id = m.supplier_id
    left join invoices v on v.id = m.invoice_id left join invoice_payments y on y.id = m.payment_id left join credit_notes n on n.id = m.credit_note_id
    where m.organization_id = $1 order by 1`, [o]);
}
async function auditHashes(o: string = org) {
  const rows = await q<{ m: { source_sha256: string; source_files: { name: string; sha256: string }[] } }>(`select metadata as m from security_audit.audit_log where organization_id = $1 and action = 'IMPORT_SOURCE_BATCH'`, [o]);
  return [...new Set(rows.map((r) => `${r.m.source_sha256}|${r.m.source_files.map((f) => `${f.name}:${f.sha256}`).sort().join(",")}`))];
}
/** A synthetic company (slug t-<run>-...) and a person in it; destroySyntheticWorld(runId) removes both. */
async function makeCompany(o: string = randomUUID() as string) {
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic SliQ ${o.slice(0, 8)}`, slug("co")]);
  return o;
}
async function makePerson(o: string, role: string, u: string = randomUUID() as string) {
  const e = email(role);
  await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
  await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [u, e, role, o]);
  await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, $3, true)", [o, u, role]);
  return u;
}
async function newCompany() {
  const o = await makeCompany();
  const u = await makePerson(o, "admin");
  return { o, u };
}
let firstIdentity: { k: string; id: string }[] = [];
async function reconcileNow(sub = uid, o = org) {
  const viaRpc = ((await rpcAs(sub)("import_sliq_reconcile", {})).data as { rows: DbRow[] }).rows;
  const viaSql = await sqlFileRows(o);
  const norm = (rows: DbRow[]) => rows.map((r) => `${r.metric}|${r.key}|${r.value}`).sort();
  expect(norm(viaRpc)).toEqual(norm(viaSql));
  return reconcile(sourceTotalsFromValidated(report, payload), viaRpc, { countersBefore });
}

async function wipeData(o: string = org) {
  // As the owner, the way a wipe runbook would: payments, invoices, customers, suppliers (their map rows go with them, ON DELETE CASCADE).
  await q(`begin; select set_config('quoteflow.data_import_undo', '${o}', true);
    delete from invoice_credit_allocations where organization_id = '${o}'; delete from credit_note_lines where organization_id = '${o}';
    delete from credit_notes where organization_id = '${o}';
    delete from invoice_payments where organization_id = '${o}'; delete from invoice_line_items where organization_id = '${o}';
    delete from invoices where organization_id = '${o}'; delete from customers where organization_id = '${o}'; delete from suppliers where organization_id = '${o}'; commit;`);
}

describe("release 152 SliQ import route", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    // 145..152 on this disposable database (152 applied fresh onto 151 when it is not there yet), each verify file all true.
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    openPool();
    for (const [o, u] of [[org, uid], [otherOrg, otherUid]] as const) {
      await makeCompany(o);
      await makePerson(o, "admin", u);
    }
    await makePerson(org, "office", officeUid);

    // Every file check (lib/sliq-validate, Web Crypto, as the browser card runs it), then the payload.
    const built = await validateAndBuild(syntheticFiles(), MAPPING);
    expect(built.report.errors).toEqual([]);
    expect(built.report.ok).toBe(true);
    report = built.report;
    payload = built.payload!;
    // Counters the route must never move (staged-import assessment item d): DLN before Rhys's G17 sign-off, and QUO.
    await q("insert into doc_counters (organization_id, prefix, last) values ($1, 'DLN', 12), ($1, 'QUO', 3)", [org]);
  });

  afterAll(async () => {
    if (pool) {
      // The support test's platform-owner rows are not company rows: removed here, then everything of the run's companies.
      await q("delete from security_audit.session_company where user_id in (select id from auth.users where email like $1)", [`%.${runId}@${EMAIL_DOMAIN}`]).catch(() => undefined);
      await q("delete from security_audit.platform_admins where user_id in (select id from auth.users where email like $1)", [`%.${runId}@${EMAIL_DOMAIN}`]).catch(() => undefined);
      await pool.end();
    }
    await destroySyntheticWorld(runId);
  });

  it("census: only the preflight, the batch and the reconciliation are callable, all SECURITY DEFINER, by signed-in users only", async () => {
    const rows = await q<{ sig: string; definer: boolean; auth: boolean; anon: boolean; service: boolean }>(`
      select p.oid::regprocedure::text as sig, p.prosecdef as definer, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p where p.proname like 'import_sliq%' or p.proname like 'import_source%' order by 1`);
    const callable = ["import_sliq_batch(text,jsonb,text,text,integer,jsonb,boolean,boolean)", "import_sliq_preflight(text,jsonb,jsonb,boolean)", "import_sliq_reconcile()"];
    expect(rows.filter((r) => r.auth).map((r) => r.sig).sort()).toEqual(callable);
    expect(rows.filter((r) => r.definer).map((r) => r.sig).sort()).toEqual(callable);
    expect(rows.some((r) => r.anon || r.service)).toBe(false);
    const [rls] = await q(`select bool_and(relrowsecurity) as rls from pg_class where relname in ('import_source_rows', 'import_source_batches')`);
    expect(rls.rls).toBe(true);
  });

  it("refuses: anonymous, a non-admin, an admin without the second step when the company asks for it, a source key that is not the files'", async () => {
    expect((await sliqPreflight(rpcAs(null, "aal2", "anon"), payload).catch((e) => e)).code).toBe("42501");
    expect((await sliqPreflight(rpcAs(officeUid), payload).catch((e) => e)).code).toBe("42501");
    await q("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'test', 'totp', 'verified', now(), now())", [uid]);
    await q("update organizations set require_admin_mfa = true where id = $1", [org]);
    expect((await sliqPreflight(rpcAs(uid, "aal1"), payload).catch((e) => e)).hint).toBe("mfa_required");
    await q("update organizations set require_admin_mfa = false where id = $1", [org]);
    const forged = { ...payload, source_files: payload.source_files.map((f, i) => (i === 0 ? { ...f, sha256: "0".repeat(64) } : f)) };
    expect((await sliqPreflight(rpc(), forged).catch((e) => e)).hint).toBe("source_sha_mismatch");
  });

  it("preflight: the whole file, nothing written, counts and money; bad rows refused with reasons", async () => {
    const before = await state();
    const pf = await sliqPreflight(rpc(), payload);
    expect(pf.errors).toEqual([]);
    expect(pf.ok).toBe(true);
    countersBefore = Object.fromEntries(((await rpc()("import_sliq_reconcile", {})).data as { rows: DbRow[] }).rows.filter((r) => r.metric === "counter_last").map((r) => [r.key, Number(r.value)]));
    expect(countersBefore).toMatchObject({ DLN: 12, QUO: 3 });
    expect(pf.counts.credit_notes.to_create).toBe(N_CRD);
    expect(Number(pf.money.credited)).toBe(N_CRD * 10);
    expect(pf.counts.customers.to_create).toBe(12);
    expect(pf.counts.invoices.to_create).toBe(N_INV);
    expect(pf.counts.payments.to_create).toBe(payload.payments!.length);
    expect(Number(pf.money.paid)).toBeCloseTo(payload.payments!.reduce((s, p) => s + Number(p.amount), 0), 2);
    expect(Number(pf.money.invoiced)).toBeCloseTo(payload.invoices!.reduce((s, i) => s + Number(i.total), 0), 2);
    expect(await state()).toEqual(before);

    const bad: SliqPayload = { ...payload, invoices: [...payload.invoices!], payments: [...payload.payments!,
      { source_row_id: "P:OVER", invoice_ref: "INV-1004", paid_on: "2026-10-30", amount: "99999.00" },
      { source_row_id: "P:NOINV", invoice_ref: "INV-9999", paid_on: "2026-10-30", amount: "1.00" }] };
    bad.invoices!.push({ source_row_id: "I:BADDATE", invoice_ref: "INV-1999", customer: "Synthetic Customer 1 Ltd", invoice_date: "31/02/2026", total: "1.00" });
    const pfb = await sliqPreflight(rpc(), bad);
    expect(pfb.ok).toBe(false);
    const msgs = pfb.errors.map((e) => `${e.source_row_id}: ${e.message}`).join("\n");
    expect(msgs).toMatch(/I:INV-1004: .*more than its total/);
    expect(msgs).toMatch(/P:NOINV: .*no invoice INV-9999/);
    expect(msgs).toMatch(/I:BADDATE: .*real date/);
    expect(await state()).toEqual(before);
  });

  let first: Awaited<ReturnType<typeof state>>;
  let firstResults: SliqBatchResult[] = [];

  it("imports in planned batches; balances equal the source; counters rise to the highest number; numbering continues", async () => {
    const plan = planSliqBatches(payload, 60);
    expect(plan.orphanPayments).toEqual([]);
    expect(plan.batches.length).toBeGreaterThan(3);
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    firstResults = run.results;
    expect(run.results.every((r) => r.ok && r.committed && !r.already_imported)).toBe(true);
    first = await state();
    expect(first).toMatchObject({ customers: 12, suppliers: 3, invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_customers: 0, dup_invoices: 0, inv_counter: 1000 + N_INV });
    expect(Number(first.payments_sum)).toBeCloseTo(payload.payments!.reduce((s, p) => s + Number(p.amount), 0), 2);
    expect(first.paid).toBe(first.payments_sum);
    expect(Number(first.invoiced)).toBeCloseTo(payload.invoices!.reduce((s, i) => s + Number(i.total), 0), 2);
    expect(first.map_rows).toBe(12 + 3 + N_INV + payload.payments!.length + N_CRD);
    expect(first.credit_notes).toBe(N_CRD);
    expect(Number(first.credited)).toBe(N_CRD * 10);
    // The batch audit row names the original files and their SHA-256.
    const audit = await q<{ m: { source_files: { sha256: string }[] } }>(`select metadata as m from security_audit.audit_log where organization_id = $1 and action = 'IMPORT_SOURCE_BATCH'`, [org]);
    expect(audit.length).toBe(plan.batches.length);
    expect(audit[0].m.source_files.map((f) => f.sha256).sort()).toEqual(payload.source_files.map((f) => f.sha256).sort());
    // 076's own audit for the records is there too, one per batch that wrote.
    const [c] = await q<{ n: number }>(`select count(*)::int as n from security_audit.audit_log where organization_id = $1 and action = 'IMPORT_COMMITTED'`, [org]);
    expect(c.n).toBe(plan.batches.length);
    // The independent reconciliation passes: source totals from the VALIDATOR (adapter, keyed by account code as the map stores it),
    // database rows from the card's RPC and from the SQL-editor script (they must be the same rows).
    const rec = await reconcileNow();
    expect(rec.rows.filter((r) => r.status !== "PASS")).toEqual([]);
    expect(rec.pass).toBe(true);
    expect(rec.rows.find((r) => r.check === "credits total (pence)")?.database).toBe(String(N_CRD * 1000));
    // Credit notes take no counter: the next CRD number is above the highest imported one.
    expect(String((await rpc()("next_doc_number", { p_prefix: "CRD" })).data)).toBe(`CRD-${2001 + N_CRD}`);
    // Only INV moved: DLN (no delivery notes before Rhys's G17 sign-off) and QUO are exactly as before.
    expect(await q("select prefix, last::int as last from doc_counters where organization_id = $1 and prefix in ('DLN', 'QUO') order by 1", [org])).toEqual([{ prefix: "DLN", last: 12 }, { prefix: "QUO", last: 3 }]);
    firstIdentity = await identity();
    expect(firstIdentity.length).toBe(first.map_rows);
    expect(await auditHashes()).toEqual([`${payload.source_sha256}|${payload.source_files.map((f) => `${f.name}:${f.sha256}`).sort().join(",")}`]);
    // Numbering continues after the highest imported number (the app's own next_doc_number).
    const next = await rpc()("next_doc_number", { p_prefix: "INV" });
    expect(next.data).toBe(`INV-${1001 + N_INV}`);
    first = await state();
  });

  it("twice-run: every batch answers already imported with the same counts; nothing changes", async () => {
    const run = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect(run.results.every((r) => r.already_imported && r.replayed)).toBe(true);
    expect(run.results.map((r) => [r.entity, r.batch_no, r.created, r.rows])).toEqual(firstResults.map((r) => [r.entity, r.batch_no, r.created, r.rows]));
    expect(await state()).toEqual(first);
    // A new run label over the same file: every row is already in the map; nothing is written, each batch says so.
    const again = await sliqRunBatches(rpc(), payload, "live-check", undefined, 0, 60);
    expect(again.results.every((r) => r.ok && r.created === 0 && r.already_imported)).toBe(true);
    expect({ ...(await state()), batches: 0 }).toEqual({ ...first, batches: 0 });
  });

  it("the same batch key with different rows is refused (batch_reused)", async () => {
    const b = planSliqBatches(payload, 60).batches[0];
    const r = await rpc()("import_sliq_batch", { p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_run_label: "live", p_entity: b.entity, p_batch_no: b.batchNo,
      p_rows: { customers: b.rows.customers!.slice(1) }, p_dry_run: false });
    expect(r.error?.hint).toBe("batch_reused");
  });

  it("map lost, data kept: refused (map_diverged), never a duplicate; a map row can't be removed while its record exists", async () => {
    const del = await q("select 1").then(async () => {
      try { await q(`delete from import_source_rows where organization_id = $1 and entity = 'customer'`, [org]); return null; } catch (e) { return (e as { hint?: string }).hint; }
    });
    expect(del).toBe("import_map_locked");
    const upd = await q(`update import_source_rows set source_row_id = 'x' where organization_id = $1 and entity = 'customer'`, [org]).then(() => null, (e) => e.hint);
    expect(upd).toBe("import_map_locked");
    // The owner removes the map behind the guard's back (TRUNCATE): the data stays.
    await q("alter table import_source_rows disable trigger import_source_rows_guard");
    await q("delete from import_source_rows where organization_id = $1", [org]);
    await q("alter table import_source_rows enable trigger import_source_rows_guard");
    const before = await state();
    const run = await sliqRunBatches(rpc(), payload, "after-map-loss", undefined, 0, 60);
    expect(run.failedAt).toBe(0);
    expect(run.last?.errors?.[0]?.code).toBe("map_diverged");
    const pf = await sliqPreflight(rpc(), payload);
    expect(pf.ok).toBe(false);
    expect(new Set(pf.errors.map((e) => e.code))).toEqual(new Set(["map_diverged"]));
    expect(pf.counts.invoices.problems).toBe(N_INV);
    expect(await state()).toEqual(before);
    expect((await state()).dup_customers).toBe(0);
  });

  it("map kept, data wiped: the map goes with the data; the old run refuses loudly (records_removed); a new run imports once", async () => {
    const counterBefore = (await state()).inv_counter; // 1061: next_doc_number took INV-1061 on this copy above
    await wipeData();
    const wiped = await state();
    expect(wiped.inv_counter).toBe(counterBefore);
    expect(wiped).toMatchObject({ customers: 0, invoices: 0, payments: 0, map_rows: 0 });
    const old = await sliqRunBatches(rpc(), payload, "live", undefined, 0, 60);
    expect(old.failedAt).toBe(0);
    expect((old.error as { hint?: string }).hint).toBe("records_removed");
    expect(await state()).toEqual(wiped);
    const fresh = await sliqRunBatches(rpc(), payload, "live-2", undefined, 0, 60);
    expect(fresh.failedAt).toBeNull();
    // The counter never goes back: it stays at 1061, above the highest imported number.
    expect(await state()).toMatchObject({ customers: 12, invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_customers: 0, inv_counter: counterBefore });
    expect(counterBefore).toBe(1001 + N_INV);
  });

  it("counters only rise: a counter above the imported numbers stays; an invoice keyed by hand under an imported number is refused", async () => {
    await wipeData();
    await q("update doc_counters set last = 5000 where organization_id = $1 and prefix = 'INV'", [org]);
    const run = await sliqRunBatches(rpc(), payload, "live-3", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect((await state()).inv_counter).toBe(5000);
    await wipeData();
    await q(`insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, 'INV-1010', 'Someone Else', 'draft', 1, 1, 0)`, [org]);
    const pf = await sliqPreflight(rpc(), payload);
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e) => e.source_row_id === "I:INV-1010")).toBe(true);
  });

  it("a batch that fails half way leaves nothing; a retry after the fault completes once", async () => {
    await wipeData();
    await q("delete from invoices where organization_id = $1", [org]);
    const before = await state();
    await q(`create or replace function public._t152_boom() returns trigger language plpgsql as $$ begin
      if (select invoice_ref from invoices where id = new.invoice_id) = 'INV-1045' then raise exception 'synthetic fault mid-batch'; end if; return new; end $$`);
    await q("create trigger t152_boom before insert on invoice_payments for each row execute function public._t152_boom()");
    const run = await sliqRunBatches(rpc(), payload, "live-4", undefined, 0, 60);
    expect(run.failedAt).not.toBeNull();
    expect(run.last?.ok).toBe(false);
    expect(run.last?.errors?.[0]?.message).toMatch(/synthetic fault/);
    const failedBatch = planSliqBatches(payload, 60).batches[run.failedAt!];
    const refs = (failedBatch.rows.invoices ?? []).map((i) => i.invoice_ref);
    expect((await q(`select count(*)::int as n from invoices where organization_id = $1 and invoice_ref = any($2)`, [org, refs]))[0].n).toBe(0);
    expect((await q(`select count(*)::int as n from import_source_batches where organization_id = $1 and run_label = 'live-4' and entity = $2 and batch_no = $3`, [org, failedBatch.entity, failedBatch.batchNo]))[0].n).toBe(0);
    await q("drop trigger t152_boom on invoice_payments");
    const retry = await sliqRunBatches(rpc(), payload, "live-4", undefined, run.failedAt!, 60);
    expect(retry.failedAt).toBeNull();
    const s = await state();
    expect(s).toMatchObject({ invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_invoices: 0 });
    expect(before.invoices).toBe(0);
  });

  it("a killed connection mid-batch leaves nothing; the retry completes once", async () => {
    await wipeData();
    await q(`create or replace function public._t152_slow() returns trigger language plpgsql as $$ begin
      if (select invoice_ref from invoices where id = new.invoice_id) = 'INV-1045' then perform pg_sleep(30); end if; return new; end $$`);
    await q("create trigger t152_slow before insert on invoice_payments for each row execute function public._t152_slow()");
    const pending = sliqRunBatches(rpc(), payload, "live-5", undefined, 0, 60);
    let killed = 0;
    for (let i = 0; i < 100 && !killed; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      killed = (await q<{ n: number }>(`select count(pg_terminate_backend(pid))::int as n from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and pid <> pg_backend_pid()`))[0].n;
    }
    expect(killed).toBe(1);
    const run = await pending;
    expect(run.failedAt).not.toBeNull();
    await q("drop trigger t152_slow on invoice_payments");
    const failedBatch = planSliqBatches(payload, 60).batches[run.failedAt!];
    const refs = (failedBatch.rows.invoices ?? []).map((i) => i.invoice_ref);
    expect((await q(`select count(*)::int as n from invoices where organization_id = $1 and invoice_ref = any($2)`, [org, refs]))[0].n).toBe(0);
    const retry = await sliqRunBatches(rpc(), payload, "live-5", undefined, run.failedAt!, 60);
    expect(retry.failedAt).toBeNull();
    expect(await state()).toMatchObject({ invoices: N_INV, payments: payload.payments!.length, paid_mismatch: 0, dup_invoices: 0, dup_customers: 0 });
  });

  it("a customer typed by hand before the import is refused and listed, never created a second time (b)", async () => {
    const c = await newCompany();
    await q("insert into customers (organization_id, name) values ($1, 'synthetic customer 5 LIMITED')", [c.o]);
    const pf = await sliqPreflight(rpcAs(c.u), payload);
    expect(pf.ok).toBe(false);
    expect(pf.errors.filter((e) => e.code === "already_in_tolra").map((e) => e.source_row_id)).toEqual(["C:ACC005"]);
    const run = await sliqRunBatches(rpcAs(c.u), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBe(0);
    expect(run.last?.errors?.map((e) => e.code)).toContain("already_in_tolra");
    expect(await state(c.o)).toMatchObject({ customers: 1, invoices: 0, map_rows: 0, batches: 0 });
  });

  it("every invoice must name exactly one customer: none, or two by Tolra's name rule, is refused (a)", async () => {
    const c = await newCompany();
    await q("insert into customers (organization_id, name) values ($1, 'Twin Ltd'), ($1, 'TWIN LIMITED')", [c.o]);
    const files = [{ entity: "invoices", name: "i.csv", sha256: "e".repeat(64) }] as SliqPayload["source_files"];
    const key = (await q<{ h: string }>("select encode(sha256(convert_to('invoices:' || repeat('e', 64), 'UTF8')), 'hex') as h"))[0].h;
    const pf = await sliqPreflight(rpcAs(c.u), { source_sha256: key, source_files: files, invoices: [
      { source_row_id: "I:X1", invoice_ref: "INV-9001", customer: "Nobody Ltd", invoice_date: "2026-01-15", total: "10.00" },
      { source_row_id: "I:X2", invoice_ref: "INV-9002", customer: "Twin Ltd", invoice_date: "2026-01-15", total: "10.00" }] });
    const why = Object.fromEntries(pf.errors.filter((e) => e.code === "customer_unresolved").map((e) => [e.source_row_id, e.message]));
    expect(why["I:X1"]).toMatch(/not in Tolra or in this file/);
    expect(why["I:X2"]).toMatch(/matches 2 customers/);
  });

  it("already-imported rows the export now describes differently are listed, kept as in Tolra, nothing written (c)", async () => {
    const before = await state();
    const changed: SliqPayload = { ...payload,
      customers: payload.customers!.map((r) => (r.source_row_id === "C:ACC001" ? { ...r, name: "Renamed Fabrications Ltd" } : r)),
      invoices: payload.invoices!.map((r) => (r.source_row_id === "I:INV-1002" ? { ...r, total: "1.00" } : r)) };
    const pf = await sliqPreflight(rpc(), changed);
    expect(pf.ok).toBe(true);
    const listed = (pf.changed_since_import ?? []).map((w) => `${w.source_row_id}:${w.field}`);
    expect(listed).toEqual(expect.arrayContaining(["C:ACC001:name", "I:INV-1002:total"]));
    expect(listed.length).toBe(2);
    expect(await state()).toEqual(before);
  });

  it("a batch that would move any counter but INV (QUO, J, PO, SO, DLN) is refused and rolled back (d)", async () => {
    const c = await newCompany();
    await q("insert into doc_counters (organization_id, prefix, last) values ($1, 'QUO', 3), ($1, 'DLN', 12)", [c.o]);
    // A quote numbered above the QUO counter (typed by hand): 076's reseed would raise QUO, which this route may not do.
    await q("insert into quotes (organization_id, quote_ref, customer, status, total_value) values ($1, 'QUO-99', 'Somebody', 'draft', 1)", [c.o]);
    const run = await sliqRunBatches(rpcAs(c.u), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBe(0);
    expect(run.last?.errors?.[0]?.message).toMatch(/counter_changed: QUO 3 -> 99/);
    expect(await state(c.o)).toMatchObject({ customers: 0, map_rows: 0, batches: 0 });
    expect(await q("select prefix, last::int as last from doc_counters where organization_id = $1 order by 1", [c.o])).toEqual([{ prefix: "DLN", last: 12 }, { prefix: "QUO", last: 3 }]);
  });

  it("DB review: a different export reusing imported row ids is refused (other_source_file); nothing written", async () => {
    const before = await state();
    const other: SliqPayload = { ...payload, source_files: payload.source_files.map((f) => (f.entity === "customers" ? { ...f, sha256: "d".repeat(64) } : f)) };
    other.source_sha256 = (await q<{ h: string }>("select encode(sha256(convert_to($1, 'UTF8')), 'hex') as h",
      [other.source_files.map((f) => `${f.entity}:${f.sha256}`).sort().join("\n")]))[0].h;
    const pf = await sliqPreflight(rpc(), other);
    expect(pf.ok).toBe(false);
    expect(pf.errors.filter((e) => e.code === "other_source_file").length).toBe(first.map_rows);
    const run = await sliqRunBatches(rpc(), other, "other-export", undefined, 0, 60);
    expect(run.failedAt).toBe(0);
    expect(run.last?.errors?.[0]?.code).toBe("other_source_file");
    expect(await state()).toEqual(before);
  });

  it("DB review: an INV number far above its nearest lower one is refused unless the call allows it; the preflight applies the counter rule; too large is refused", async () => {
    const c = await newCompany();
    const typo: SliqPayload = { ...payload, invoices: payload.invoices!.map((r) => (r.source_row_id === "I:INV-1060" ? { ...r, invoice_ref: "INV-999999999" } : r)),
      payments: payload.payments!.filter((x) => x.invoice_ref !== "INV-1060"), credit_notes: payload.credit_notes };
    const pf = await sliqPreflight(rpcAs(c.u), typo);
    expect(pf.errors.filter((e) => e.code === "inv_gap").map((e) => e.source_row_id)).toEqual(["I:INV-1060"]);
    const allowed = await sliqPreflight(rpcAs(c.u), typo, { allowInvGap: true });
    expect(allowed.errors.filter((e) => e.code === "inv_gap")).toEqual([]);
    // The batch refuses the same way (the first invoices batch that holds it), and nothing in that batch is written.
    const run = await sliqRunBatches(rpcAs(c.u), typo, "gap", undefined, 0, 60);
    expect(run.failedAt).not.toBeNull();
    expect(run.last?.errors?.map((e) => e.code)).toContain("inv_gap");
    expect((await q("select count(*)::int as n from invoices where organization_id = $1 and invoice_ref = 'INV-999999999'", [c.o]))[0].n).toBe(0);
    expect((await q("select last::int as last from doc_counters where organization_id = $1 and prefix = 'INV'", [c.o]))[0]?.last ?? 0).toBeLessThan(2000);
    // Counter rule in the preflight: a hand-typed QUO-99 above QUO 3 makes the PREFLIGHT fail too (not only the batch).
    const d = await newCompany();
    await q("insert into doc_counters (organization_id, prefix, last) values ($1, 'QUO', 3)", [d.o]);
    await q("insert into quotes (organization_id, quote_ref, customer, status, total_value) values ($1, 'QUO-99', 'Somebody', 'draft', 1)", [d.o]);
    const pq = await sliqPreflight(rpcAs(d.u), payload);
    expect(pq.ok).toBe(false);
    expect(pq.errors.find((e) => e.code === "counter_changed")?.message).toMatch(/QUO 3 -> 99/);
    // Too large for one call: refused before anything is checked, with the limit in words.
    const big: SliqPayload = { ...payload, customers: Array.from({ length: 6001 }, (_, i) => ({ source_row_id: `C:Z${i}`, name: `Z ${i}`, external_ref: `Z${i}` })) };
    const tooBig = await sliqPreflight(rpcAs(d.u), big).catch((e) => e);
    expect(tooBig.hint).toBe("preflight_too_large");
  });

  it("re-review: an UNSORTED invoice file gets the same INV-gap answer in the preflight and in the batches; an empty company's first number is limited", async () => {
    const c = await newCompany();
    // 60 invoices plus INV-1900..INV-2100 (dense: no gap above 1,000), in descending order: the highest comes first in the file.
    const extra = Array.from({ length: 201 }, (_, k) => ({ source_row_id: `I:INV-${1900 + k}`, invoice_ref: `INV-${1900 + k}`, customer: "Synthetic Customer 1 Ltd",
      customer_key: "ACC001", invoice_date: "2026-03-14", total: "1.00", status: "sent" }));
    const unsorted: SliqPayload = { ...payload, invoices: [...payload.invoices!, ...extra].reverse() };
    const pf = await sliqPreflight(rpcAs(c.u), unsorted);
    expect(pf.errors).toEqual([]);
    const run = await sliqRunBatches(rpcAs(c.u), unsorted, "unsorted", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect((await state(c.o)).invoices).toBe(N_INV + 201);
    // An empty company: the first INV number is measured from 0 with a limit of 100,000.
    const e = await newCompany();
    const files = [{ entity: "invoices", name: "i.csv", sha256: "f".repeat(64) }] as SliqPayload["source_files"];
    const key = (await q<{ h: string }>("select encode(sha256(convert_to('invoices:' || repeat('f', 64), 'UTF8')), 'hex') as h"))[0].h;
    await q("insert into customers (organization_id, name) values ($1, 'First Ltd')", [e.o]);
    const one = (ref: string) => sliqPreflight(rpcAs(e.u), { source_sha256: key, source_files: files, invoices: [{ source_row_id: `I:${ref}`, invoice_ref: ref, customer: "First Ltd", invoice_date: "2026-01-15", total: "1.00" }] });
    expect((await one("INV-100000")).errors.filter((x) => x.code === "inv_gap")).toEqual([]);
    const far = await one("INV-100001");
    expect(far.errors.find((x) => x.code === "inv_gap")?.message).toMatch(/above the INV counter \(0\)/);
  });

  it("DB review: the preflight's owed and the reconciliation's outstanding agree, payment-to-confirm invoices included", async () => {
    const c = await newCompany();
    const marked: SliqPayload = { ...payload, invoices: payload.invoices!.map((r) => (r.source_row_id === "I:INV-1024" ? { ...r, status: "paid" } : r)) };
    const pf = await sliqPreflight(rpcAs(c.u), marked);
    expect(pf.ok).toBe(true);
    expect(pf.money.payment_to_confirm).toBe(1);
    const run = await sliqRunBatches(rpcAs(c.u), marked, "owed", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    const rows = ((await rpcAs(c.u)("import_sliq_reconcile", {})).data as { rows: DbRow[] }).rows;
    const outstanding = Number(rows.find((r) => r.metric === "total_pence" && r.key === "outstanding")!.value);
    expect(Math.round(Number(pf.money.owed) * 100)).toBe(outstanding);
  });

  it("permissions: every 152 function, as anon, service_role, a non-admin, an admin without the second step, a support session and an admin", async () => {
    const c = await newCompany();
    const office = await makePerson(c.o, "office");
    const support = randomUUID();
    const grant = randomUUID();
    const sessionId = randomUUID();
    const se = email("support");
    await q("insert into auth.users (id, email) values ($1, $2)", [support, se]);
    await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', 'admin', $3, true, false)", [support, se, c.o]);
    // A platform owner in a support session for this company (036/066): a support membership under a grant, the session's chosen company.
    await q("insert into security_audit.platform_admins (user_id) values ($1)", [support]);
    await q("insert into organization_members (organization_id, user_id, role, active, support, expires_at, support_grant) values ($1, $2, 'admin', true, true, now() + interval '1 hour', $3)", [c.o, support, grant]);
    await q("insert into auth.sessions (id, user_id, aal) values ($1, $2, 'aal2')", [sessionId, support]);
    await q("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [sessionId, support, c.o, grant]);
    await q("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'test', 'totp', 'verified', now(), now())", [c.u]);

    const callAs = async (role: string, claim: Record<string, unknown> | null, fn: string, args: Record<string, unknown>) => {
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(`set local role ${role}`);
        if (claim) await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claim), String(claim.sub)]);
        const names = Object.keys(args);
        const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
        await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`, values);
        return "ok";
      } catch (e) {
        const x = e as { code?: string; hint?: string };
        return `${x.code}${x.hint ? `/${x.hint}` : ""}`;
      } finally {
        await db.query("rollback").catch(() => undefined);
        db.release();
      }
    };
    const b = planSliqBatches(payload, 60).batches[0];
    const calls: Record<string, Record<string, unknown>> = {
      import_sliq_preflight: { p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_payload: { customers: payload.customers } },
      import_sliq_batch: { p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_run_label: "perm", p_entity: b.entity, p_batch_no: 1, p_rows: b.rows, p_dry_run: true },
      import_sliq_reconcile: {},
    };
    const who: Record<string, [string, Record<string, unknown> | null]> = {
      anon: ["anon", null],
      service_role: ["service_role", { sub: c.u, role: "service_role" }],
      office: ["authenticated", claims(office)],
      support: ["authenticated", { ...claims(support), session_id: sessionId }],
      admin_aal2: ["authenticated", claims(c.u)],
    };
    const table: Record<string, Record<string, string>> = {};
    for (const [name, [role, claim]] of Object.entries(who)) {
      table[name] = {};
      for (const [fn, args] of Object.entries(calls)) table[name][fn] = await callAs(role, claim, fn, args);
    }
    // With the company asking for the second step, an admin at aal1 is refused; at aal2 allowed.
    await q("update organizations set require_admin_mfa = true where id = $1", [c.o]);
    table.admin_aal1 = {};
    for (const [fn, args] of Object.entries(calls)) table.admin_aal1[fn] = await callAs("authenticated", claims(c.u, "aal1"), fn, args);
    table.admin_aal2_mfa_required = {};
    for (const [fn, args] of Object.entries(calls)) table.admin_aal2_mfa_required[fn] = await callAs("authenticated", claims(c.u, "aal2"), fn, args);
    await q("update organizations set require_admin_mfa = false where id = $1", [c.o]);
    const all = (v: string) => ({ import_sliq_preflight: v, import_sliq_batch: v, import_sliq_reconcile: v });
    expect(table).toEqual({
      anon: all("42501"),
      service_role: all("42501"),
      office: all("42501/admin_only"),
      support: all("42501/support_session"),
      admin_aal2: all("ok"),
      admin_aal1: all("42501/mfa_required"),
      admin_aal2_mfa_required: all("ok"),
    });
    // The internal functions: nobody through the API, admin included.
    const internal = await q<{ sig: string; a: boolean; n: boolean; s: boolean }>(`select p.oid::regprocedure::text as sig, has_function_privilege('authenticated', p.oid, 'EXECUTE') as a,
      has_function_privilege('anon', p.oid, 'EXECUTE') as n, has_function_privilege('service_role', p.oid, 'EXECUTE') as s
      from pg_proc p where (p.proname like 'import_sliq%' or p.proname like 'import_source%') and p.proname not in ('import_sliq_preflight', 'import_sliq_batch', 'import_sliq_reconcile')`);
    expect(internal.length).toBe(9);
    expect(internal.filter((r) => r.a || r.n || r.s)).toEqual([]);
    expect(await callAs("authenticated", claims(c.u), "import_sliq_reconcile_rows", { p_org: c.o })).toBe("42501");
    // Nothing was written by any of it (dry runs and refusals).
    expect(await state(c.o)).toMatchObject({ customers: 0, map_rows: 0, batches: 0 });
  });

  it("the company comes from the session only: the other company's admin imports into its own company; it can't read this one's map", async () => {
    const otherBefore = await state(otherOrg);
    const mineBefore = await state();
    const run = await sliqRunBatches(rpcAs(otherUid), payload, "live", undefined, 0, 60);
    expect(run.failedAt).toBeNull();
    expect(await state()).toEqual(mineBefore);
    expect((await state(otherOrg)).invoices).toBe(Number(otherBefore.invoices) + N_INV);
    const seen = await rpcAs(otherUid)("import_sliq_preflight", { p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_payload: { customers: payload.customers } });
    expect((seen.data as { counts: { customers: { already_imported: number } } }).counts.customers.already_imported).toBe(12);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(otherUid)), otherUid]);
      const { rows } = await db.query("select count(*)::int as n from import_source_rows where organization_id = $1", [org]);
      expect(rows[0].n).toBe(0);
      await db.query("rollback");
    } finally { db.release(); }
  });

  // The browser spec's own files (tests/e2e/sliq-import.spec.ts, refs S1001 / S1002), and the same files with INV-number refs and with
  // plain-number refs. Refs are kept as written; only INV-<digits> refs move the INV counter (076/085); the reconciliation passes for
  // all three, and a second run (the spec's re-run test) writes nothing.
  for (const [label, r1, r2] of [["S-prefix (the e2e files)", "S1001", "S1002"], ["INV-number", "INV-1001", "INV-1002"], ["plain number", "1001", "1002"]] as const) {
    it(`invoice refs as SliQ writes them, ${label}: imported as written; the reconciliation passes; a re-run writes nothing`, async () => {
      const { o, u } = await newCompany();
      const built = await validateAndBuild(smallFiles(r1, r2), SMALL_MAPPING);
      expect(built.report.errors).toEqual([]);
      const p = built.payload!;
      const call = rpcAs(u);
      const reconRows = async () => ((await call("import_sliq_reconcile", {})).data as { rows: DbRow[] }).rows;
      const before: Record<string, number> = {};
      for (const r of await reconRows()) if (r.metric === "counter_last") before[r.key] = Number(r.value);
      expect((await sliqPreflight(call, p)).ok).toBe(true);
      expect((await sliqRunBatches(call, p, "live", undefined, 0, 60)).failedAt).toBeNull();
      const s = await state(o);
      expect(s).toMatchObject({ customers: 2, suppliers: 1, invoices: 2, payments: 2, paid_mismatch: 0 });
      expect(s.inv_counter === null || s.inv_counter === undefined ? null : Number(s.inv_counter)).toBe(r1.startsWith("INV-") ? 1002 : null);
      expect((await q<{ r: string }>("select invoice_ref as r from invoices where organization_id = $1 order by 1", [o])).map((x) => x.r)).toEqual([r1, r2]);
      const rec = reconcile(sourceTotalsFromValidated(built.report, p), await reconRows(), { countersBefore: before });
      expect(rec.rows.filter((r) => r.status !== "PASS")).toEqual([]);
      expect(rec.pass).toBe(true);
      const again = await sliqPreflight(call, p);
      for (const k of ["customers", "invoices", "payments"] as const) expect(again.counts[k]).toMatchObject({ to_create: 0, already_imported: 2, problems: 0 });
      const rerun = await sliqRunBatches(call, p, "live", undefined, 0, 60);
      expect(rerun.failedAt).toBeNull();
      // Every batch answers already imported (a replay carries the first run's counts); the card counts only batches that wrote: 0.
      expect(rerun.results.every((r) => r.already_imported)).toBe(true);
      expect(recordsCreated(rerun.results)).toBe(0);
      expect(await state(o)).toEqual(s);
    });
  }
});

/** tests/e2e/sliq-import.spec.ts's CSV and mapping, with the two invoice refs given. */
const SMALL_MAPPING = {
  version: 1, confirmed: true, dateFormat: "DD/MM/YYYY",
  dateSample: { file: "invoices.csv", row: 2, raw: "25/03/2026", means: "2026-03-25", confirmedBy: "John (synthetic e2e)" },
  entities: {
    customers: { file: "customers.csv", columns: { key: "Account", name: "Name" } },
    suppliers: { file: "suppliers.csv", columns: { key: "Account", name: "Name" } },
    invoices: { file: "invoices.csv", columns: { ref: "Invoice No", customerKey: "Account", date: "Date", gross: "Gross" } },
    payments: { file: "payments.csv", columns: { invoiceRef: "Invoice No", date: "Received", amount: "Amount" } },
  },
};
function smallFiles(r1: string, r2: string) {
  const f = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });
  return {
    customers: f("customers.csv", "Account,Name\r\nC001,Alpha Fabrications Ltd\r\nC002,Beta Engineering Limited\r\n"),
    suppliers: f("suppliers.csv", "Account,Name\r\nSUP1,Steel Supplies Ltd\r\n"),
    invoices: f("invoices.csv", `Invoice No,Date,Account,Gross\r\n${r1},25/03/2026,C001,120.00\r\n${r2},26/03/2026,C002,600.00\r\n`),
    payments: f("payments.csv", `Invoice No,Received,Amount\r\n${r1},27/03/2026,120.00\r\n${r2},30/03/2026,100.00\r\n`),
  };
}

