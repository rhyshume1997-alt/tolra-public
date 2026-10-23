/**
 * Data import (migration 076), the SQL behind Admin > Data import: a small file in one call (import_company_data), a large one staged,
 * validated whole and committed in parts (import_stage_part, import_validate, import_commit_part), undone part by part (import_undo).
 *
 *   * import_norm_name is normaliseName (scripts/sliq-import/ids.mjs) in SQL: the same answer for the same names; import_clean_text
 *     undoes our CSV export's formula apostrophe (lib/html.ts neutraliseCsvText);
 *   * admin of the session's company only: office, workshop and viewer refused, a support session refused, nothing written;
 *   * all or nothing: one bad row and nothing is committed; a dry run leaves nothing behind but its batch row, with the exact counts;
 *   * matched rows are skipped (matched_existing), never updated: a second import of the same file creates nothing;
 *   * company from the session only: the same file into another company is a separate import, and neither sees the other's batches;
 *   * issued, sent, part-paid and paid invoices go in with their lines and payments, and the issue guards stay on for everything else;
 *   * numbering continues after the highest imported INV, QUO, PO, J, SO and DLN; keyed replay;
 *   * a number already in Tolra with other content is a problem, never an overwrite;
 *   * large: nothing is committed until the whole file has validated; a part that fails leaves nothing of itself; undo removes only
 *     what that import created (back to the exact before-state, by checksums), never a row that existed before, and refuses (keeps and
 *     reports) a row changed or used after the import, also when the change is in progress while the undo runs;
 *   * timing (IMPORT_TIMING=1 only): about 2,000 invoices, 2,000 payments and 1,400 quotes, in one call and in parts.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { neutraliseCsvText } from "@/lib/html";

import { normaliseName } from "../../scripts/sliq-import/ids.mjs";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

import { type Who, as, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;
const orgA = () => world.tenants.alpha.id;
const orgB = () => world.tenants.beta.id;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

type Counts = { created: number; matched_existing: number; errors: number };
type Problem = { kind: string | null; row: number | null; field: string | null; message: string };
type Result = {
  ok: boolean; dry_run: boolean; committed: boolean; replayed: boolean; batch_id: string | null; counts: Record<string, Counts>;
  error_count: number; errors: Problem[]; warning_count: number; warnings: Problem[]; doc_counters: Record<string, number> | null;
};
const IMPORT = "select public.import_company_data($1::jsonb, $2, $3) as r";
const importAs = (who: Who, payload: unknown, dry = false, key: string = randomUUID()) =>
  q<{ r: Result }>(who, IMPORT, [JSON.stringify(payload), dry, key]).then((rows) => rows[0].r);
const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const count = async (table: string, org: string) => Number((await sql<{ n: string }>(`select count(*)::text as n from public.${table} where organization_id = $1`, [org]))[0].n);
const SHA = "a".repeat(64);

/** Checksums of the company's business records (doc_counters, audit and import bookkeeping excluded: see docs/RELEASE.md "076"). */
const BUSINESS = ["customers", "suppliers", "stock", "quotes", "quote_line_items", "sales_orders", "jobs", "job_values", "purchase_orders", "invoices",
  "invoice_line_items", "invoice_payments", "delivery_notes", "import_record_keys"];
const checksums = (org: string) => withDb(async (db) => {
  const out: Record<string, string> = {};
  for (const t of BUSINESS) {
    out[t] = (await db.query<{ m: string }>(`select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by to_jsonb(r)::text), '')) as m from public.${t} r where organization_id = $1`, [org])).rows[0].m;
  }
  return out;
});

type Large = Result & { import_id: string; part: number | null; parts: number | null; parts_committed?: number; status?: string; large?: boolean;
  deleted?: Record<string, number>; refused?: { kind: string; ref: string; reason: string }[]; refused_count?: number; parts_left?: number };
const STAGE = "select public.import_stage_part($1, $2, $3::jsonb) as r";
const VALIDATE = "select public.import_validate($1, $2, $3) as r";
const COMMIT = "select public.import_commit_part($1, $2) as r";
const UNDO = "select public.import_undo($1, $2) as r";
const call = (who: Who, text: string, params: unknown[]) => q<{ r: Large }>(who, text, params).then((rows) => rows[0].r);
/** Stages the parts as the app would send them, then validates the whole file. */
async function stageAndValidate(who: Who, parts: unknown[], weight = 50, id: string = randomUUID()) {
  for (const [i, p] of parts.entries()) await call(who, STAGE, [id, i + 1, JSON.stringify(p)]);
  return { id, v: await call(who, VALIDATE, [id, weight, randomUUID()]) };
}
async function commitAll(who: Who, id: string) {
  const out: Large[] = [];
  for (;;) {
    const r = await call(who, COMMIT, [id, randomUUID()]);
    out.push(r);
    if (!r.ok || r.parts_committed === r.parts) return out;
  }
}
async function undoAll(who: Who, id: string) {
  const out: Large[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await call(who, UNDO, [id, randomUUID()]);
    out.push(r);
    if (r.status === "undone" || r.status === "cancelled") return out;
  }
  throw new Error("undo did not finish");
}

describe("normalised names and cell text (parity with the JavaScript)", () => {
  it("import_norm_name gives normaliseName's answer", async () => {
    const names = ["Smith & Sons Limited", "  SMITH and sons ltd. ", "A.B.C. (UK) LIMITED", "unlimited supplies limited", "École d'Été Ltd", "Ørsted A/S",
      "Straße Bau GmbH", "İstanbul Metal", "ﬁne ﬂow ltd", "Ｆｕｌｌｗｉｄｔｈ Ｌｔｄ", "José   Núñez\tLimited", "M&S", "Limited", "--", "", "Ångström 2000 & co", "O'Neill-Hughes Ltd"];
    const rows = await sql<{ n: string }>("select public.import_norm_name(x) as n from unnest($1::text[]) with ordinality u(x, o) order by o", [names]);
    expect(rows.map((r) => r.n)).toEqual(names.map((n) => normaliseName(n)));
    expect((await sql<{ n: string }>("select public.import_norm_name(null) as n"))[0].n).toBe(normaliseName(null));
    expect((await sql<{ v: string }>("select provolatile as v from pg_proc where oid = 'public.import_norm_name(text)'::regprocedure"))[0].v).toBe("i");
  });

  it("import_clean_text undoes the export's formula apostrophe and nothing else", async () => {
    const texts = ["=SUM(A1:A3)", "+44 1234 567890", "-not a number", "@handle", "-12.50", "12", "'quoted already", "plain", "  padded  "];
    const exported = texts.map((t) => neutraliseCsvText(t));
    expect(exported[0]).toBe("'=SUM(A1:A3)");
    const rows = await sql<{ t: string | null }>("select public.import_clean_text(x) as t from unnest($1::text[]) with ordinality u(x, o) order by o", [exported]);
    expect(rows.map((r) => r.t)).toEqual(texts.map((t) => t.trim()));
    expect((await sql<{ t: string | null }>("select public.import_clean_text('   ') as t"))[0].t).toBeNull();
  });
});

