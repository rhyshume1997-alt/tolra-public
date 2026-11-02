#!/usr/bin/env node
// Checks after the rehearsal import of export-jobdup (generate.mjs): a job number (J-1512) and a sales order number (SO-0205) SliQ
// used twice. Both copies must be kept under their own Tolra numbers with the SliQ number in source_ref (decision 2, as invoices),
// and every link the resolutions file named (jobLinks) must be exactly the one named, every other link the one SliQ names: 0 wrong
// attachments (decision 3). Reads the rehearsal database READ ONLY (one read-only transaction, rolled back).
//
//   node scripts/sliq-import/rehearsal/jobdup-checks.mjs --work <generate.mjs out folder> --report <dry-run report.json> \
//        --database-url postgresql://postgres@127.0.0.1:5432/<name with rehearsal> [--org-slug rehearsal-a]
//
// Every result line is PASS|FAIL <check> <detail>. Exit 1 on any FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

import { checkDatabaseUrl } from "../guard.mjs";
import { legacyId } from "../ids.mjs";
import { parseCsv } from "../parse.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, xs) => (t.startsWith("--") ? [...a, [t.slice(2), xs[i + 1]]] : a), []));
const { work, report: reportPath } = args;
const dbUrl = args["database-url"];
const slug = args["org-slug"] ?? "rehearsal-a";
if (!work || !dbUrl || !reportPath) {
  console.error("Usage: jobdup-checks.mjs --work <folder> --report <report.json> --database-url <local rehearsal url> [--org-slug s]");
  process.exit(2);
}
checkDatabaseUrl(dbUrl);
if (!/rehearsal/.test(new URL(dbUrl).pathname)) throw new Error("Refusing: these checks only run on a database whose name contains 'rehearsal'.");

const manifest = JSON.parse(readFileSync(path.join(work, "manifest.json"), "utf8"));
const d = manifest.jobDup;
const tolraName = manifest.expected.tolraNames;
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const resolutions = JSON.parse(readFileSync(path.join(work, "resolutions-jobdup.json"), "utf8"));
const read = (f) => {
  const { headers, rows } = parseCsv(readFileSync(f, "utf8"));
  return rows.map((r, i) => ({ ...Object.fromEntries(headers.map((h, k) => [h, r[k]])), _row: i + 2 }));
};
const results = [];
const out = (ok, check, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}|${check}|${detail}`);
};
const eq = (check, got, want) => out(JSON.stringify(got) === JSON.stringify(want), check, `${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);

const jobsSrc = read(path.join(work, "export-jobdup", "jobs.csv"));
const wipSrc = read(path.join(work, "export-jobdup", "wip.csv"));
const poSrc = read(path.join(work, "export-jobdup", "purchase-orders.csv"));
const links = resolutions.jobLinks;

// ---- the approved dry run ------------------------------------------------------------------------------------------------------------
eq("report: nothing ambiguous or unmatched is left once the links are named", [report.unresolvedMatchCount, report.jobsImport.unresolvedMatchCount, report.jobsImport.problems], [0, 0, []]);
eq("report: both copies logged with their Tolra numbers (first in the file keeps the job number, earliest order date the order's)",
  report.renames.filter((x) => ["job", "sales_order"].includes(x.kind)).map((x) => `${x.kind}|${x.sourceNumber}|${x.number}|${x.keeps}`),
  [`job|${d.job}|${d.job}|true`, `job|${d.job}|${d.jobB}|false`, `sales_order|${d.salesOrder}|${d.salesOrder}|true`, `sales_order|${d.salesOrder}|${d.salesOrderB}|false`]);
