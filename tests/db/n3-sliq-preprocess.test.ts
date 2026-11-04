/** Synthetic only. Real private preprocessor -> public app mapping/build -> real authenticated SQL import. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImport, type ImportPayload } from "@/lib/import-build";
import { planSheet } from "@/lib/import-detect";
import { commitSingle, type Rpc } from "@/lib/data-import";
import { createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb, type SyntheticWorld } from "../support/fixtures";
import { q } from "./time-support";

type PreResult = { files: Record<string, string>; flags: { code: string }[]; counts: Record<string, number>; reconciliation: Record<string, { equal: boolean }> };
type Pre = (text: string, opts: Record<string, unknown>) => PreResult;
let preprocess: Pre;
let parseCsv: (text: string) => string[][];
let world: SyntheticWorld;
const CUSTOMER = "N3 Synthetic Metal Ltd";
const headers = ["Type", "Num", "Date", "Customer", "Net Total", "VAT", "Total"];
const csv = (rows: string[][]) => rows.map(r => r.map(c => `"${c.replaceAll('"', '""')}"`).join(",")).join("\r\n");
const invRows = (tag: string) => [
  ["Inv", `N3-${tag}-1`, "01/10/2026", CUSTOMER, "100.05", "20.01", "120.06"],
  ["Inv", `N3-${tag}-2`, "02/10/2026", CUSTOMER, "20.00", "4.00", "24.00"],
];
function report(rows: string[][], h = headers, money = [4, 5, 6]) {
  const totals = h.map(() => ""); totals[0] = "Total";
  for (const col of money) totals[col] = (rows.reduce((n, r) => n + Math.round(Number(r[col]) * 100), 0) / 100).toFixed(2);
  return csv([["SYNTHETIC report"], ["Made-up company"], ["01/10/2026 to 31/10/2026"], [], [], h, ["Year 2026"], ...rows, totals]);
}
const clean = (rows: string[][]) => preprocess(report(rows), { kind: "invoices" });
async function payload(files: Record<string, string>) {
  // Only named import outputs enter the payload: held-* files can never slip into a workbook.
  const allowed = new Set(["invoices.csv", "payments.csv", "credit_notes.csv"]);
  const plans = [];
  for (const [name, text] of Object.entries(files)) {
    if (!allowed.has(name)) continue;
    const rows = parseCsv(text);
    plans.push(...await planSheet({ name: name.replace(".csv", ""), headers: rows[0], rows: rows.slice(1), rowNumbers: rows.slice(1).map((_, i) => i + 2) }, []));
  }
  plans.push(...await planSheet({ name: "Customers", headers: ["Name"], rows: [[CUSTOMER]], rowNumbers: [2] }, []));
  const built = buildImport(plans, { name: "n3-synthetic.csv", sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") });
  expect(built.problems).toEqual([]);
  expect(built.payload.invoices?.length).toBeGreaterThan(0);
  return built.payload;
}
const sql = async (text: string, values: unknown[] = []) => withDb(async db => (await db.query(text, values)).rows);
const rpc: Rpc = async (fn, args) => ({ data: (await q(world.tenants.alpha.users.admin,
  `select public.${fn}($1::jsonb, $2, $3) as r`, [JSON.stringify(args.p_payload), args.p_dry_run, args.p_client_op_id]))[0].r, error: null });
const commit = (p: ImportPayload) => commitSingle(rpc, p, randomUUID());
async function snapshot() {
  const out: Record<string, unknown> = {};
  // Both tenants; business rows, numbering and idempotence keys. Import-batch/audit bookkeeping is not business data.
  for (const t of ["customers", "invoices", "invoice_line_items", "invoice_payments", "credit_notes", "credit_note_lines", "quotes", "doc_counters", "import_record_keys"]) {
    out[t] = await sql(`select to_jsonb(r) as r from public.${t} r where organization_id = any($1::uuid[]) order by to_jsonb(r)::text`, [[world.tenants.alpha.id, world.tenants.beta.id]]);
  }
  return out;
}
beforeAll(async () => {
  // The fixtures refuse hosted URLs/keys and non-synthetic tenants before creating anything.
  await verifyBackendIdentity();
  const modulePath = process.env.N3_PREPROCESS_MODULE;
  if (!modulePath || !existsSync(modulePath)) throw new Error("N3 needs the pinned private preprocessor; no fallback or skipped proof");
  ({ preprocess } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href));
  ({ parseCsv } = await import(/* @vite-ignore */ new URL("../sliq-synthetic-reports.mjs", pathToFileURL(modulePath)).href));
  world = await createSyntheticWorld();
});
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