describe("who may import", () => {
  const payload = () => ({ file_name: "people.csv", file_sha256: SHA, customers: [{ name: `Refused Co ${randomUUID()}` }] });

  it("office, workshop and viewer are refused; nothing is written", async () => {
    const before = await count("customers", orgA());
    for (const who of [A().office, A().workshop, A().viewer]) {
      expect(await refusal(who, IMPORT, [JSON.stringify(payload()), false, randomUUID()])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await refusal(who, IMPORT, [JSON.stringify(payload()), true, randomUUID()])).toMatchObject({ code: "42501", hint: "admin_only" });
    }
    expect(await count("customers", orgA())).toBe(before);
    expect(await count("import_batches", orgA())).toBe(0);
    // The large-import functions too.
    const id = randomUUID();
    for (const who of [A().office, A().workshop, A().viewer]) {
      expect(await refusal(who, STAGE, [id, 1, JSON.stringify(payload())])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await refusal(who, VALIDATE, [id, 750, randomUUID()])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await refusal(who, COMMIT, [id, randomUUID()])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await refusal(who, UNDO, [id, randomUUID()])).toMatchObject({ code: "42501", hint: "admin_only" });
    }
    expect(await count("import_runs", orgA())).toBe(0);
  });

  it("a support session is refused, even with write access", async () => {
    const owner = { id: randomUUID(), email: `support.${world.runId}@example.test` };
    const session = randomUUID();
    await withDb(async (db) => {
      await db.query("insert into auth.users (id, email) values ($1, $2)", [owner.id, owner.email]);
      await db.query("insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Support', 'admin', $3, true, false) on conflict (id) do nothing", [owner.id, owner.email, orgA()]);
      await db.query(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
                      values ($1, $2, 'admin', true, true, now() + interval '2 hours', gen_random_uuid())`, [owner.id, orgA()]);
      await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [owner.id]);
      await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [session, owner.id]);
      await db.query(`insert into security_audit.session_company (session_id, user_id, organization_id, grant_id, elevated_until)
                      values ($1, $2, $3, (select support_grant from public.organization_members where user_id = $2 and organization_id = $3), now() + interval '1 hour')`,
        [session, owner.id, orgA()]);
    });
    const attempt = (dry: boolean, text = IMPORT, params?: unknown[]) => withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated", aud: "authenticated", aal: "aal2", session_id: session, email: owner.email })]);
        // Support in alpha with write access (elevated): the session works in alpha and is not read-only.
        const state = (await db.query("select public.current_user_organization_id() as org, public.session_read_only() as ro")).rows[0];
        expect(state).toEqual({ org: orgA(), ro: false });
        await db.query(text, params ?? [JSON.stringify(payload()), dry, randomUUID()]);
        return null;
      } catch (e) {
        return e as { code?: string; hint?: string };
      } finally {
        await db.query("rollback");
      }
    });
    expect(await attempt(false)).toMatchObject({ code: "42501", hint: "support_session" });
    expect(await attempt(true)).toMatchObject({ code: "42501", hint: "support_session" });
    expect(await attempt(true, STAGE, [randomUUID(), 1, JSON.stringify(payload())])).toMatchObject({ code: "42501", hint: "support_session" });
    expect(await attempt(true, UNDO, [randomUUID(), randomUUID()])).toMatchObject({ code: "42501", hint: "support_session" });
    expect(await count("import_batches", orgA())).toBe(0);
    expect(await count("import_runs", orgA())).toBe(0);
  });

  it("the payload can't name a company, and bad shapes are refused before anything runs", async () => {
    expect(await refusal(A().admin, IMPORT, [JSON.stringify({ organization_id: orgB(), customers: [] }), false, randomUUID()])).toMatchObject({ code: "22023", hint: "bad_payload" });
    expect(await refusal(A().admin, IMPORT, [JSON.stringify({ customers: { name: "x" } }), false, randomUUID()])).toMatchObject({ code: "22023", hint: "bad_payload" });
    expect(await refusal(A().admin, IMPORT, [JSON.stringify({ customers: [] }), false, randomUUID()])).toMatchObject({ code: "22023", hint: "nothing_to_import" });
    expect(await refusal(A().admin, IMPORT, [JSON.stringify({ file_sha256: "nope", customers: [{ name: "x" }] }), false, randomUUID()])).toMatchObject({ code: "22023", hint: "bad_payload" });
    expect(await refusal(A().admin, IMPORT, [JSON.stringify({ customers: [{ name: "x" }] }), false, null])).toMatchObject({ code: "22023", hint: "client_op_missing" });
    // A record's own organization_id is not a field the import reads: the row goes into the caller's company.
    const name = `Session Company Ltd ${randomUUID()}`;
    const r = await importAs(A().admin, { customers: [{ name, organization_id: orgB() }] });
    expect(r).toMatchObject({ ok: true, committed: true });
    expect(await sql("select organization_id from public.customers where name = $1", [name])).toEqual([{ organization_id: orgA() }]);
  });
});

describe("customers and suppliers", () => {
  it("an admin imports customers, then the same file again: nothing new the second time", async () => {
    const tag = randomUUID().slice(0, 8);
    const payload = {
      file_name: "customers.csv", file_sha256: SHA,
      customers: [
        { row: 2, name: `Acme Engineering Limited ${tag}`, email: "accounts@acme.example", phone: "'+44 1234 567890" },
        { row: 3, name: `Bolt & Nut Co ${tag}`, external_ref: `BN-${tag}`, address: "1 Works Road" },
        { row: 4, name: `'=Formula Ltd ${tag}`, notes: "imported" },
      ],
      suppliers: [{ row: 2, name: `Steel Stockholders Ltd ${tag}`, address: "Yard 4", notes: "Net 30" }],
    };
    const before = await count("customers", orgA());
    const first = await importAs(A().admin, payload);
    expect(first).toMatchObject({ ok: true, committed: true, dry_run: false, replayed: false, error_count: 0 });
    expect(first.counts.customers).toEqual({ created: 3, matched_existing: 0, errors: 0 });
    expect(first.counts.suppliers).toEqual({ created: 1, matched_existing: 0, errors: 0 });
    expect(await count("customers", orgA())).toBe(before + 3);
    const rows = await sql<{ name: string; phone: string | null }>("select name, phone from public.customers where organization_id = $1 and name like $2 order by name", [orgA(), `%${tag}`]);
    expect(rows.map((r) => r.name)).toContain(`=Formula Ltd ${tag}`);
    expect(rows.find((r) => r.name.startsWith("Acme"))?.phone).toBe("+44 1234 567890");
    expect((await sql<{ notes: string }>("select notes from public.suppliers where organization_id = $1 and name = $2", [orgA(), `Steel Stockholders Ltd ${tag}`]))[0].notes).toBe("Net 30\nAddress: Yard 4");
    // Keys: by name when there is no account reference, by the reference otherwise.
    const keys = await sql<{ kind: string; match_key: string }>("select kind, match_key from public.import_record_keys where batch_id = $1 order by kind, match_key", [first.batch_id]);
    expect(keys).toContainEqual({ kind: "customers", match_key: `ref:BN-${tag}` });
    expect(keys).toContainEqual({ kind: "customers", match_key: `name:acme engineering ltd ${tag}` });
    // The batch and the audit event.
    const batch = (await sql<{ status: string; created_by: string; file_sha256: string; kinds: string[] }>("select status, created_by, file_sha256, kinds from public.import_batches where id = $1", [first.batch_id]))[0];
    expect(batch).toMatchObject({ status: "committed", created_by: A().admin.id, file_sha256: SHA, kinds: ["customers", "suppliers"] });
    const audit = await sql<{ actor_user_id: string; metadata: { file_sha256: string; counts: Record<string, Counts> } }>(
      "select actor_user_id, metadata from security_audit.audit_log where action = 'IMPORT_COMMITTED' and entity_id = $1", [first.batch_id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: A().admin.id, metadata: { file_sha256: SHA, counts: { customers: { created: 3 } } } });

    // The same file again (a new key): every row matched, nothing created or changed. A differently written name still matches.
    const changed = { ...payload, customers: [...payload.customers.slice(0, 2), { row: 4, name: `'=FORMULA limited ${tag}`, notes: "changed" }] };
    const updatedBefore = await sql("select id, updated_at, notes from public.customers where organization_id = $1 and name like $2 order by id", [orgA(), `%${tag}`]);
    const second = await importAs(A().admin, changed);
    expect(second.counts.customers).toEqual({ created: 0, matched_existing: 3, errors: 0 });
    // The matched customer whose notes differ is reported (and not changed).
    expect(second.warnings).toEqual([expect.objectContaining({ kind: "customers", row: 4, field: "name",
      message: `=FORMULA limited ${tag} is already in Tolra with a different notes: kept as it is, nothing is overwritten.` })]);
    expect(second.counts.suppliers).toEqual({ created: 0, matched_existing: 1, errors: 0 });
    expect(await count("customers", orgA())).toBe(before + 3);
    expect(await sql("select id, updated_at, notes from public.customers where organization_id = $1 and name like $2 order by id", [orgA(), `%${tag}`])).toEqual(updatedBefore);
  });

  it("two customers already in Tolra with the same normalised name: a problem, nothing written", async () => {
    const tag = randomUUID().slice(0, 8);
    await sql("insert into public.customers (organization_id, name) values ($1, $2), ($1, $3)", [orgA(), `Twin Ltd ${tag}`, `TWIN LIMITED ${tag}`]);
    const r = await importAs(A().admin, { customers: [{ name: `twin ltd ${tag}` }, { name: `Single ${tag}` }] });
    expect(r).toMatchObject({ ok: false, committed: false, error_count: 1 });
    expect(r.errors[0]).toMatchObject({ kind: "customers", row: 2, field: "name" });
    expect(r.counts.customers).toEqual({ created: 1, matched_existing: 0, errors: 1 });
    expect(await count("customers", orgA()) - 0).toBeGreaterThan(0);
    expect(await sql("select 1 from public.customers where name = $1", [`Single ${tag}`])).toEqual([]);
  });
});

describe("company isolation", () => {
  it("the same file in two companies: two separate imports; neither reads the other's batches or keys", async () => {
    const tag = randomUUID().slice(0, 8);
    const payload = { customers: [{ name: `Shared Name Ltd ${tag}` }], invoices: [{ invoice_ref: `INV-ISO-${tag}`, customer: `Shared Name Ltd ${tag}`, invoice_date: "2026-09-01", total: 120, vat: 20 }] };
    const a = await importAs(A().admin, payload);
    const b = await importAs(B().admin, payload);
    expect(a.counts.customers.created).toBe(1);
    expect(b.counts.customers.created).toBe(1);
    expect(b.counts.invoices.created).toBe(1);
    expect(await sql("select organization_id from public.invoices where invoice_ref = $1 order by organization_id", [`INV-ISO-${tag}`])).toHaveLength(2);
    // Each admin sees only their own company's batches and keys.
    const seen = (who: Who, table: string) => q<{ organization_id: string }>(who, `select distinct organization_id from public.${table}`);
    expect(await seen(A().admin, "import_batches")).toEqual([{ organization_id: orgA() }]);
    expect(await seen(B().admin, "import_batches")).toEqual([{ organization_id: orgB() }]);
    expect(await seen(A().admin, "import_record_keys")).toEqual([{ organization_id: orgA() }]);
    // Office and others don't see batches at all; nobody writes them directly.
    expect(await q(A().office, "select * from public.import_batches")).toEqual([]);
    expect(await refusal(A().admin, "update public.import_batches set status = 'dry_run'")).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "insert into public.import_record_keys (organization_id, kind, match_key, record_id, batch_id) values ($1, 'customers', 'x', $2, $3)", [orgA(), randomUUID(), a.batch_id])).toMatchObject({ code: "42501" });
  });

  it("saved mappings: an admin keeps the company's; office and the other company see none", async () => {
    const save = "insert into public.import_mappings (organization_id, kind, header_signature, mapping) values ($1, 'customers', $2, $3) returning updated_by";
    const saved = await q<{ updated_by: string }>(A().admin, save, [orgA(), "sig-1", JSON.stringify({ Name: "name" })]);
    expect(saved[0].updated_by).toBe(A().admin.id);
    expect(await refusal(A().office, save, [orgA(), "sig-2", JSON.stringify({ Name: "name" })])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, save, [orgB(), "sig-3", JSON.stringify({ Name: "name" })])).toMatchObject({ code: "42501" });
    expect(await q(A().office, "select * from public.import_mappings")).toEqual([]);
    expect(await q(B().admin, "select * from public.import_mappings")).toEqual([]);
    expect(await q(A().admin, "update public.import_mappings set mapping = '{\"Customer\": \"name\"}' where header_signature = 'sig-1' returning mapping")).toEqual([{ mapping: { Customer: "name" } }]);
  });
});

