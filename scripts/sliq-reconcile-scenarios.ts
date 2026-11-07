// Local proof for the SliQ reconciliation (D1). Builds a throwaway database from a template on a LOCAL Postgres,
// loads synthetic data, runs supabase/verify/sliq_reconcile.sql and lib/sliq-reconcile, and checks which checks fail.
// Run: PGHOST=127.0.0.1 PGPORT=55591 PGUSER=postgres TEMPLATE_DB=sliq152tpl npx vite-node -c vitest.db.config.ts scripts/sliq-reconcile-scenarios.ts
// The template needs release 152 (sliq_reconcile.sql reads public.import_sliq_reconcile_rows).
// Refuses any host that is not 127.0.0.1 or localhost. Never run against hosted data.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { reconcile, type DbRow, type SourceTotals } from "../lib/sliq-reconcile/reconcile";
import { renderSigningSheet } from "../lib/sliq-reconcile/sheet";
import { buildSliqPayload, sourceTotalsFromValidated } from "../lib/sliq-import-build";
import { validateSliqExportWith } from "../lib/sliq-validate/validate";

const host = process.env.PGHOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("Local Postgres only");
const env = { ...process.env, PGHOST: host, PGPORT: process.env.PGPORT ?? "55591", PGUSER: process.env.PGUSER ?? "postgres" };
const tpl = process.env.TEMPLATE_DB ?? "sliq152tpl";
const psql = (db: string, sql: string, extra: string[] = []) =>
  execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db, ...extra, "-c", sql], { env, encoding: "utf8" });

const ORG = "11111111-1111-1111-1111-111111111111";
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const pen = (p: number) => (p / 100).toFixed(2);

type Inv = { ref: string; customer: string; totalP: number; paid: { p: number; on: string }[] };
function dataset(): { invs: Inv[]; customers: { name: string; email: string }[] } {
  const customers = ["Acme Ltd", "Brook Fabrication", "Cobalt Marine", "Dene Engineering", "Eden Tooling"].map((name, i) => ({
    name, email: `acc${i}@example.test`,
  }));
  const invs: Inv[] = [];
  for (let n = 1; n <= 20; n++) {
    const totalP = 12000 + n * 1337;
    const paid = n % 3 === 0 ? [] : n % 3 === 1 ? [{ p: totalP, on: "2025-03-01" }] : [{ p: 5000, on: "2025-03-02" }, { p: 1234, on: "2025-03-09" }];
    invs.push({ ref: `INV-${String(n).padStart(4, "0")}`, customer: customers[n % 5].name, totalP, paid });
  }
  return { invs, customers };
}

/**
 * The source totals are NOT written by hand: the dataset is written out as SliQ-shaped CSV files, checked by lib/sliq-validate and
 * built by lib/sliq-import-build, and the totals come from sourceTotalsFromValidated (the adapter the card uses). Keyed by name: this
 * script loads the database directly, without the route's import map.
 */
async function sourceOf(d: ReturnType<typeof dataset>): Promise<SourceTotals> {
  const enc = new TextEncoder();
  const codeOf = new Map(d.customers.map((c, i) => [c.name, `C${i + 1}`]));
  const csv = {
    customers: ["Code,Name", ...d.customers.map((c) => `${codeOf.get(c.name)},${c.name}`)].join("\n") + "\n",
    suppliers: "Code,Name\nS1,Synthetic Steel\n",
    invoices: ["Ref,Cust,Date,Gross", ...d.invs.map((i) => `${i.ref},${codeOf.get(i.customer)},2025-02-01,${pen(i.totalP)}`)].join("\n") + "\n",
    payments: ["Ref,Date,Amount", ...d.invs.flatMap((i) => i.paid.map((p) => `${i.ref},${p.on},${pen(p.p)}`))].join("\n") + "\n",
  };
  const mapping = {
    version: 1, confirmed: true, dateFormat: "YYYY-MM-DD",
    entities: {
      customers: { file: "sliq-customers.csv", columns: { key: "Code", name: "Name" } },
      suppliers: { file: "sliq-suppliers.csv", columns: { key: "Code", name: "Name" } },
      invoices: { file: "sliq-invoices.csv", columns: { ref: "Ref", customerKey: "Cust", date: "Date", gross: "Gross" } },
      payments: { file: "sliq-payments.csv", columns: { invoiceRef: "Ref", date: "Date", amount: "Amount" } },
    },
  };
  const files = Object.fromEntries(Object.entries(csv).map(([k, text]) => [k, { name: `sliq-${k}.csv`, bytes: enc.encode(text) }]));
  const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const report = validateSliqExportWith({ files, mapping }, nodeSha);
  if (!report.ok) throw new Error(`synthetic files did not validate: ${JSON.stringify(report.errors.slice(0, 3))}`);
  const { payload } = await buildSliqPayload(files, mapping as never);
  return sourceTotalsFromValidated(report, payload, "name");
}

