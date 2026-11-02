#!/usr/bin/env node
// Part B data checks after a rehearsal import: open jobs, the sales orders that feed them, purchase order statuses and job links,
// opening WIP and the numbering, against the generator's manifest (the designed truth), the source files read directly, and the
// verification sheets the dry run wrote. Reads the rehearsal database READ ONLY (one read-only transaction, rolled back).
//
//   node scripts/sliq-import/rehearsal/jobs-checks.mjs --work <generate.mjs out folder> --report <dry-run report.json> \
//        --database-url postgresql://postgres@127.0.0.1:5432/<name with rehearsal> [--org-slug rehearsal-a] [--json <results.json>]
//
// Every result line is PASS|FAIL <check> <detail>. Exit 1 on any FAIL.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

import { checkDatabaseUrl } from "../guard.mjs";
import { parseCsv, parseMoneyPence } from "../parse.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, xs) => (t.startsWith("--") ? [...a, [t.slice(2), xs[i + 1]]] : a), []));
const { work, report: reportPath } = args;
const dbUrl = args["database-url"];
const slug = args["org-slug"] ?? "rehearsal-a";
if (!work || !dbUrl || !reportPath) {
  console.error("Usage: jobs-checks.mjs --work <folder> --report <report.json> --database-url <local rehearsal url> [--org-slug s] [--json out]");
  process.exit(2);
}
checkDatabaseUrl(dbUrl);
if (!/rehearsal/.test(new URL(dbUrl).pathname)) throw new Error("Refusing: these checks only run on a database whose name contains 'rehearsal'.");

const m = JSON.parse(readFileSync(path.join(work, "manifest.json"), "utf8")).jobs;
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const jr = report.jobsImport;
const read = (f) => {
  const { headers, rows } = parseCsv(readFileSync(f, "utf8"));
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
};
const src = (f) => read(path.join(work, "export", f));
const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const fmt = (p) => `${p < 0 ? "-" : ""}£${(Math.abs(p) / 100).toFixed(2)}`;
const iso = (d) => (d ? d.split("/").map((x) => x.padStart(2, "0")).reverse().join("-") : null);

const results = [];
const out = (ok, check, detail) => {
  results.push({ status: ok ? "PASS" : "FAIL", check, detail });
  console.log(`${ok ? "PASS" : "FAIL"}|${check}|${detail}`);
};
const eq = (check, got, want, show = (x) => x) => out(JSON.stringify(got) === JSON.stringify(want), check, `${show(got)} (expected ${show(want)})`);