describe("dry run and all or nothing", () => {
  const docs = (tag: string) => ({
    file_name: "sliq.xlsx", file_sha256: SHA,
    customers: [{ name: `Dry Run Customer ${tag}` }],
    stock: [{ sku: `SKU-${tag}`, material: "EN8 bar 50mm", current_stock: "12", unit_price: "4.25" }],
    quotes: [{ quote_ref: `QUO-DRY-${tag}`, customer: `Dry Run Customer ${tag}`, status: "sent", quote_date: "2026-08-01",
      lines: [{ description: "Turned part", quantity: 2, unit_price: 50, vat_pct: 20 }] }],
    invoices: [{ invoice_ref: `INV-DRY-${tag}`, customer: `Dry Run Customer ${tag}`, invoice_date: "2026-08-10", status: "paid", subtotal: 100, vat: 20, total: 120,
      lines: [{ description: "Turned part", quantity: 2, unit_price: 50 }] }],
    payments: [{ invoice_ref: `INV-DRY-${tag}`, paid_on: "2026-08-20", amount: 120, method: "BACS", reference: "BANK1" }],
  });
  const tables = ["customers", "stock", "quotes", "quote_line_items", "invoices", "invoice_line_items", "invoice_payments", "import_record_keys", "doc_counters"];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t, orgA())])));

  it("a dry run does the whole import, answers the exact counts, and leaves nothing behind but its batch row", async () => {
    const tag = randomUUID().slice(0, 8);
    const before = await snapshot();
    const auditBefore = Number((await sql<{ n: string }>("select count(*)::text as n from security_audit.audit_log where organization_id = $1", [orgA()]))[0].n);
    const r = await importAs(A().admin, docs(tag), true);
    expect(r).toMatchObject({ ok: true, dry_run: true, committed: false, error_count: 0 });
    expect(r.counts).toMatchObject({
      customers: { created: 1, matched_existing: 0, errors: 0 }, stock: { created: 1, matched_existing: 0, errors: 0 },
      quotes: { created: 1, matched_existing: 0, errors: 0 }, invoices: { created: 1, matched_existing: 0, errors: 0 },
      payments: { created: 1, matched_existing: 0, errors: 0 }, quote_lines: { created: 1 }, invoice_lines: { created: 1 },
    });
    expect(await snapshot()).toEqual(before);
    // Only the batch row (and its own audit row) remain.
    expect(await sql("select status, counts->'invoices' as inv from public.import_batches where id = $1", [r.batch_id])).toEqual([{ status: "dry_run", inv: { created: 1, matched_existing: 0, errors: 0 } }]);
    const auditAfter = Number((await sql<{ n: string }>("select count(*)::text as n from security_audit.audit_log where organization_id = $1", [orgA()]))[0].n);
    expect(auditAfter - auditBefore).toBe(1);
    // The same counts when committed.
    const c = await importAs(A().admin, docs(tag));
    expect(c.counts).toEqual(r.counts);
    expect(c.committed).toBe(true);
  });

  it("one bad row: nothing is committed, and every problem is reported with its row and field", async () => {
    const tag = randomUUID().slice(0, 8);
    const payload = docs(tag);
    payload.invoices.push({ invoice_ref: `INV-BAD-${tag}`, customer: "Somebody", invoice_date: "2026-13-01", status: "paid", subtotal: 100, vat: 20, total: 125, lines: [] });
    payload.stock.push({ sku: `SKU-${tag}`, material: "duplicate", current_stock: "1.5", unit_price: "x" });
    const before = await snapshot();
    const sums = await checksums(orgA());
    const r = await importAs(A().admin, payload);
    expect(r).toMatchObject({ ok: false, committed: false, dry_run: false, batch_id: null });
    expect(await checksums(orgA()), "a failed small import leaves no business row behind").toEqual(sums);
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invoices", row: 3, field: "invoice_date" }),
      expect.objectContaining({ kind: "invoices", row: 3, field: "total", message: "Net + VAT must equal the total." }),
      expect.objectContaining({ kind: "stock", row: 3, field: "current_stock" }),
      expect.objectContaining({ kind: "stock", row: 3, field: "unit_price" }),
      expect.objectContaining({ kind: "stock", row: 3, field: "sku" }),
    ]));
    expect(r.counts.invoices).toEqual({ created: 1, matched_existing: 0, errors: 1 });
    expect(await snapshot()).toEqual(before);
    expect(await count("import_batches", orgA())).toBeGreaterThan(0);
    expect(await sql("select 1 from public.import_batches where organization_id = $1 and counts->'stock'->>'errors' = '1' and status = 'committed'", [orgA()])).toEqual([]);
  });

  it("a key answers its first result; the key for anything else is refused", async () => {
    const tag = randomUUID().slice(0, 8);
    const key = randomUUID();
    const payload = { customers: [{ name: `Replay Ltd ${tag}` }] };
    const first = await importAs(A().admin, payload, false, key);
    const again = await importAs(A().admin, payload, false, key);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await sql("select count(*)::int as n from public.customers where name = $1", [`Replay Ltd ${tag}`])).toEqual([{ n: 1 }]);
    expect(await refusal(A().admin, IMPORT, [JSON.stringify({ customers: [{ name: `Other ${tag}` }] }), false, key])).toMatchObject({ code: "22023", hint: "client_op_reused" });
    expect(await refusal(A().admin, IMPORT, [JSON.stringify(payload), true, key])).toMatchObject({ code: "22023", hint: "client_op_reused" });
    // The batch is a record: never changed, a committed one never removed (not even by the owner).
    await expect(sql("update public.import_batches set file_name = 'x' where id = $1", [first.batch_id])).rejects.toMatchObject({ code: "42501" });
    await expect(sql("delete from public.import_batches where id = $1", [first.batch_id])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("invoices, payments and numbering", () => {
  it("issued, part-paid and paid invoices go in with their lines and payments; payments match on a second run", async () => {
    const tag = randomUUID().slice(0, 8);
    const ref = (n: number) => `INV-P${tag}-${n}`;
    const payload = {
      invoices: [
        { invoice_ref: ref(1), customer: "Pay Co", invoice_date: "2026-07-01", due_date: "2026-07-31", status: "sent", subtotal: 100, vat: 20, total: 120,
          lines: [{ description: "Part A", quantity: 1, unit_price: 100 }] },
        { invoice_ref: ref(2), customer: "Pay Co", invoice_date: "2026-07-02", status: "paid", total: 240, vat: 40,
          lines: [{ description: "Part B", quantity: 4, unit_price: 50 }, { description: "Note: delivered", quantity: 0, unit_price: 0 }] },
        { invoice_ref: ref(3), customer: "Pay Co", invoice_date: "2026-07-03", status: "paid", total: 60, vat: 10 },
        { invoice_ref: ref(4), customer: "Pay Co", invoice_date: "2026-07-04", status: "paid", total: 36, vat: 6 },
      ],
      payments: [
        { invoice_ref: ref(2), paid_on: "2026-08-01", amount: 100, method: "bacs" },
        { invoice_ref: ref(2), paid_on: "2026-08-01", amount: 100, method: "Cheque" },
        { invoice_ref: ref(2), paid_on: "2026-08-15", amount: 40 },
        { invoice_ref: ref(3), paid_on: "2026-08-02", amount: 25, reference: "'=PART" },
      ],
    };
    const r = await importAs(A().admin, payload);
    expect(r).toMatchObject({ ok: true, committed: true });
    expect(r.counts.invoices).toEqual({ created: 4, matched_existing: 0, errors: 0 });
    expect(r.counts.payments).toEqual({ created: 4, matched_existing: 0, errors: 0 });
    expect(r.counts.invoice_lines).toEqual({ created: 3 });
    const inv = await sql<{ invoice_ref: string; status: string; amount_paid: number; paid_at: string | null; payment_unverified: boolean; subtotal: number; issued_by: string }>(
      "select invoice_ref, status, amount_paid::float8 as amount_paid, paid_at, payment_unverified, subtotal::float8 as subtotal, issued_by from public.invoices where organization_id = $1 and invoice_ref like $2 order by invoice_ref", [orgA(), `INV-P${tag}-%`]);
    expect(inv.map((i) => [i.invoice_ref, i.status, i.amount_paid, i.payment_unverified, i.subtotal])).toEqual([
      [ref(1), "sent", 0, false, 100],
      [ref(2), "paid", 240, false, 200],
      [ref(3), "partial", 25, false, 50],
      [ref(4), "sent", 0, true, 30],
    ]);
    expect(inv[1].paid_at).not.toBeNull();
    expect(inv.every((i) => i.issued_by === A().admin.id)).toBe(true);
    // Payments are ordinary recorded payments (reversible), amount_paid is exactly their sum (032's rule).
    const pays = await sql<{ amount: number; method: string | null; reference: string | null; source: string; created_by: string }>(
      "select p.amount::float8 as amount, p.method, p.reference, p.source, p.created_by from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.invoice_ref like $1 order by p.paid_on, p.amount, p.method nulls last", [`INV-P${tag}-%`]);
    expect(pays.map((p) => [p.amount, p.method, p.reference, p.source])).toEqual([
      [100, "BACS", null, "recorded"], [100, "cheque", null, "recorded"], [25, null, "=PART", "recorded"], [40, null, null, "recorded"],
    ]);
    expect(await sql("select i.invoice_ref from public.invoices i where i.invoice_ref like $1 and i.amount_paid <> coalesce((select sum(amount) from public.invoice_payments p where p.invoice_id = i.id), 0)", [`INV-P${tag}-%`])).toEqual([]);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "invoices", row: 5, field: "status" })]));
    // Keys: invoice number, date, amount and ordinal (two equal payments on one day are two keys).
    const keys = await sql<{ match_key: string }>("select match_key from public.import_record_keys where batch_id = $1 and kind = 'payments' order by match_key", [r.batch_id]);
    expect(keys.map((k) => k.match_key)).toEqual([`${ref(2)}|2026-08-01|100.00|1`, `${ref(2)}|2026-08-01|100.00|2`, `${ref(2)}|2026-08-15|40.00|1`, `${ref(3)}|2026-08-02|25.00|1`]);

    // The same file again: every invoice and payment matched, nothing new.
    const again = await importAs(A().admin, payload);
    expect(again.counts.invoices).toEqual({ created: 0, matched_existing: 4, errors: 0 });
    expect(again.counts.payments).toEqual({ created: 0, matched_existing: 4, errors: 0 });
    // A further payment for an invoice already in Tolra is recorded with Record payment, not imported.
    const more = await importAs(A().admin, { ...payload, payments: [...payload.payments, { invoice_ref: ref(3), paid_on: "2026-09-01", amount: 35 }] }, true);
    expect(more.ok).toBe(false);
    expect(more.errors).toEqual([expect.objectContaining({ kind: "payments", row: 6, field: "invoice_ref" })]);
    expect(more.errors[0].message).toContain("already in Tolra");

    // The guards are on again after an import, in the same transaction: a client can't insert an issued invoice or a line on one.
    const after = await as(A().admin, async (db: Client) => {
      await db.query(IMPORT, [JSON.stringify({ customers: [{ name: `Guard Check ${tag}` }] }), false, randomUUID()]);
      const tries = [
        "insert into public.invoices (organization_id, customer, status, invoice_ref, total) values ($1, 'x', 'sent', 'INV-GUARD-" + tag + "', 1)",
        "insert into public.invoice_line_items (organization_id, invoice_id, description) select organization_id, id, 'sneaky' from public.invoices where invoice_ref = '" + ref(1) + "' and organization_id = $1",
      ];
      const out: (string | undefined)[] = [];
      for (const t of tries) {
        await db.query("savepoint s");
        try { await db.query(t, [orgA()]); out.push("allowed"); } catch (e) { out.push((e as { code?: string }).code); }
        await db.query("rollback to savepoint s");
      }
      return out;
    });
    expect(after).toEqual(["42501", "42501"]);
  });

  it("numbering carries on after the highest imported INV, QUO, PO, J, SO and DLN (this company only)", async () => {
    // An older delivery note numbered beyond its counter (as an import or a hand fix could leave it): 076 also reseeds DLN.
    await sql("insert into public.delivery_notes (organization_id, dn_number, customer) values ($1, 'DLN-0042', 'Numbers Co')", [orgA()]);
    const betaBefore = await sql("select prefix, last from public.doc_counters where organization_id = $1 order by prefix", [orgB()]);
    const r = await importAs(A().admin, {
      quotes: [{ quote_ref: "QUO-0207", customer: "Numbers Co", total_value: 10 }, { quote_ref: "Q2004", customer: "Numbers Co", total_value: 10 }],
      sales_orders: [{ so_number: "SO-0012", customer: "Numbers Co" }],
      jobs: [{ job_no: "J-0450", customer: "Numbers Co", so_number: "SO-0012" }],
      purchase_orders: [{ po_ref: "PO-0033", supplier: "Steel Ltd" }],
      invoices: [{ invoice_ref: "INV-0105", customer: "Numbers Co", invoice_date: "2026-09-01", total: 12, vat: 2, job_no: "J-0450" },
        { invoice_ref: "INV-0099", customer: "Numbers Co", invoice_date: "2026-09-01", total: 12, vat: 2 }],
    });
    expect(r).toMatchObject({ ok: true, committed: true });
    expect(r.doc_counters).toMatchObject({ QUO: 207, INV: 105, PO: 33, J: 450, SO: 12, DLN: 42 });
    expect(r.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "quotes", field: "quote_ref", message: expect.stringContaining("Q2004 is not QUO-<digits>") })]));
    const next = async (prefix: string) => (await q<{ n: string }>(A().office, "select public.next_doc_number($1) as n", [prefix]))[0].n;
    expect(await next("INV")).toBe("INV-0106");
    expect(await next("QUO")).toBe("QUO-0208");
    expect(await next("PO")).toBe("PO-0034");
    expect(await next("SO")).toBe("SO-0013");
    expect(await next("DLN")).toBe("DLN-0043");
    expect(await next("J")).toBe("J-0451");
    // The job is linked to its order (and back), the invoice to its job; the other company's counters are untouched.
    const link = (await sql<{ so: string; job: string; inv_job: string }>(
      `select so.converted_to_job_id::text as so, j.converted_from_sales_order_id::text as job, i.job_id::text as inv_job
       from public.jobs j join public.sales_orders so on so.id = j.converted_from_sales_order_id join public.invoices i on i.job_id = j.id
       where j.organization_id = $1 and j.job_no = 'J-0450'`, [orgA()]))[0];
    expect(link.so).toBeTruthy();
    expect(await sql("select prefix, last from public.doc_counters where organization_id = $1 order by prefix", [orgB()])).toEqual(betaBefore);
  });
});