const sheet = read(path.join(path.dirname(reportPath), "jobs-verification.csv")).filter((r) => /^\d+$/.test(r.Check ?? ""));
eq("sheet: the jobs sheet lists SliQ's J-1512 twice, with each Tolra number", sheet.filter((r) => r["SliQ job no"] === d.job).map((r) => r["Tolra job no"]), [d.job, d.jobB]);

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("begin read only");
try {
  const org = (await db.query("select id from public.organizations where slug = $1", [slug])).rows[0]?.id;
  if (!org) throw new Error(`no organisation with slug ${slug}`);
  const q = async (sql, params = []) => (await db.query(sql, [org, ...params])).rows;

  // ---- 1. both copies kept, the SliQ number in source_ref ------------------------------------------------------------------------
  const jobs = await q("select job_no, source_ref, customer from public.jobs where organization_id = $1 and source_ref = $2 order by job_no", [d.job]);
  const first = manifest.jobs.importedJobs.find((j) => j.number === d.job);
  eq("jobs: J-1512 and J-1512-B, both with SliQ number J-1512, each on its own customer", jobs.map((r) => [r.job_no, r.source_ref, r.customer]), [[d.job, d.job, first.customer], [d.jobB, d.job, tolraName[d.jobBAccount]]]);
  const all = await q("select job_no, source_ref from public.jobs where organization_id = $1");
  eq("jobs: every imported job keeps its SliQ number (source_ref); only the copy is renamed", all.filter((r) => r.source_ref !== r.job_no).map((r) => r.job_no), [d.jobB]);
  eq("jobs: imported = the open jobs in the file less the excluded one", all.length, jobsSrc.filter((r) => ["Open", "In Progress", "At Risk", "Late"].includes(r.Status)).length - manifest.jobs.held.length);
  const sos = await q(`select so.so_number, so.source_ref, j.job_no from public.sales_orders so left join public.jobs j on j.id = so.converted_to_job_id
                       where so.organization_id = $1 and so.source_ref = $2 order by 1`, [d.salesOrder]);
  eq("sales orders: SO-0205 feeds J-1515 as named; SO-0205-B (open, no job) is not imported", sos.map((r) => [r.so_number, r.source_ref, r.job_no]), [[d.salesOrder, d.salesOrder, d.salesOrderJob]]);
  const j1515 = await q("select so.so_number from public.jobs j join public.sales_orders so on so.id = j.converted_from_sales_order_id where j.organization_id = $1 and j.job_no = $2", [d.salesOrderJob]);
  eq("jobs: J-1515's order is SO-0205, the one the resolutions file names", j1515.map((r) => r.so_number), [d.salesOrder]);
  const ctr = (await q("select last from public.doc_counters where organization_id = $1 and prefix = 'J'"))[0];
  eq("numbering: a renamed copy does not move the J counter (still the highest SliQ number)", Number(ctr?.last), Number(manifest.jobs.nextNumbers.job.slice(2)) - 1);

  // ---- 2. 0 wrong attachments: each WIP line and purchase order is on the job named (resolutions) or the one SliQ names -------------
  const wipDb = new Map((await q("select w.source_key, j.job_no from public.opening_wip w left join public.jobs j on j.id = w.job_id where w.organization_id = $1")).map((r) => [r.source_key, r.job_no]));
  const ordinal = new Map();
  const tolraNos = new Set(all.map((r) => r.job_no));
  const heldOrClosed = new Set([...manifest.jobs.held, ...manifest.jobs.closed.map((c) => c.number)]);
  let checked = 0;
  const wrong = [];
  for (const r of wipSrc) {
    const ref = r["Job No"] || null;
    const n = (ordinal.get(ref ?? "") ?? 0) + 1;
    ordinal.set(ref ?? "", n);
    const key = String(legacyId(org, "opening_wip", `${ref ?? ""}|${n}`));
    const named = links.find((l) => l.kind === "wip" && l.row === r._row);
    const want = named ? named.job : ref && tolraNos.has(ref) && !heldOrClosed.has(ref) ? ref : null;
    const got = wipDb.has(key) ? wipDb.get(key) : "missing";
    checked++;
    if (got !== want) wrong.push(`row ${r._row}: ${got} (expected ${want})`);
  }
  out(wrong.length === 0 && checked === wipSrc.length, "wip: every line on the job named or SliQ's own; 0 wrong attachments", `${checked} lines checked, ${wrong.length} wrong${wrong.length ? `: ${wrong.slice(0, 3).join("; ")}` : ""}`);
  eq("wip: the lines on SliQ's J-1512 went where the resolutions file says", [...d.wipToFirst, ...d.wipToSecond].map((row) => links.find((l) => l.kind === "wip" && l.row === row).job), [...d.wipToFirst.map(() => d.job), ...d.wipToSecond.map(() => d.jobB)]);
  const poDb = new Map((await q("select o.po_ref, j.job_no from public.purchase_orders o left join public.jobs j on j.id = o.job_id where o.organization_id = $1")).map((r) => [r.po_ref, r.job_no]));
  const poWrong = [];
  for (const r of poSrc) {
    if (!poDb.has(r["PO No"])) continue; // held (the unknown supplier) or a renamed copy (no job)
    const named = links.find((l) => l.kind === "purchase_order" && l.number === r["PO No"]);
    const ref = r["Job No"] || null;
    const want = named ? named.job : ref && tolraNos.has(ref) && !heldOrClosed.has(ref) ? ref : null;
    if (poDb.get(r["PO No"]) !== want) poWrong.push(`${r["PO No"]}: ${poDb.get(r["PO No"])} (expected ${want})`);
  }
  out(poWrong.length === 0, "purchase orders: every job link is the one named or SliQ's own; 0 wrong attachments", `${poWrong.length} wrong${poWrong.length ? `: ${poWrong.slice(0, 3).join("; ")}` : ""}`);
  eq("purchase orders: the order on SliQ's J-1512 is on the first J-1512, as named", d.purchaseOrdersToFirst.map((n) => poDb.get(n)), d.purchaseOrdersToFirst.map(() => d.job));
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}
const fails = results.filter((r) => !r).length;
console.log(`jobdup checks: ${results.length - fails} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