const jobsSrc = src("jobs.csv");
const wipSrc = src("wip.csv");
const STATUS = { Open: "on_track", "In Progress": "on_track", "At Risk": "at_risk", Late: "overdue" };

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("begin read only");
try {
  const org = (await db.query("select id from public.organizations where slug = $1", [slug])).rows[0]?.id;
  if (!org) throw new Error(`no organisation with slug ${slug}`);
  const q = async (sql, params = []) => (await db.query(sql, [org, ...params])).rows;

  // ---- 1. open jobs: count, the Job Board's open list, and every field ------------------------------------------------------------
  const dbJobs = new Map((await q(`select j.job_no, j.customer, j.quote_ref, j.quote_id is not null as has_quote, j.status, j.stage, j.due_date::text due, j.date_required::text req,
      (j.started_at at time zone 'UTC')::date::text started, (j.finished_at at time zone 'UTC')::date::text finished, j.inspected_at, j.specification, j.description,
      so.so_number, v.value::text v from public.jobs j left join public.sales_orders so on so.id = j.converted_from_sales_order_id
      left join public.job_values v on v.job_id = j.id where j.organization_id = $1`)).map((r) => [r.job_no, r]));
  eq("jobs: open jobs in the SliQ file (designed)", jobsSrc.filter((r) => STATUS[r.Status]).length, m.openInFile);
  eq("jobs: imported = open in SliQ less held (unknown customer)", dbJobs.size, m.openInFile - m.held.length);
  const board = (await q("select count(*)::int n from public.jobs where organization_id = $1 and (stage = 'rework' or inspected_at is null)"))[0].n;
  eq("jobs: open on the Job Board (stage rework or not inspected) = SliQ open jobs less held", board, m.imported);
  eq("jobs: the held job (unknown customer) is not in Tolra", m.held.filter((n) => dbJobs.has(n)), []);
  eq("jobs: closed / finished SliQ jobs are not imported", m.closed.filter((c) => dbJobs.has(c.number)).map((c) => c.number), []);
  const bad = [];
  for (const j of m.importedJobs) {
    const d = dbJobs.get(j.number);
    const stage = j.stage ? j.stage.toLowerCase() : j.finished ? "inspection" : "material";
    const want = { customer: j.customer, quote: j.quote, so: j.salesOrder, status: STATUS[j.status], stage, due: j.due, req: j.due, started: j.started, finished: j.finished, value: j.valuePence, spec: j.spec, desc: j.description, inspected: null };
    const got = d && { customer: d.customer, quote: d.has_quote ? d.quote_ref : null, so: d.so_number, status: d.status, stage: d.stage, due: d.due, req: d.req, started: d.started, finished: d.finished, value: num(d.v), spec: d.specification, desc: d.description, inspected: d.inspected_at };
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${j.number}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
  out(bad.length === 0, "jobs: number kept, customer (by account), quote link, order link, status and stage words, due, spec, started, finished, value", `${m.importedJobs.length - bad.length}/${m.importedJobs.length} as in the source${bad.length ? `; ${bad.slice(0, 2).join(" | ")}` : ""}`);
  eq("jobs: jobs with no quote are imported without a quote link", m.noQuote.filter((n) => dbJobs.get(n)?.has_quote !== false), []);
  const finished = m.importedJobs.filter((j) => j.finished).map((j) => j.number);
  out(finished.length > 0 && finished.every((n) => dbJobs.get(n).finished && !dbJobs.get(n).inspected_at && dbJobs.get(n).stage === "inspection"), "jobs: a job finished in SliQ but open is finished, awaiting inspection (still on the board)", finished.join(", "));
  const vals = (await q("select count(*)::int n, coalesce(sum(v.value), 0)::text s from public.job_values v join public.jobs j on j.id = v.job_id where j.organization_id = $1"))[0];
  const wantVals = m.importedJobs.filter((j) => j.valuePence !== null);
  eq("jobs: job values only where SliQ gives one (job_values, admin/office only)", [vals.n, num(vals.s)], [wantVals.length, wantVals.reduce((a, j) => a + j.valuePence, 0)]);

  // ---- 2. sales orders -------------------------------------------------------------------------------------------------------------
  const dbSo = await q(`select so.so_number, so.status, jb.job_no, c.name cust, so.converted_to_job_id = jb.id and jb.converted_from_sales_order_id = so.id as both_ways
      from public.sales_orders so left join public.jobs jb on jb.id = so.converted_to_job_id left join public.customers c on c.id = so.customer_id where so.organization_id = $1 order by 1`);
  eq("sales orders: only those feeding an imported job", dbSo.map((r) => r.so_number), m.salesOrders.imported.map((s) => s.number));
  const custOf = new Map(m.importedJobs.map((j) => [j.number, j.customer]));
  const soBad = dbSo.filter((r) => { const w = m.salesOrders.imported.find((s) => s.number === r.so_number); return r.status !== "converted" || r.job_no !== w.job || !r.both_ways || r.cust !== custOf.get(w.job); });
  eq("sales orders: converted, linked both ways to their job, customer linked by id", soBad.map((r) => r.so_number), []);
  eq("sales orders: open orders with no job and closed ones are not imported", m.salesOrders.notImported.filter((n) => dbSo.some((r) => r.so_number === n)), []);

  // ---- 3. purchase orders: status words, open count, supplier refusal, job links --------------------------------------------------
  const st = Object.fromEntries((await q("select status, count(*)::int n from public.purchase_orders where organization_id = $1 group by 1 order by 1")).map((r) => [r.status, r.n]));
  eq("purchase orders: Tolra status per SliQ word (draft, sent, confirmed, partial_received, received, cancelled)", st, m.purchaseOrders.byTolraStatus, JSON.stringify);
  eq("purchase orders: open (draft, sent, confirmed, part received)", ["draft", "sent", "confirmed", "partial_received"].reduce((a, k) => a + (st[k] ?? 0), 0), m.purchaseOrders.open);
  eq("purchase orders: the unknown supplier's order is refused", (await q("select po_ref from public.purchase_orders where organization_id = $1 and po_ref = any($2)", [m.purchaseOrders.refusedUnknownSupplier])).length, 0);
  const links = await q("select o.po_ref, j.job_no from public.purchase_orders o left join public.jobs j on j.id = o.job_id where o.organization_id = $1 and o.job_id is not null order by 1");
  eq("purchase orders: job links made exactly as the source says", links.map((r) => `${r.po_ref}>${r.job_no}`), m.purchaseOrders.linked.map((p) => `${p.number}>${p.job}`).sort());
  const notMade = await q("select po_ref from public.purchase_orders where organization_id = $1 and po_ref = any($2) and job_id is null", [m.purchaseOrders.linkNotMade.map((p) => p.number)]);
  eq("purchase orders: a link to a closed job or a job not in the file is not made (order written, listed)", notMade.length, m.purchaseOrders.linkNotMade.length);
  eq("purchase orders: the report lists the links not made", jr.purchaseOrders.items.filter((p) => p.problem).map((p) => p.number).sort(), m.purchaseOrders.linkNotMade.map((p) => p.number).sort());

  // ---- 4. opening WIP ----------------------------------------------------------------------------------------------------------------
  const [w] = await q(`select count(*)::int n, coalesce(sum(value), 0)::text s, count(*) filter (where job_id is not null)::int ln, coalesce(sum(value) filter (where job_id is not null), 0)::text ls,
      count(*) filter (where job_id is null)::int un, coalesce(sum(value) filter (where job_id is null), 0)::text us, count(*) filter (where value is null)::int nv from public.opening_wip where organization_id = $1`);
  const srcTotal = wipSrc.reduce((a, r) => a + (parseMoneyPence(r.Value) ?? 0), 0);
  eq("wip: rows = the source", w.n, wipSrc.length);
  eq("wip: total to the penny = the source = the report's reconciliation", [num(w.s), srcTotal, jr.wip.totalPence], [m.wip.totalPence, m.wip.totalPence, m.wip.totalPence], (x) => x.map(fmt).join(" / "));
  eq("wip: linked to jobs (rows, value)", [w.ln, num(w.ls)], [m.wip.linkedRows, m.wip.linkedPence]);
  eq("wip: not linked: job not in the file, closed job, held job, no job (rows, value)", [w.un, num(w.us)], [m.wip.unlinkedRows, m.wip.unlinkedPence]);
  eq("wip: no value is invented (blank in SliQ stays blank)", w.nv, m.wip.notValued);
  const wl = await q("select w.source_job_ref r, j.job_no from public.opening_wip w left join public.jobs j on j.id = w.job_id where w.organization_id = $1 and w.job_id is not null");
  eq("wip: every link is to the job SliQ names", wl.filter((r) => r.r !== r.job_no).length, 0);
  const [inv] = await q("select count(*)::int n from public.invoices i where i.organization_id = $1 and (i.description ilike '%wip%' or exists (select 1 from public.invoice_line_items l where l.invoice_id = i.id and l.description ilike '%work in progress%'))");
  eq("wip: not written as an invoice (not revenue, not money owed)", inv.n, 0);

  // ---- 5. numbering ------------------------------------------------------------------------------------------------------------------
  const ctr = Object.fromEntries((await q("select prefix, last from public.doc_counters where organization_id = $1 and prefix in ('J', 'SO')")).map((r) => [r.prefix, Number(r.last)]));
  eq("numbering: the J counter is at the highest SliQ job number (closed J-1540 included)", ctr.J, Number(m.nextNumbers.job.slice(2)) - 1);
  eq("numbering: the SO counter is at the highest SliQ sales order number", ctr.SO, Number(m.nextNumbers.salesOrder.slice(3)) - 1);

  // ---- 6. the verification sheet a second person checks against SliQ -----------------------------------------------------------------
  const sheet = read(path.join(path.dirname(reportPath), "jobs-verification.csv")).filter((r) => /^\d+$/.test(r.Check ?? ""));
  eq("sheet: one row per job in the SliQ file", sheet.length, jobsSrc.length);
  eq("sheet: the jobs it lists as imported = the jobs in Tolra", sheet.filter((r) => r.Result === "imported").map((r) => r["Tolra job no"]).sort(), [...dbJobs.keys()].sort());
  eq("sheet: the SliQ open list less the held = the Tolra open list", sheet.filter((r) => r.Result !== "not imported: closed in SliQ" && !r.Result.startsWith("HELD")).length, board);
  const wsheet = read(path.join(path.dirname(reportPath), "wip-verification.csv"));
  const stated = wsheet.find((r) => r.Check === "Stated value, all rows");
  eq("sheet: the WIP sheet's total = Tolra's opening WIP", num(stated?.["SliQ job no"]), num(w.s), (x) => (x === null ? "missing" : fmt(x)));
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}
const fails = results.filter((r) => r.status === "FAIL").length;
console.log(`jobs checks: ${results.length - fails} PASS, ${fails} FAIL`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
process.exit(fails ? 1 : 0);