describe("matched rows whose content differs", () => {
  it("a stock code already in Tolra with another description or price: matched, never overwritten, and listed as a warning", async () => {
    const tag = randomUUID().slice(0, 6);
    await sql("insert into public.stock (organization_id, sku, material, unit_price) values ($1, $2, 'EN8 bar 50mm', 4.25), ($1, $3, 'EN1A hex', 2.00)",
      [orgA(), `S1-${tag}`, `S2-${tag}`]);
    const sums = await checksums(orgA());
    const dry = await importAs(A().admin, { stock: [{ sku: `S1-${tag}`, material: "EN8 bar 60mm", unit_price: "4.75" }, { sku: `S2-${tag}`, material: "EN1A hex" }] }, true);
    expect(dry.counts.stock).toEqual({ created: 0, matched_existing: 2, errors: 0 });
    expect(dry.warnings).toEqual([expect.objectContaining({ kind: "stock", row: 2, field: "sku",
      message: `S1-${tag} is already in Tolra with a different description, unit price: kept as it is, nothing is overwritten.` })]);
    const r = await importAs(A().admin, { stock: [{ sku: `S1-${tag}`, material: "EN8 bar 60mm", unit_price: "4.75" }] });
    expect(r).toMatchObject({ ok: true, committed: true, warning_count: 1 });
    expect(await checksums(orgA())).toEqual(sums);
  });
});