function load(db: string, d: ReturnType<typeof dataset>, mutate: string) {
  const sql: string[] = ["SET session_replication_role = replica;",
    `INSERT INTO public.organizations (name, slug, id) VALUES ('Synthetic Ltd', 'synthetic-${db}', '${ORG}');`];
  for (const c of d.customers) sql.push(`INSERT INTO public.customers (organization_id, name, email) VALUES ('${ORG}', ${q(c.name)}, ${q(c.email)});`);
  d.invs.forEach((i, idx) => {
    const id = `00000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
    sql.push(`INSERT INTO public.invoices (id, organization_id, invoice_ref, customer, total, status, credited_amount) VALUES ('${id}', '${ORG}', ${q(i.ref)}, ${q(i.customer)}, ${pen(i.totalP)}, 'sent', 0);`);
    for (const p of i.paid) sql.push(`INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, source) VALUES ('${ORG}', '${id}', ${pen(p.p)}, '${p.on}', 'recorded');`);
  });
  sql.push(`INSERT INTO public.doc_counters (organization_id, prefix, last) VALUES ('${ORG}', 'INV', 20), ('${ORG}', 'QUO', 7);`);
  sql.push(mutate);
  psql(db, sql.join("\n"));
}

function runReconcile(db: string, src: SourceTotals, countersBefore: Record<string, number>) {
  const file = readFileSync("supabase/verify/sliq_reconcile.sql", "utf8").replace("00000000-0000-0000-0000-000000000000", ORG);
  const out = execFileSync("psql", ["-X", "-q", "-A", "-F", "\t", "-t", "-d", db], { env, encoding: "utf8", input: file });
  const rows: DbRow[] = out.split("\n").filter((l) => l.includes("\t")).map((l) => {
    const [metric, key, value] = l.split("\t");
    return { metric, key, value: value === "" ? null : value };
  });
  return reconcile(src, rows, { countersBefore });
}

const scenarios: { name: string; mutate: string; expectPass: boolean; mustFail: string[] }[] = [
  { name: "clean import", mutate: "", expectPass: true, mustFail: [] },
  { name: "duplicated customer", mutate: `INSERT INTO public.customers (organization_id, name, email) VALUES ('${ORG}', 'ACME LTD ', 'other@example.test');`,
    expectPass: false, mustFail: ["duplicate customer names (groups)", "count: customers"] },
  { name: "payment over total", mutate: `UPDATE public.invoice_payments SET amount = amount + 100000 WHERE invoice_id = '00000000-0000-4000-8000-000000000001';`,
    expectPass: false, mustFail: ["invoices with paid + credits above total", "payments total (pence)"] },
  { name: "off by one penny", mutate: `UPDATE public.invoices SET total = total + 0.01 WHERE invoice_ref = 'INV-0003';`,
    expectPass: false, mustFail: ["invoice total (pence)", "outstanding (pence)", "customer balances differing (count)"] },
];

async function main() {
let bad = 0;
const base = `sliqscen${process.pid}`;
for (const [n, s] of scenarios.entries()) {
  const db = `${base}_${n}`;
  psql("postgres", `CREATE DATABASE ${db} TEMPLATE ${tpl}`);
  try {
    const d = dataset();
    load(db, d, s.mutate);
    const source = await sourceOf(d);
    const report = runReconcile(db, source, { INV: 0, QUO: 7 });
    const failed = report.rows.filter((r) => r.status === "FAIL").map((r) => r.check);
    const ok = report.pass === s.expectPass && s.mustFail.every((m) => failed.includes(m));
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "BAD "} ${s.name}: pass=${report.pass} failed=[${failed.join("; ")}]`);
    if (n === 0 && process.env.SHOW_SHEET) console.log(renderSigningSheet(source, report, { company: "Synthetic Ltd", importedOn: "synthetic" }));
  } finally {
    psql("postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
}
console.log(bad === 0 ? "ALL SCENARIOS AS EXPECTED" : `${bad} SCENARIO(S) NOT AS EXPECTED`);
process.exit(bad === 0 ? 0 : 1);
}
void main();
