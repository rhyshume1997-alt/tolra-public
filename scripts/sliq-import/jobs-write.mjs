// The jobs part of the write, inside the main import's ONE transaction (write.mjs calls it): jobs and the sales orders that feed
// them go to public.import_legacy_tenant() in the same JSON as everything else (so a job's quote link resolves through
// legacy_import_map), then, after the importer: each new order's customer link, each new purchase order's job link, the opening
// WIP rows (public.opening_wip, migration 136), the SliQ number of each new job and order in source_ref (migration 135), and the J
// and SO counters moved past the highest SliQ numbers. Every step is
// checked before the transaction commits; any failure rolls the whole import back. A repeat run creates nothing.
import pg from "pg";

import { GuardError, checkDatabaseUrl, checkOrganisationId } from "./guard.mjs";
import { legacyId, normNumber } from "./ids.mjs";
import { analyseJobs, jobsKnownNumbers } from "./jobs-plan.mjs";
import { penceToPounds } from "./parse.mjs";

const money = (p) => (p === null || p === undefined ? null : Number(penceToPounds(p)));
const noon = (d) => (d ? `${d}T12:00:00+00:00` : null);

/** What the target already holds for the jobs import: job and order numbers, which of them an earlier run made, the WIP table. */
export async function readJobsTarget(db, organizationId, jobsLoaded) {
  const org = checkOrganisationId(organizationId);
  const refs = async (table, col) => new Map((await db.query(`select ${col} as ref, id from public.${table} where organization_id = $1 and ${col} is not null`, [org])).rows.map((r) => [r.ref, r.id]));
  const target = {
    jobs: await refs("jobs", "job_no"), salesOrders: await refs("sales_orders", "so_number"), mappedJobs: new Map(), mappedSalesOrders: new Map(),
    salesOrderQuotes: new Map((await db.query("select q.quote_ref, so.id from public.sales_orders so join public.quotes q on q.id = so.quote_id where so.organization_id = $1", [org])).rows.map((r) => [r.quote_ref, r.id])),
    hasOpeningWip: (await db.query("select to_regclass('public.opening_wip') is not null as ok")).rows[0].ok,
    counters: Object.fromEntries((await db.query("select prefix, last from public.doc_counters where organization_id = $1 and prefix in ('J', 'SO')", [org])).rows.map((r) => [r.prefix, Number(r.last)])),
  };
  const hasMap = (await db.query("select to_regclass('public.legacy_import_map') is not null as ok")).rows[0].ok;
  if (hasMap && jobsLoaded?.profile) {
    // The ids analyseJobs gives: legacyId of the organisation and the Tolra number. The source's numbers and the target's own: a
    // copy renamed on an earlier run (J-1512-B) is keyed by its Tolra number.
    const ids = (rows, kind, own) => [...new Set([...rows.filter((r) => r.number).map((r) => normNumber(r.number)), ...jobsKnownNumbers(jobsLoaded), ...own.keys()].map((n) => String(legacyId(org, kind, n))))];
    for (const [source, kind, list] of [["jobs", "mappedJobs", ids(jobsLoaded.records.jobs, "jobs", target.jobs)], ["sales_orders", "mappedSalesOrders", ids(jobsLoaded.records.salesOrders, "sales_orders", target.salesOrders)]]) {
      if (!list.length) continue;
      const m = await db.query("select old_id, new_id from public.legacy_import_map where source = $1 and old_id = any($2::text[])", [source, list]);
      for (const r of m.rows) target[kind].set(r.old_id, r.new_id);
    }
  }
  return target;
}

/** Dry run: the jobs target read in its own read-only transaction (same URL screening as every other connection). */
export async function readJobsTargetReadOnly(databaseUrl, organizationId, jobsLoaded) {
  checkDatabaseUrl(databaseUrl);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const { rows } = await db.query("select current_database() as name");
    checkDatabaseUrl(`postgresql://x@127.0.0.1/${rows[0].name}`);
    await db.query("begin read only");
    const t = await readJobsTarget(db, organizationId, jobsLoaded);
    await db.query("rollback");
    return t;
  } finally {
    await db.end();
  }
}