describe("numbering collisions", () => {
  it("a number already in Tolra with other content is a problem, never an overwrite; the same content is matched", async () => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const n = (p: string) => `${p}-C${tag}`;
    await withDb(async (db) => {
      await db.query("insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, invoice_date) values ($1, $2, 'Owner Co', 100, 20, 120, 'sent', '2026-05-01')", [orgA(), n("INV")]);
      await db.query("insert into public.quotes (organization_id, quote_ref, customer, total_value, status) values ($1, $2, 'Owner Co', 50, 'sent')", [orgA(), n("QUO")]);
      await db.query("insert into public.purchase_orders (organization_id, po_ref, po_number, supplier, total_value, status) values ($1, $2, $2, 'Steel Ltd', 70, 'sent')", [orgA(), n("PO")]);
      await db.query("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Owner Co')", [orgA(), n("J")]);
      await db.query("insert into public.sales_orders (organization_id, so_number, customer) values ($1, $2, 'Owner Co')", [orgA(), n("SO")]);
    });
    const sums = await checksums(orgA());
    const other = {
      quotes: [{ quote_ref: n("QUO"), customer: "Someone Else Ltd", total_value: 50 }],
      sales_orders: [{ so_number: n("SO"), customer: "Someone Else Ltd" }],
      jobs: [{ job_no: n("J"), customer: "Someone Else Ltd" }],
      purchase_orders: [{ po_ref: n("PO"), supplier: "Steel Ltd", total_value: 99 }],
      invoices: [{ invoice_ref: n("INV"), customer: "Owner Co", invoice_date: "2026-05-01", total: 240, vat: 40 }],
    };
    const r = await importAs(A().admin, other);
    expect(r).toMatchObject({ ok: false, committed: false, error_count: 5 });
    expect(r.errors.map((e) => [e.kind, e.field])).toEqual(expect.arrayContaining([["quotes", "quote_ref"], ["sales_orders", "so_number"], ["jobs", "job_no"], ["purchase_orders", "po_ref"], ["invoices", "invoice_ref"]]));
    expect(r.errors.every((e) => e.message.includes("nothing is overwritten"))).toBe(true);
    expect(await checksums(orgA())).toEqual(sums);
    // The same records again (spelled differently): matched, nothing created or changed.
    const same = await importAs(A().admin, {
      quotes: [{ quote_ref: n("QUO"), customer: "OWNER CO.", total_value: 50 }], sales_orders: [{ so_number: n("SO"), customer: "owner co" }],
      jobs: [{ job_no: n("J"), customer: "Owner Co" }], purchase_orders: [{ po_ref: n("PO"), supplier: "Steel Limited" }],
      invoices: [{ invoice_ref: n("INV"), customer: "Owner Co", invoice_date: "2026-05-01", total: 120, vat: 20 }],
    });
    expect(same).toMatchObject({ ok: true, committed: true, error_count: 0 });
    for (const k of ["quotes", "sales_orders", "jobs", "purchase_orders", "invoices"]) expect(same.counts[k]).toEqual({ created: 0, matched_existing: 1, errors: 0 });
    expect(await checksums(orgA())).toEqual(sums);
  });
});

/**
 * One undo call while another session holds row locks (`lockSql`, run as the owner and kept open): the undo waits for them, gives up
 * after its lock_timeout (55P03) and is rolled back whole. Returns the error code.
 */
async function undoBlocked(id: string, lockSql: string, params: unknown[]) {
  return withDb(async (holder) => {
    await holder.query("begin");
    try {
      const locked = (await holder.query(lockSql, params)).rowCount;
      expect(locked, "rows locked by the other session").toBeGreaterThan(0);
      return await withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query("set local role authenticated");
          await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A().admin.id, role: "authenticated", aud: "authenticated", aal: "aal1" })]);
          await db.query("set local lock_timeout = '300ms'");
          await db.query(UNDO, [id, randomUUID()]);
          return null;
        } catch (e) {
          return (e as { code?: string }).code;
        } finally {
          await db.query("rollback");
        }
      });
    } finally {
      await holder.query("rollback");
    }
  });
}