describe("N3 private preprocessor and disposable app importer", () => {
  it("N3-01 invalid dates refuse without business writes", async () => {
    const before = await snapshot();
    for (const date of ["31/02/2026", "12/31/2026", "1/2/26", "2026-10-01"]) {
      const rows = invRows("DATE"); rows[1][2] = date;
      expect(() => clean(rows)).toThrow(/Date|date/);
    }
    expect(await snapshot()).toEqual(before);
  });
  it("N3-02 title, group and totals rows never become database records", async () => {
    const rows = invRows("FURN"); const result = clean(rows);
    expect(result.counts).toMatchObject({ records: 2, out: 2, held: 0, totalsRows: 1, groupRows: 1 });
    expect(result.counts.inputRows).toBe(result.counts.rowsAboveAndIncludingHeader + result.counts.blankRows + result.counts.groupRows + result.counts.totalsRows + result.counts.records + result.counts.rejected);
    expect(result.flags).toEqual([]);
    const p = await payload(result.files); const beta = await sql("select to_jsonb(i) as r from public.invoices i where organization_id=$1", [world.tenants.beta.id]);
    const before = await sql("select invoice_ref from public.invoices where organization_id=$1 order by invoice_ref", [world.tenants.alpha.id]);
    expect((await commit(p)).committed).toBe(true);
    const after = await sql("select invoice_ref from public.invoices where organization_id=$1 order by invoice_ref", [world.tenants.alpha.id]);
    expect(after.filter(r => !before.some(b => b.invoice_ref === r.invoice_ref)).map(r => r.invoice_ref).sort()).toEqual(rows.map(r => r[1]).sort());
    expect(await sql("select to_jsonb(i) as r from public.invoices i where organization_id=$1", [world.tenants.beta.id])).toEqual(beta);
  });
  it("N3-03 Quotes requested as invoices refuse without writes", async () => {
    const before = await snapshot();
    expect(() => preprocess(report([["Q-N3", "01/10/2026", "Sent", "", "10.00", "2.00", "12.00"]],
      ["Num", "Date", "Status", "Invoice", "Net Total", "VAT", "Total"]), { kind: "invoices" })).toThrow(/Quotes.*not Invoices/);
    expect(await snapshot()).toEqual(before);
  });
  it("N3-04 repeated and conflicting invoice numbers refuse without writes", async () => {
    const before = await snapshot(); const rows = invRows("DUP");
    for (const second of [[...rows[0]], [...rows[0].slice(0, 3), "Other Synthetic Ltd", ...rows[0].slice(4)]]) {
      expect(() => clean([rows[0], second])).toThrow(/not unique|repeat/);
    }
    // Also exercise the database's duplicate-key refusal after app payload building.
    const p = await payload(clean(rows).files);
    p.invoices!.push({ ...p.invoices![0], row: 999, customer: "Other Synthetic Ltd" });
    const result = await commit(p);
    expect(result.committed).toBe(false); expect(result.error_count).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toMatch(/twice|duplicate/i);
    expect(await snapshot()).toEqual(before);
  });
  it("N3-05 orphan credits are held and never written", async () => {
    const rows = [...invRows("CRD"), ["Crd", "CN-N3-ORPHAN", "03/10/2026", CUSTOMER, "-5.00", "-1.00", "-6.00"]];
    const result = clean(rows);
    expect(result.counts).toMatchObject({ records: 3, out: 2, held: 1 });
    expect(result.files["held-credit_notes.csv"]).toContain("CN-N3-ORPHAN");
    expect(result.files["credit_notes.csv"]).toBeUndefined();
    const beforeCredits = await sql("select to_jsonb(c) as r from public.credit_notes c where organization_id=$1", [world.tenants.alpha.id]);
    expect((await commit(await payload(result.files))).committed).toBe(true);
    expect(await sql("select to_jsonb(c) as r from public.credit_notes c where organization_id=$1", [world.tenants.alpha.id])).toEqual(beforeCredits);
  });
  it("N3-06 the same valid file with a fresh operation key imports once", async () => {
    const p = await payload(clean(invRows("ONCE")).files);
    expect((await commit(p)).committed).toBe(true); const before = await snapshot();
    const again = await commit(p); expect(again.ok).toBe(true);
    expect(again.counts).toBeDefined();
    expect(Object.values(again.counts ?? {}).every(c => (c.created ?? 0) === 0)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
  it("N3-07 every payment links and pence counts, totals and balances reconcile", async () => {
    const rows = invRows("PAY"); const invoices = clean(rows);
    const payments = preprocess(report([
      ["04/10/2026", "Bank Transfer", CUSTOMER, rows[0][1], "33.34", "6.67", "40.01"],
      ["05/10/2026", "Bank Transfer", CUSTOMER, rows[0][1], "16.68", "3.34", "20.02"],
      ["06/10/2026", "Cash", CUSTOMER, rows[1][1], "20.00", "4.00", "24.00"],
    ], ["Payment Date", "Payment Method", "Customer", "Num", "Payment Net", "VAT", "Payment Amount"], [4, 5, 6]), { kind: "payments", invoicesClean: invoices.files["invoices.csv"] });
    expect(payments.flags).toEqual([]); expect(payments.counts).toMatchObject({ records: 3, out: 3, held: 0 });
    expect(Object.values(payments.reconciliation).every(r => r.equal)).toBe(true);
    const p = await payload({ ...invoices.files, ...payments.files });
    expect(p.payments).toHaveLength(3); expect((await commit(p)).committed).toBe(true);
    const actual = await sql(`select i.invoice_ref, (i.total*100)::int as total, (i.amount_paid*100)::int as paid,
      ((i.total-i.amount_paid)*100)::int as balance, count(p.id)::int as count, coalesce(sum(p.amount*100),0)::int as sum
      from public.invoices i left join public.invoice_payments p on p.invoice_id=i.id and p.organization_id=i.organization_id
      where i.organization_id=$1 and i.invoice_ref=any($2) group by i.id order by i.invoice_ref`, [world.tenants.alpha.id, rows.map(r => r[1])]);
    expect(actual).toEqual([
      { invoice_ref: rows[0][1], total: 12006, paid: 6003, balance: 6003, count: 2, sum: 6003 },
      { invoice_ref: rows[1][1], total: 2400, paid: 2400, balance: 0, count: 1, sum: 2400 },
    ]);
    expect(await sql(`select i.invoice_ref, (p.amount*100)::int as pence, p.paid_on::text as date, p.method
      from public.invoice_payments p join public.invoices i on i.id=p.invoice_id where p.organization_id=$1 and i.invoice_ref=any($2)
      order by i.invoice_ref,p.paid_on`, [world.tenants.alpha.id, rows.map(r => r[1])])).toEqual([
      { invoice_ref: rows[0][1], pence: 4001, date: "2026-10-04", method: "BACS" },
      { invoice_ref: rows[0][1], pence: 2002, date: "2026-10-05", method: "BACS" },
      { invoice_ref: rows[1][1], pence: 2400, date: "2026-10-06", method: "cash" },
    ]);
    expect(await sql(`select p.id from public.invoice_payments p left join public.invoices i on i.id=p.invoice_id
      where p.organization_id=$1 and (i.id is null or i.organization_id<>p.organization_id)`, [world.tenants.alpha.id])).toEqual([]);
    const before = await snapshot(); expect((await commit(p)).ok).toBe(true); expect(await snapshot()).toEqual(before);
  });
  it("N3-08 one bad row writes nothing, including valid rows", async () => {
    const before = await snapshot(); const p = await payload(clean(invRows("BAD")).files);
    p.invoices![1].invoice_date = "2026-02-31";
    const result = await commit(p);
    expect(result.committed).toBe(false); expect(result.error_count).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
  });
});