/**
 * Called inside writeImport's transaction, after the main analyse and before the importer runs. Returns
 * { report, addToExport(json), finish() }; finish() runs after the importer, before COMMIT.
 */
export async function prepareJobsWrite(db, organizationId, { loaded, jobsLoaded, plan, coreReport, excludeNumbers = [], resolutions = null }) {
  const org = checkOrganisationId(organizationId);
  const target = await readJobsTarget(db, org, jobsLoaded);
  const { report, plan: jp } = analyseJobs(loaded, jobsLoaded, { plan, coreReport, organizationId: org, target, excludeNumbers, resolutions });
  if (!jp) return { report: null, addToExport() {}, async finish() { return null; } };
  if (report.blockers.length) throw new GuardError(`Refusing: ${report.blockers.join("; ")}.`);
  if (report.problems.length) throw new GuardError(`Refusing: the resolutions file does not fit the jobs files: ${report.problems.join("; ")}.`);
  if (report.unresolvedMatchCount > 0) {
    const list = report.ambiguities.filter((a) => a.blocksWrite).map((a) => `${a.kind} ${a.number}`);
    throw new GuardError(`Refusing: ${list.length} job, sales order or job-link match(es) are ambiguous or unmatched (${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}). See ambiguity.csv.`);
  }
  const known = async (source, ids) => new Set((await db.query("select old_id from public.legacy_import_map where source = $1 and old_id = any($2::text[])", [source, ids.map(String)])).rows.map((r) => r.old_id));
  const knownJobs = await known("jobs", jp.jobs.map((j) => j.oldId));
  const knownSOs = await known("sales_orders", jp.salesOrders.map((s) => s.oldId));
  const knownPOs = await known("purchase_orders", jp.purchaseOrders.map((p) => p.oldId));

  function addToExport(json) {
    json.jobs = jp.jobs.map((j) => ({
      id: j.oldId, organization_id: org, job_ref: j.number, quote_id: j.quoteOldId ?? null, customer: j.customerName, description: j.description ?? null,
      stage: j.stage, due_date: j.dueDate, value: money(j.valuePence), status: j.tolraStatus, specification: j.specification ?? null, drawings: [],
      started_at: noon(j.startedDate), finished_at: noon(j.finishedDate), converted_from_sales_order_id: j.soOldId ?? null, converted_at: null,
    }));
    // An order that fed a job is Tolra's "converted" order linked to it; its SliQ status word is in the report.
    json.sales_orders = jp.salesOrders.map((s) => ({
      id: s.oldId, organization_id: org, order_ref: s.number, customer: s.customerName, quote_id: s.quoteOldId === null ? null : String(s.quoteOldId), status: "converted",
      order_date: s.orderDate, expected_delivery: s.deliveryDate, total_value: money(s.totalPence), notes: s.notes ?? null, converted_to_job_id: s.jobOldId, converted_at: null,
    }));
    json.counts.jobs = json.jobs.length;
    json.counts.sales_orders = json.sales_orders.length;
  }

  async function finish() {
    const created = { jobs: 0, salesOrders: 0, jobValues: 0, purchaseOrderJobLinks: 0, wipRows: 0, wipValue: "0.00", counters: {} };
    const newId = async (source, oldId) => (await db.query("select new_id from public.legacy_import_map where source = $1 and old_id = $2", [source, String(oldId)])).rows[0]?.new_id ?? null;
    const newJobs = [];
    for (const j of jp.jobs) {
      if (knownJobs.has(String(j.oldId))) continue;
      const id = await newId("jobs", j.oldId);
      await db.query("update public.jobs set source_ref = $3 where id = $1 and organization_id = $2", [id, org, j.sourceNumber]);
      const row = (await db.query("select job_no, source_ref, customer, quote_id, converted_from_sales_order_id as so from public.jobs where id = $1 and organization_id = $2", [id, org])).rows[0];
      if (!row || row.job_no !== j.number || row.source_ref !== j.sourceNumber || row.customer !== j.customerName) throw new Error(`job ${j.number} was not written as planned: rolled back`);
      if (Boolean(row.quote_id) !== Boolean(j.quoteOldId)) throw new Error(`job ${j.number}: the quote link is not as planned: rolled back`);
      newJobs.push(id);
      created.jobs++;
      if (j.valuePence !== null && j.valuePence !== undefined) created.jobValues++;
    }
    for (const s of jp.salesOrders) {
      if (knownSOs.has(String(s.oldId))) continue;
      const id = await newId("sales_orders", s.oldId);
      const cust = await newId("customers", s.customerOldId);
      if (!cust) throw new Error(`sales order ${s.number}: its customer was not written by this import: rolled back`);
      const u = await db.query("update public.sales_orders set customer_id = $3, source_ref = $5 where id = $1 and organization_id = $2 and so_number = $6 and converted_to_job_id = (select new_id from public.legacy_import_map where source = 'jobs' and old_id = $4) returning id", [id, org, cust, String(s.jobOldId), s.sourceNumber, s.number]);
      if (u.rowCount !== 1) throw new Error(`sales order ${s.number} is not linked to its job and customer as planned: rolled back`);
      created.salesOrders++;
    }
    for (const p of jp.purchaseOrders) {
      if (knownPOs.has(String(p.oldId))) continue; // an order imported before is not touched again
      const po = await newId("purchase_orders", p.oldId);
      const job = p.link.kind === "imported" ? await newId("jobs", p.link.jobOldId) : p.link.jobId;
      const u = await db.query(
        "update public.purchase_orders o set job_id = $3 where o.id = $1 and o.organization_id = $2 and o.job_id is null and exists (select 1 from public.jobs j where j.id = $3 and j.organization_id = $2 and j.job_no = $4) returning o.id",
        [po, org, job, p.link.jobNo],
      );
      if (u.rowCount !== 1) throw new Error(`purchase order ${p.number} could not be linked to job ${p.jobRef}: rolled back`);
      created.purchaseOrderJobLinks++;
    }
    if (jp.hasWip) {
      let expected = 0;
      const keys = [];
      for (const w of jp.wip) {
        const job = !w.link ? null : w.link.kind === "imported" ? await newId("jobs", w.link.jobOldId) : w.link.jobId;
        const ins = await db.query(
          `insert into public.opening_wip (organization_id, job_id, source_job_ref, description, quantity, value, as_of, source_reference, source_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (organization_id, source_key) do nothing returning id`,
          [org, job, w.jobRef, w.description ?? null, w.quantityMilli === null ? null : w.quantityMilli / 1000, money(w.valuePence), w.asOf, w.reference ?? null, w.key],
        );
        if (ins.rowCount) {
          created.wipRows++;
          expected += w.valuePence ?? 0;
          keys.push(w.key);
        }
      }
      if (keys.length) {
        const [t] = (await db.query("select coalesce(sum(value), 0)::text s, count(*)::int n from public.opening_wip where organization_id = $1 and source_key = any($2::text[])", [org, keys])).rows;
        if (t.n !== keys.length || t.s !== penceToPounds(expected)) throw new Error(`opening WIP total ${t.s} differs from the source ${penceToPounds(expected)}: rolled back`);
        created.wipValue = t.s;
      }
    }
    // Counters: past the highest SliQ number (open or closed), never backwards. The importer has already reseeded from Tolra's own rows.
    for (const [prefix, n] of [["J", jp.numbering.highestSourceJob], ["SO", jp.numbering.highestSourceSalesOrder]]) {
      if (n > 0) {
        await db.query(
          "insert into public.doc_counters as c (organization_id, prefix, last) values ($1, $2, $3) on conflict (organization_id, prefix) do update set last = greatest(c.last, excluded.last)",
          [org, prefix, n],
        );
      }
      const r = (await db.query("select last from public.doc_counters where organization_id = $1 and prefix = $2", [org, prefix])).rows[0];
      created.counters[prefix] = r ? Number(r.last) : 0;
      if (n > 0 && created.counters[prefix] < n) throw new Error(`the ${prefix} counter is below the highest SliQ number: rolled back`);
    }
    return created;
  }

  return { report, addToExport, finish };
}