describe("a large import (staged, validated whole, committed in parts, undone)", () => {
  const file = (tag: string) => [
    { file_name: "sliq.xlsx", file_sha256: SHA,
      customers: [{ name: `Large Customer A ${tag}` }, { name: `Large Customer B ${tag}`, external_ref: `LB-${tag}` }],
      stock: [{ sku: `LSKU-${tag}`, material: "EN24T bar" }],
      quotes: Array.from({ length: 6 }, (_, i) => ({ quote_ref: `QUO-L${tag}-${i}`, customer: `Large Customer A ${tag}`, status: "sent",
        lines: [{ description: `Part ${i}`, quantity: 2, unit_price: 10, vat_pct: 20 }] })) },
    { sales_orders: [{ so_number: `SO-L${tag}`, customer: `Large Customer A ${tag}` }],
      jobs: [{ job_no: `J-L${tag}`, customer: `Large Customer A ${tag}`, so_number: `SO-L${tag}` }],
      invoices: Array.from({ length: 30 }, (_, i) => ({ invoice_ref: `INV-L${tag}-${i}`, customer: `Large Customer B ${tag}`, invoice_date: "2026-08-01",
        status: i % 2 ? "paid" : "sent", subtotal: 100, vat: 20, total: 120, lines: [{ description: `Work ${i}`, quantity: 1, unit_price: 100 }] })) },
    // The payments come in a later part than their invoices: the server puts each with its invoice.
    { payments: Array.from({ length: 15 }, (_, i) => ({ invoice_ref: `INV-L${tag}-${2 * i + 1}`, paid_on: "2026-08-20", amount: 120, method: "BACS" })) },
  ];

  it("nothing is committed until every part has validated: a problem in the last part, and nothing is written", async () => {
    const tag = randomUUID().slice(0, 6);
    const parts = file(tag);
    parts.push({ payments: [{ invoice_ref: `INV-NOPE-${tag}`, paid_on: "2026-08-20", amount: 1 }] } as never);
    const sums = await checksums(orgA());
    const { id, v } = await stageAndValidate(A().admin, parts);
    expect(v).toMatchObject({ ok: false, large: true, error_count: 1, parts: null });
    expect(v.errors[0]).toMatchObject({ kind: "payments", field: "invoice_ref" });
    expect(await refusal(A().admin, COMMIT, [id, randomUUID()])).toMatchObject({ code: "22023", hint: "import_not_validated" });
    expect(await checksums(orgA()), "a failed large import leaves no business row behind").toEqual(sums);
    expect(await undoAll(A().admin, id)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(await count("import_stage", orgA())).toBe(0);
  });

  it("commits part by part from the validated file, marked large; the same file again creates nothing", async () => {
    const tag = randomUUID().slice(0, 6);
    const { id, v } = await stageAndValidate(A().admin, file(tag), 25);
    expect(v).toMatchObject({ ok: true, large: true, error_count: 0 });
    expect(v.parts).toBeGreaterThanOrEqual(4);
    expect(v.counts).toMatchObject({ invoices: { created: 30 }, payments: { created: 15 }, quotes: { created: 6 }, customers: { created: 2 } });
    // The staged file can't change under a validated plan without being validated again.
    const done = await commitAll(A().admin, id);
    expect(done.every((r) => r.ok && r.committed)).toBe(true);
    expect(done.at(-1)).toMatchObject({ parts_committed: v.parts, parts: v.parts });
    const created = (k: string) => done.reduce((n, r) => n + (r.counts[k]?.created ?? 0), 0);
    expect([created("invoices"), created("payments"), created("quotes"), created("customers"), created("jobs")]).toEqual([30, 15, 6, 2, 1]);
    expect(await sql("select status, parts_committed from public.import_runs where import_id = $1", [id])).toEqual([{ status: "committed", parts_committed: v.parts }]);
    expect(await count("import_stage", orgA())).toBe(0);
    expect(await sql<{ n: number }>("select count(*)::int as n from public.import_batches where import_id = $1 and status = 'committed' and large", [id])).toEqual([{ n: v.parts }]);
    // Every paid invoice got its payment though they were staged in different parts.
    expect(await sql("select count(*)::int as n from public.invoices where organization_id = $1 and invoice_ref like $2 and status = 'paid' and amount_paid = 120", [orgA(), `INV-L${tag}-%`])).toEqual([{ n: 15 }]);
    expect(await refusal(A().admin, COMMIT, [id, randomUUID()])).toMatchObject({ code: "22023", hint: "import_not_validated" });
    // The same file again, twice (large, then small): nothing new.
    const sums = await checksums(orgA());
    const again = await stageAndValidate(A().admin, file(tag), 25);
    expect(again.v.ok).toBe(true);
    const againDone = await commitAll(A().admin, again.id);
    expect(againDone.reduce((n, r) => n + Object.values(r.counts).reduce((m, c) => m + (c.created ?? 0), 0), 0)).toBe(0);
    const small = await importAs(A().admin, Object.assign({}, ...file(tag)));
    expect(Object.values(small.counts).reduce((m, c) => m + (c.created ?? 0), 0)).toBe(0);
    expect(await checksums(orgA())).toEqual(sums);
  });

  it("a part that fails leaves nothing of itself; undo then returns the company to exactly its state before the import", async () => {
    const tag = randomUUID().slice(0, 6);
    // A customer that was already there (matched by name, not created): undo must leave it.
    await sql("insert into public.customers (organization_id, name, phone) values ($1, $2, '0100')", [orgA(), `Large Customer A ${tag}`]);
    const sums = await checksums(orgA());
    const { id, v } = await stageAndValidate(A().admin, file(tag), 25);
    expect(v.ok).toBe(true);
    expect(v.counts.customers).toEqual({ created: 1, matched_existing: 1, errors: 0 });
    for (let i = 0; i < 2; i++) expect((await call(A().admin, COMMIT, [id, randomUUID()])).ok).toBe(true);
    // The third part is cut off (as Supabase's 8 s limit would): the call fails and nothing of that part is kept.
    const cut = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A().admin.id, role: "authenticated", aud: "authenticated", aal: "aal1" })]);
        await db.query("set local statement_timeout = '1ms'");
        await db.query(COMMIT, [id, randomUUID()]);
        return null;
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await db.query("rollback");
      }
    });
    expect(cut).toBe("57014");
    expect(await sql("select parts_committed, status from public.import_runs where import_id = $1", [id])).toEqual([{ parts_committed: 2, status: "committing" }]);
    const undone = await undoAll(A().admin, id);
    expect(undone.at(-1)).toMatchObject({ status: "undone" });
    expect(undone.every((r) => (r.refused_count ?? 0) === 0)).toBe(true);
    expect(await checksums(orgA()), "after undo: exactly the business records of before the import").toEqual(sums);
    expect(await sql("select phone from public.customers where organization_id = $1 and name = $2", [orgA(), `Large Customer A ${tag}`])).toEqual([{ phone: "0100" }]);
    expect(await sql<{ n: number }>("select count(*)::int as n from public.import_batches where import_id = $1 and status = 'undo' and large", [id])).toEqual([{ n: 2 }]);
    expect(await count("import_stage", orgA())).toBe(0);
    // Undone, the same file can be imported afresh.
    expect(await refusal(A().admin, COMMIT, [id, randomUUID()])).toMatchObject({ hint: "import_not_validated" });
  });

  it("undo refuses what was changed or used after the import (also while the undo runs), keeps it intact and reports it", async () => {
    const tag = randomUUID().slice(0, 6);
    const sums = await checksums(orgA());
    const { id, v } = await stageAndValidate(A().admin, file(tag), 25);
    expect(v.ok).toBe(true);
    await commitAll(A().admin, id);
    // Used: a payment recorded by hand on an imported, unpaid invoice.
    const inv = (await sql<{ id: string }>("select id from public.invoices where organization_id = $1 and invoice_ref = $2", [orgA(), `INV-L${tag}-0`]))[0].id;
    await q(A().admin, "select public.record_invoice_payment($1, 20, '2026-09-01', 'BACS', 'hand', $2)", [inv, randomUUID()]);
    // Used only (nothing about the job itself changed): a delivery note made for an imported job.
    const job = (await sql<{ id: string }>("select id from public.jobs where organization_id = $1 and job_no = $2", [orgA(), `J-L${tag}`]))[0].id;
    await sql("insert into public.delivery_notes (organization_id, dn_number, customer, job_id) values ($1, $2, 'Large Customer A', $3)", [orgA(), `DLN-U${tag}`, job]);
    // Changed: an imported quote's note edited by the office.
    await q(A().office, "update public.quotes set internal_notes = 'edited by hand' where organization_id = $1 and quote_ref = $2", [orgA(), `QUO-L${tag}-1`]);
    // Undo the parts down to the first one (customers and stock)...
    let r: Large;
    do { r = await call(A().admin, UNDO, [id, randomUUID()]); } while ((r.parts_left ?? 0) > 1);
    expect(r.parts_left).toBe(1);
    // ... then, while an edit of an imported customer is still in progress, undo the first part: it waits, then refuses that customer.
    const customer = (await sql<{ id: string }>("select id from public.customers where organization_id = $1 and name = $2", [orgA(), `Large Customer B ${tag}`]))[0].id;
    const result = await withDb(async (edit) => {
      await edit.query("begin");
      await edit.query("set local role authenticated");
      await edit.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A().office.id, role: "authenticated", aud: "authenticated", aal: "aal1" })]);
      await edit.query("update public.customers set phone = '07700 900123' where id = $1", [customer]);
      let finished = false;
      const pending = undoAll(A().admin, id).then((x) => { finished = true; return x; });
      await new Promise((ok) => setTimeout(ok, 500));
      expect(finished, "the undo waits for the edit in progress").toBe(false);
      await edit.query("commit");
      return pending;
    });
    expect(result.at(-1)).toMatchObject({ status: "undone" });
    const refused = (await sql<{ refused: { kind: string; ref: string; reason: string }[] }>("select refused from public.import_runs where import_id = $1", [id]))[0].refused;
    expect(refused).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invoices", ref: `INV-L${tag}-0`, reason: expect.any(String) }),
      expect.objectContaining({ kind: "quotes", ref: `QUO-L${tag}-1`, reason: "changed in Tolra after the import" }),
      expect.objectContaining({ kind: "customers", ref: `LB-${tag}`, reason: "changed in Tolra after the import" }),
      expect.objectContaining({ kind: "jobs", ref: `J-L${tag}`, reason: "still used in Tolra (delivery_notes)" }),
      expect.objectContaining({ kind: "sales_orders", reason: "still used in Tolra (jobs)" }),
    ]));
    expect(await sql("select count(*)::int as n from public.jobs where id = $1", [job])).toEqual([{ n: 1 }]);
    // Kept intact: the edited customer and quote (with its line), the used invoice with its line and its payment.
    expect(await sql("select phone from public.customers where id = $1", [customer])).toEqual([{ phone: "07700 900123" }]);
    expect(await sql("select internal_notes, (select count(*)::int from public.quote_line_items l where l.quote_id = q.id) as lines from public.quotes q where organization_id = $1 and quote_ref = $2",
      [orgA(), `QUO-L${tag}-1`])).toEqual([{ internal_notes: "edited by hand", lines: 1 }]);
    expect(await sql("select (select count(*)::int from public.invoice_line_items l where l.invoice_id = $1) as lines, (select count(*)::int from public.invoice_payments p where p.invoice_id = $1) as pays", [inv]))
      .toEqual([{ lines: 1, pays: 1 }]);
    // Everything else the import created is gone; nothing that was there before was touched.
    expect(await sql("select count(*)::int as n from public.invoices where organization_id = $1 and invoice_ref like $2", [orgA(), `INV-L${tag}-%`])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from public.quotes where organization_id = $1 and quote_ref like $2", [orgA(), `QUO-L${tag}-%`])).toEqual([{ n: 1 }]);
    const after = await checksums(orgA());
    for (const t of ["suppliers", "stock", "purchase_orders"]) expect(after[t], t).toEqual(sums[t]);
  });

  it("undo sees an edit made by a transaction that began before the import committed", async () => {
    const tag = randomUUID().slice(0, 6);
    const { id, v } = await stageAndValidate(A().admin, [{ quotes: [{ quote_ref: `QUO-D${tag}`, customer: "Draft Co", status: "draft",
      lines: [{ description: "Bracket", quantity: 2, unit_price: 15 }] }] }], 500);
    expect(v.ok).toBe(true);
    const out = await withDb(async (edit) => {
      // The office's transaction begins (and takes its time) BEFORE the import commits...
      await edit.query("begin");
      await edit.query("set local role authenticated");
      await edit.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A().office.id, role: "authenticated", aud: "authenticated", aal: "aal1" })]);
      const began = (await edit.query<{ t: string }>("select now()::text as t")).rows[0].t;
      await commitAll(A().admin, id);
      // ... and edits a line of the imported draft quote after it has.
      const changed = await edit.query("update public.quote_line_items l set description = 'Bracket, painted' from public.quotes q where q.id = l.quote_id and q.organization_id = $1 and q.quote_ref = $2", [orgA(), `QUO-D${tag}`]);
      await edit.query("commit");
      return { began, changed: changed.rowCount };
    });
    expect(out.changed).toBe(1);
    const batch = (await sql<{ created_at: string }>("select created_at::text from public.import_batches where import_id = $1 and status = 'committed'", [id]))[0];
    expect(out.began < batch.created_at, "the editing transaction began before the import committed").toBe(true);
    const undone = await undoAll(A().admin, id);
    expect(undone.at(-1)).toMatchObject({ status: "undone" });
    expect(undone[0].refused).toEqual([expect.objectContaining({ kind: "quotes", ref: `QUO-D${tag}`, reason: "still used in Tolra (quote_line_items)" })]);
    expect(await sql("select l.description from public.quote_line_items l join public.quotes q on q.id = l.quote_id where q.organization_id = $1 and q.quote_ref = $2", [orgA(), `QUO-D${tag}`]))
      .toEqual([{ description: "Bracket, painted" }]);
  });

  it("recovery after a partially completed undo: resumed, it ends exactly at the before-import state; a further undo is a no-op", async () => {
    const tag = randomUUID().slice(0, 6);
    const sums = await checksums(orgA());
    const { id, v } = await stageAndValidate(A().admin, file(tag), 25);
    expect(v.ok).toBe(true);
    await commitAll(A().admin, id);
    // The undo starts: the last two parts are undone (one call and one transaction each)...
    for (let i = 0; i < 2; i++) expect(await call(A().admin, UNDO, [id, randomUUID()])).toMatchObject({ status: "undoing", refused_count: 0 });
    // ... then stops: the next part's undo can't lock its rows (another session holds them) and is rolled back whole.
    const code = await undoBlocked(id, "select id from public.invoices where organization_id = $1 and invoice_ref like $2 for update", [orgA(), `INV-L${tag}-%`]);
    expect(code).toBe("55P03");
    expect(await sql("select status, parts_undone from public.import_runs where import_id = $1", [id])).toEqual([{ status: "undoing", parts_undone: 2 }]);
    expect(await sql<{ n: number }>("select count(*)::int as n from public.import_batches where import_id = $1 and status = 'undo'", [id])).toEqual([{ n: 2 }]);
    // Resumed: it finishes cleanly, back to exactly the business records of before the import.
    const resumed = await undoAll(A().admin, id);
    expect(resumed.at(-1)).toMatchObject({ status: "undone" });
    expect(resumed.every((r) => (r.refused_count ?? 0) === 0)).toBe(true);
    expect(await checksums(orgA()), "after the resumed undo: exactly the business records of before the import").toEqual(sums);
    expect(await sql<{ n: number }>("select count(*)::int as n from public.import_batches where import_id = $1 and status = 'undo'", [id])).toEqual([{ n: v.parts! }]);
    // A further undo changes nothing and says so.
    expect(await call(A().admin, UNDO, [id, randomUUID()])).toEqual({ import_id: id, status: "undone", replayed: false });
    expect(await checksums(orgA())).toEqual(sums);
  });

  it("a row refused in a partially completed undo stays refused and kept when the undo is resumed", async () => {
    const tag = randomUUID().slice(0, 6);
    const sums = await checksums(orgA());
    const { id, v } = await stageAndValidate(A().admin, file(tag), 25);
    expect(v.ok).toBe(true);
    await commitAll(A().admin, id);
    await q(A().office, "update public.quotes set internal_notes = 'edited by hand' where organization_id = $1 and quote_ref = $2", [orgA(), `QUO-L${tag}-2`]);
    // Undo down to the quotes' part: the edited quote is refused and kept.
    let r: Large;
    do { r = await call(A().admin, UNDO, [id, randomUUID()]); } while ((r.parts_left ?? 0) > 1);
    expect(r).toMatchObject({ status: "undoing", parts_left: 1, refused: [expect.objectContaining({ kind: "quotes", ref: `QUO-L${tag}-2` })] });
    // The last part's undo is stopped by a lock held elsewhere, then resumed.
    expect(await undoBlocked(id, "select id from public.customers where organization_id = $1 and name like $2 for update", [orgA(), `Large Customer % ${tag}`])).toBe("55P03");
    const resumed = await undoAll(A().admin, id);
    expect(resumed.at(-1)).toMatchObject({ status: "undone" });
    // Still refused and kept, with its line and its key; reported once on the run.
    expect(await sql("select internal_notes, (select count(*)::int from public.quote_line_items l where l.quote_id = q.id) as lines from public.quotes q where organization_id = $1 and quote_ref = $2",
      [orgA(), `QUO-L${tag}-2`])).toEqual([{ internal_notes: "edited by hand", lines: 1 }]);
    expect(await sql("select count(*)::int as n from public.import_record_keys where organization_id = $1 and kind = 'quotes' and match_key = $2", [orgA(), `QUO-L${tag}-2`])).toEqual([{ n: 1 }]);
    const refused = (await sql<{ refused: { kind: string; ref: string }[] }>("select refused from public.import_runs where import_id = $1", [id]))[0].refused;
    expect(refused.filter((x) => x.ref === `QUO-L${tag}-2`)).toHaveLength(1);
    expect(await sql("select count(*)::int as n from public.quotes where organization_id = $1 and quote_ref like $2", [orgA(), `QUO-L${tag}-%`])).toEqual([{ n: 1 }]);
    // Everything else is as before; a further undo is a no-op.
    const after = await checksums(orgA());
    for (const t of ["customers", "suppliers", "stock", "sales_orders", "jobs", "job_values", "purchase_orders", "invoices", "invoice_line_items", "invoice_payments"]) expect(after[t], t).toEqual(sums[t]);
    expect(await call(A().admin, UNDO, [id, randomUUID()])).toMatchObject({ status: "undone" });
    expect(await checksums(orgA())).toEqual(after);
  });

  it("an abandoned import (never committed, untouched for 24 hours) is removed when the company stages another; other companies' are not", async () => {
    const old = randomUUID();
    const oldB = randomUUID();
    const committing = await stageAndValidate(A().admin, [{ customers: [{ name: `Half Done ${old}` }] }, { quotes: [{ quote_ref: `QUO-H${old.slice(0, 6)}`, customer: "x", total_value: 1 }] }], 10);
    await call(A().admin, COMMIT, [committing.id, randomUUID()]);
    await call(A().admin, STAGE, [old, 1, JSON.stringify({ customers: [{ name: `Abandoned ${old}` }] })]);
    await call(B().admin, STAGE, [oldB, 1, JSON.stringify({ customers: [{ name: `Abandoned ${oldB}` }] })]);
    await sql("update public.import_runs set updated_at = now() - interval '25 hours' where import_id = any($1::uuid[])", [[old, oldB, committing.id]]);
    // Staging a new import in alpha clears alpha's abandoned one, and nothing else.
    await call(A().admin, STAGE, [randomUUID(), 1, JSON.stringify({ customers: [{ name: `Fresh ${old}` }] })]);
    expect(await sql("select status from public.import_runs where import_id = $1", [old])).toEqual([{ status: "cancelled" }]);
    expect(await sql("select count(*)::int as n from public.import_stage where import_id = $1", [old])).toEqual([{ n: 0 }]);
    expect(await sql("select status from public.import_runs where import_id = $1", [oldB])).toEqual([{ status: "staging" }]);
    expect(await sql("select count(*)::int as n from public.import_stage where import_id = $1", [oldB])).toEqual([{ n: 1 }]);
    // One with a committed part is never cleaned up here: it is finished or undone.
    expect(await sql("select status from public.import_runs where import_id = $1", [committing.id])).toEqual([{ status: "committing" }]);
    expect(await sql("select count(*)::int as n from public.import_stage where import_id = $1", [committing.id])).toEqual([{ n: 2 }]);
    // An admin can discard one at once (before any commit): import_undo cancels it.
    expect(await call(B().admin, UNDO, [oldB, randomUUID()])).toMatchObject({ status: "cancelled" });
    expect(await sql("select count(*)::int as n from public.import_stage where import_id = $1", [oldB])).toEqual([{ n: 0 }]);
    await undoAll(A().admin, committing.id);
  });

  it("another company can't validate, commit or undo it; an unknown import is not found", async () => {
    const tag = randomUUID().slice(0, 6);
    const { id } = await stageAndValidate(A().admin, file(tag), 750);
    for (const [text, params] of [[VALIDATE, [id, 750, randomUUID()]], [COMMIT, [id, randomUUID()]], [UNDO, [id, randomUUID()]]] as const) {
      expect(await refusal(B().admin, text, [...params])).toMatchObject({ code: "P0002", hint: "import_not_found" });
    }
    expect(await q(B().admin, "select * from public.import_runs where import_id = $1", [id])).toEqual([]);
    expect(await q(B().admin, "select * from public.import_stage where import_id = $1", [id])).toEqual([]);
    expect(await q(A().admin, "select count(*)::int as n from public.import_stage where import_id = $1", [id])).toEqual([{ n: 3 }]);
    expect(await q(A().office, "select * from public.import_stage")).toEqual([]);
    await undoAll(A().admin, id);
  });
});

/** The JNR-size file: 80 customers, 1,400 quotes (1 line each), 2,000 paid invoices (1 line each) and 2,000 payments. */
function jnrFile(base: number) {
  const customers = Array.from({ length: 80 }, (_, i) => ({ name: `Timing Customer ${base} ${i}`, external_ref: `TC${base}-${i}` }));
  const quotes = Array.from({ length: 1400 }, (_, i) => ({
    quote_ref: `QUO-${base + i}`, customer: `Timing Customer ${base} ${i % 80}`, quote_date: "2026-06-01", status: i % 3 === 0 ? "accepted" : "sent",
    lines: [{ description: `Machined part ${i}`, quantity: 1 + (i % 5), unit_price: 12.5 + (i % 7), vat_pct: 20 }],
  }));
  const invoices = Array.from({ length: 2000 }, (_, i) => {
    const net = Math.round((100 + (i % 50) * 3.33) * 100) / 100;
    const vat = Math.round(net * 20) / 100;
    return {
      invoice_ref: `INV-${base + i}`, customer: `Timing Customer ${base} ${i % 80}`, invoice_date: "2026-06-15", due_date: "2026-07-15", status: "paid",
      subtotal: net, vat, total: Math.round((net + vat) * 100) / 100, lines: [{ description: `Invoice line ${i}`, quantity: 1, unit_price: net, vat_pct: 20 }],
    };
  });
  const payments = invoices.map((inv) => ({ invoice_ref: inv.invoice_ref, paid_on: "2026-07-01", amount: inv.total, method: "BACS" }));
  return { customers, quotes, invoices, payments };
}
const timed = async <T>(fn: () => Promise<T>) => {
  const started = performance.now();
  const r = await fn();
  return { r, ms: Math.round(performance.now() - started) };
};

// Reported, not asserted (docs/RELEASE.md "076", timing): run with IMPORT_TIMING=1. Supabase cancels a signed-in call after 8 s.
describe.runIf(process.env.IMPORT_TIMING === "1")("timing", () => {
  it("JNR size in one call (one transaction)", async () => {
    const f = jnrFile(30000);
    const dry = await timed(() => importAs(B().admin, { file_name: "timing.xlsx", file_sha256: SHA, ...f }, true));
    const commit = await timed(() => importAs(B().admin, { file_name: "timing.xlsx", file_sha256: SHA, ...f }));
    expect(commit.r).toMatchObject({ ok: true, committed: true });
    expect(commit.r.counts).toMatchObject({ invoices: { created: 2000 }, payments: { created: 2000 }, quotes: { created: 1400 } });
    console.log(`076 timing, one call: dry run ${dry.ms} ms, commit ${commit.ms} ms; size ${JSON.stringify((commit.r as Result & { size: unknown }).size)}`);
  }, 900_000);

  it("JNR size as a large import: staged, validated, committed in parts, undone", async () => {
    const f = jnrFile(50000);
    const id = randomUUID();
    const parts = [{ file_name: "timing.xlsx", file_sha256: SHA, customers: f.customers }, { quotes: f.quotes }, { invoices: f.invoices.slice(0, 1000) },
      { invoices: f.invoices.slice(1000) }, { payments: f.payments }];
    const stage: number[] = [];
    for (const [i, p] of parts.entries()) stage.push((await timed(() => call(B().admin, STAGE, [id, i + 1, JSON.stringify(p)]))).ms);
    const weight = Number(process.env.IMPORT_PART_WEIGHT ?? 500);
    const v = await timed(() => call(B().admin, VALIDATE, [id, weight, randomUUID()]));
    expect(v.r).toMatchObject({ ok: true });
    const commits: number[] = [];
    for (;;) {
      const c = await timed(() => call(B().admin, COMMIT, [id, randomUUID()]));
      expect(c.r.ok).toBe(true);
      commits.push(c.ms);
      if (c.r.parts_committed === c.r.parts) break;
    }
    const undos: number[] = [];
    for (;;) {
      const u = await timed(() => call(B().admin, UNDO, [id, randomUUID()]));
      undos.push(u.ms);
      if (u.r.status === "undone") break;
    }
    console.log(`076 timing, large (part weight ${weight}): stage ${stage.join("/")} ms; validate ${v.ms} ms; ${commits.length} parts, commit ms ${commits.join(", ")} (max ${Math.max(...commits)}); undo ms ${undos.join(", ")} (max ${Math.max(...undos)})`);
  }, 900_000);
});
