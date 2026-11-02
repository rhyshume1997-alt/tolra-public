// What the jobs import would do: open jobs, the sales orders that feed them, the job link of each supplier purchase order, and the
// opening WIP, checked against the main import's plan (customers, quotes, purchase orders) and, when given, the target. Pure: no
// database, no files. The report section (report.jobsImport), the verification sheets and the markdown are made here.
//
// Rules (reviewer decisions 4-6, 2 Nov):
//   * Jobs: only OPEN jobs are imported (the status word says so); a closed or finished job is listed, never imported. The SliQ job
//     number is kept as the Tolra job number (job_no) and the J counter is moved past the highest SliQ job number, open or closed.
//     The customer is matched by its account code (stable id); only when the customers file has no codes, by a unique name. An
//     unknown customer, a duplicate number, a number Tolra already uses, or a quote number that this import does not write: held.
//   * Sales orders: imported only where they feed an imported job (as Tolra's "converted" order linked to that job). The rest are
//     listed: open ones are keyed by hand (cutover plan section 3).
//   * Purchase orders: written by the main import (supplier matched, status word mapped; an unknown supplier is refused there).
//     Here each one's job link is resolved: an imported job, or a job already in Tolra; otherwise the link is not made and listed.
//   * Opening WIP: only what the source states. A blank value stays blank (no valuation is worked out); it is never an invoice and
//     never revenue. Linked to a job where the job is imported (or already in Tolra), otherwise kept unlinked and listed.
import { legacyId, normNumber, normaliseName } from "./ids.mjs";
import { poundsString } from "./parse.mjs";

export const JOBS_REPORT_FORMAT = "sliq-jobs/1";
const OPEN_PO = new Set(["draft", "issued", "sent", "confirmed", "partial_received"]);
const where = (r) => ({ file: r._file, row: r._row });
const good = (rows) => rows.filter((r) => !r._bad);
const group = (rows, f) => {
  const m = new Map();
  for (const r of rows) {
    const k = normNumber(r[f]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};
const highest = (rows, field, re) => rows.reduce((a, r) => {
  const m = re.exec(normNumber(r[field]));
  return m ? Math.max(a, Number(m[1])) : a;
}, 0);

/** Customer resolver: by account code when the customers file has codes, otherwise by a unique normalised name. */
function customerResolver(customers) {
  const byKey = new Map();
  const byName = new Map();
  for (const c of customers) {
    if (c.key) byKey.set(c.key.trim().toLowerCase(), [...(byKey.get(c.key.trim().toLowerCase()) ?? []), c]);
    byName.set(c.nn, [...(byName.get(c.nn) ?? []), c]);
  }
  const method = byKey.size > 0 ? "account code" : "name (the customers file has no account codes)";
  const resolve = (ref) => {
    if (!ref) return { customer: null, reason: "no customer in the source" };
    const hits = byKey.size > 0 ? byKey.get(ref.trim().toLowerCase()) ?? [] : byName.get(normaliseName(ref)) ?? [];
    if (hits.length === 1) return { customer: hits[0] };
    if (hits.length > 1) return { customer: null, reason: `customer "${ref}" matches ${hits.length} customers (${byKey.size > 0 ? "duplicate account code" : "duplicate name"})` };
    return { customer: null, reason: `customer "${ref}" is not in the customers file (matched by ${byKey.size > 0 ? "account code" : "name"})` };
  };
  return { resolve, method };
}

/**
 * @param loaded      loadFolder's result
 * @param jobsLoaded  loadJobsFolder's result
 * @param opts        { plan, coreReport, organizationId, target } target = readJobsTarget's result or null (not checked)
 */
export function analyseJobs(loaded, jobsLoaded, { plan, coreReport, organizationId = null, target = null }) {
  if (!jobsLoaded?.profile) return { report: null, plan: null };
  const prof = jobsLoaded.profile;
  const rec = jobsLoaded.records;
  const oid = (kind, identity) => (organizationId ? legacyId(organizationId, kind, identity) : null);
  const { resolve: resolveCustomer, method } = customerResolver(plan.customers);
  const quotesByNo = new Map(plan.quotes.map((q) => [normNumber(q.number), q]));

  // ---- jobs --------------------------------------------------------------------------------------------------------------------
  const jobRows = good(rec.jobs);
  const jobsByNo = group(jobRows, "number");
  const soRows = good(rec.salesOrders);
  const soByNo = group(soRows, "number");
  const items = [];
  for (const j of jobRows) {
    const number = normNumber(j.number);
    const it = { number, statusRaw: j.statusRaw, open: !!j.status?.open, tolraStatus: j.status?.open ? j.status.status : null, stageRaw: j.stageRaw,
      stage: j.stage ?? (j.finishedDate ? "inspection" : null), customerRef: j.customer, customerName: null, quote: j.quote, salesOrder: j.salesOrder,
      description: j.description, dueDate: j.dueDate, specification: j.specification, startedDate: j.startedDate, finishedDate: j.finishedDate,
      valuePence: j.value, held: [], flags: [], oldId: oid("jobs", number), ...where(j) };
    items.push(it);
    if (!it.open) continue;
    if (jobsByNo.get(number).length > 1) it.held.push("duplicate job number in the source");
    const c = resolveCustomer(j.customer);
    if (c.customer) {
      it.customerName = c.customer.name;
      it.customerOldId = c.customer.oldId;
      it.customerIdentity = c.customer.identity;
    } else it.held.push(c.reason);
    if (j.quote) {
      const q = quotesByNo.get(normNumber(j.quote));
      if (!q) it.held.push(`quote ${j.quote} is not written by this import (not in the quotes file, or held there)`);
      else {
        it.quoteOldId = q.oldId;
        const qc = resolveCustomer(q.customer).customer;
        if (c.customer && qc && qc.identity !== c.customer.identity) it.flags.push(`quote ${q.number} is for ${qc.name}, the job for ${c.customer.name}`);
      }
    } else it.flags.push("no quote in the source: imported without a quote link");
    if (j.salesOrder && !soByNo.has(normNumber(j.salesOrder))) it.flags.push(`sales order ${j.salesOrder} is not in the sales orders file: no order link`);
    if (j.startedDate && j.finishedDate && j.finishedDate < j.startedDate) it.flags.push("finished before it was started (dates kept as stated)");
    if (j.finishedDate) it.flags.push("finished in SliQ but still open: imported as finished, awaiting inspection");
    if (!j.stage) it.flags.push(j.finishedDate ? "no stage in the source: Inspection (Tolra's stage for a finished job)" : "no stage in the source: Material (Tolra's default)");
    if (target) {
      const existing = target.jobs.get(number);
      const mapped = target.mappedJobs.get(String(it.oldId));
      if (existing && existing !== mapped) it.held.push("job number already used by a Tolra job in this company (held, so nothing is adopted)");
    }
  }
  const openItems = items.filter((i) => i.open);
  const written = openItems.filter((i) => i.held.length === 0);
  const writtenByNo = new Map(written.map((i) => [i.number, i]));

  // ---- sales orders: only those feeding an imported job -------------------------------------------------------------------------
  const soItems = [];
  for (const s of soRows) {
    const number = normNumber(s.number);
    const feeding = written.filter((i) => i.salesOrder && normNumber(i.salesOrder) === number);
    const it = { number, statusRaw: s.statusRaw, status: s.status, customerRef: s.customer, quote: s.quote, orderDate: s.orderDate, deliveryDate: s.deliveryDate,
      totalPence: s.total, notes: s.notes, job: s.job, feeds: feeding.map((i) => i.number), held: [], flags: [], oldId: oid("sales_orders", number), ...where(s) };
    soItems.push(it);
    if (feeding.length === 0) {
      it.notImported = ["open", "confirmed", "in_production"].includes(s.status) ? "open order with no open job in the jobs file: key it by hand (cutover plan section 3)" : `${s.statusRaw}: does not feed an open job, not imported`;
      continue;
    }
    if (soByNo.get(number).length > 1) it.held.push("duplicate order number in the source");
    if (feeding.length > 1) it.held.push(`feeds ${feeding.length} jobs (${it.feeds.join(", ")}): Tolra links one order to one job`);
    const c = resolveCustomer(s.customer);
    if (c.customer) {
      it.customerName = c.customer.name;
      it.customerOldId = c.customer.oldId;
      if (feeding.length === 1 && feeding[0].customerIdentity !== c.customer.identity) it.flags.push(`the order's customer differs from job ${feeding[0].number}'s`);
    } else it.held.push(c.reason);
    if (s.job && feeding.length === 1 && normNumber(s.job) !== feeding[0].number) it.flags.push(`the order says job ${s.job}, the jobs file links it to ${feeding[0].number}`);
    const q = s.quote ? quotesByNo.get(normNumber(s.quote)) : feeding.length === 1 && feeding[0].quoteOldId ? quotesByNo.get(normNumber(feeding[0].quote)) : null;
    if (s.quote && !q) it.flags.push(`quote ${s.quote} is not written by this import: no quote link`);
    it.quoteOldId = q?.oldId ?? null;
    it.quoteNumber = q?.number ?? null;
    if (target) {
      const existing = target.salesOrders.get(number);
      const mapped = target.mappedSalesOrders.get(String(it.oldId));
      if (existing && existing !== mapped) it.held.push("order number already used by a Tolra sales order in this company");
    }
  }
  const soWritten = soItems.filter((s) => !s.notImported && s.held.length === 0);
  // Tolra allows one sales order per quote (058): a second order for the same quote, in this import or already in Tolra, is written
  // without the quote link (listed), never held.
  const ours = new Set(target ? [...target.mappedSalesOrders.values()] : []);
  const quoteTaken = new Set(target ? [...target.salesOrderQuotes].filter(([, id]) => !ours.has(id)).map(([ref]) => ref) : []);
  for (const s of soWritten) {
    if (!s.quoteNumber) continue;
    if (quoteTaken.has(s.quoteNumber)) {
      s.flags.push(`quote ${s.quoteNumber} already has a sales order (Tolra allows one per quote): written without the quote link`);
      s.quoteOldId = null;
      s.quoteNumber = null;
    } else quoteTaken.add(s.quoteNumber);
  }
  for (const s of soItems.filter((x) => !x.notImported && x.held.length)) {
    for (const n of s.feeds) writtenByNo.get(n).flags.push(`sales order ${s.number} is held (${s.held.join("; ")}): no order link`);
  }
  for (const s of soWritten) {
    const j = writtenByNo.get(s.feeds[0]);
    j.soOldId = s.oldId;
    s.jobOldId = j.oldId;
  }

  // ---- purchase orders: the job link of each one the main import writes ----------------------------------------------------------
  const closedNos = new Set(items.filter((i) => !i.open).map((i) => i.number));
  const heldNos = new Set(openItems.filter((i) => i.held.length).map((i) => i.number));
  const jobLinkProblem = (ref) => closedNos.has(ref) ? `job ${ref} is closed in SliQ (not imported)` : heldNos.has(ref) ? `job ${ref} is held in this import` : `job ${ref} is not in the jobs file or in Tolra`;
  const poItems = plan.purchaseOrders.map((p) => {
    const ref = p.jobRef ? normNumber(p.jobRef) : null;
    const it = { number: p.number, supplier: p.supplierName, status: p.status, statusRaw: p.statusRaw ?? null, open: OPEN_PO.has(p.status), totalPence: p.total, jobRef: ref, link: null, problem: null, oldId: p.oldId, ...where(p) };
    if (!ref) return it;
    if (writtenByNo.has(ref)) it.link = { kind: "imported", jobOldId: writtenByNo.get(ref).oldId };
    else if (target?.jobs.has(ref)) it.link = { kind: "tolra", jobId: target.jobs.get(ref) };
    else it.problem = jobLinkProblem(ref);
    return it;
  });
  const poByJob = new Map();
  for (const p of poItems) if (p.link) poByJob.set(p.jobRef, [...(poByJob.get(p.jobRef) ?? []), p.number]);
  const byStatus = {};
  for (const p of poItems) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const poRefused = (coreReport?.purchaseOrders?.notWritten ?? []).filter((p) => p.reasons.some((r) => /supplier/.test(r)));

  // ---- opening WIP -------------------------------------------------------------------------------------------------------------
  const ordinal = new Map();
  const wipItems = good(rec.wip).map((w) => {
    const ref = w.job ? normNumber(w.job) : null;
    const n = (ordinal.get(ref ?? "") ?? 0) + 1;
    ordinal.set(ref ?? "", n);
    const identity = `${ref ?? ""}|${n}`;
    const key = organizationId ? String(legacyId(organizationId, "opening_wip", identity)) : null;
    const it = { jobRef: ref, description: w.description, quantityMilli: w.quantity, valuePence: w.value, asOf: w.asOf, reference: w.reference, key, link: null, problem: null, ...where(w) };
    if (!ref) it.problem = "no job in the source: kept unlinked";
    else if (writtenByNo.has(ref)) it.link = { kind: "imported", jobOldId: writtenByNo.get(ref).oldId };
    else if (target?.jobs.has(ref)) it.link = { kind: "tolra", jobId: target.jobs.get(ref) };
    else it.problem = `${jobLinkProblem(ref)}: kept unlinked`;
    return it;
  });
  const sum = (xs) => xs.reduce((a, x) => a + (x.valuePence ?? 0), 0);
  const wipByJob = new Map();
  for (const w of wipItems) if (w.link) wipByJob.set(w.jobRef, [...(wipByJob.get(w.jobRef) ?? []), w]);
  const wip = {
    rows: wipItems.length,
    valued: wipItems.filter((w) => w.valuePence !== null).length,
    notValued: wipItems.filter((w) => w.valuePence === null).length,
    totalPence: sum(wipItems),
    linked: { rows: wipItems.filter((w) => w.link).length, totalPence: sum(wipItems.filter((w) => w.link)) },
    unlinked: { rows: wipItems.filter((w) => !w.link).length, totalPence: sum(wipItems.filter((w) => !w.link)) },
    items: wipItems,
  };

  for (const i of written) {
    i.purchaseOrders = poByJob.get(i.number) ?? [];
    i.wipRows = (wipByJob.get(i.number) ?? []).length;
    i.wipPence = sum(wipByJob.get(i.number) ?? []);
  }
  const blockers = [];
  if (wipItems.length && target && !target.hasOpeningWip) blockers.push("the target has no public.opening_wip table (migration 136 is not applied): opening WIP cannot be written");
  const numbering = {
    highestSourceJob: highest(jobRows, "number", prof.jobNumberPattern),
    highestSourceSalesOrder: highest(soRows, "number", prof.salesOrderNumberPattern),
    jobNumberPattern: prof.jobNumberPattern.source,
    salesOrderNumberPattern: prof.salesOrderNumberPattern.source,
    jobNumbersOutsidePattern: jobRows.filter((r) => !prof.jobNumberPattern.test(normNumber(r.number))).map((r) => r.number),
  };

  const report = {
    format: JOBS_REPORT_FORMAT,
    customerMatching: method,
    inputs: jobsLoaded.inputs,
    filesNotSupplied: ["jobs", "salesOrders", "wip"].filter((k) => !jobsLoaded.present[k]),
    counts: {
      jobRows: rec.jobs.length, openInFile: openItems.length, closedInFile: items.length - openItems.length, jobsWritten: written.length, jobsHeld: openItems.length - written.length,
      salesOrderRows: rec.salesOrders.length, salesOrdersWritten: soWritten.length, salesOrdersHeld: soItems.filter((s) => !s.notImported && s.held.length).length, salesOrdersNotImported: soItems.filter((s) => s.notImported).length,
      purchaseOrdersWritten: poItems.length, purchaseOrdersOpen: poItems.filter((p) => p.open).length, purchaseOrdersLinked: poItems.filter((p) => p.link).length,
      purchaseOrderLinksNotMade: poItems.filter((p) => p.problem).length, purchaseOrdersRefusedSupplier: poRefused.length,
      wipRows: wip.rows, wipLinked: wip.linked.rows, wipUnlinked: wip.unlinked.rows,
    },
    jobs: items,
    salesOrders: soItems,
    purchaseOrders: { byStatus, items: poItems, refusedSupplier: poRefused.map((p) => ({ number: p.number, reasons: p.reasons })) },
    wip,
    numbering,
    blockers,
    targetChecked: !!target,
  };
  const jobsPlan = { jobs: written, salesOrders: soWritten, purchaseOrders: poItems.filter((p) => p.link), wip: wipItems, numbering, hasWip: wipItems.length > 0 };
  return { report, plan: jobsPlan };
}

// ---- output: markdown section and the two verification sheets ----------------------------------------------------------------------
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
// Every row as wide as the header (totals included), so the sheet reads in any strict CSV reader.
const csv = (rows) => `${rows.map((r) => [...r, ...Array(Math.max(0, rows[0].length - r.length)).fill("")].map(cell).join(",")).join("\r\n")}\r\n`;
const plainPounds = (p) => (p === null || p === undefined ? "" : poundsString(p).replace("£", ""));
const result = (i) => (!i.open ? "not imported: closed in SliQ" : i.held.length ? `HELD: ${i.held.join("; ")}` : "imported");

/** One row per job in the SliQ file, for a second person to tick against SliQ's own job list. */
export function jobsVerificationCsv(jr) {
  const head = ["Check", "SliQ job no", "Tolra job no", "Result", "SliQ status", "Tolra status", "Stage", "Customer (SliQ)", "Customer (Tolra)", "Quote", "Sales order",
    "Description", "Due date", "Started", "Finished", "Value", "Purchase orders linked", "WIP rows", "WIP value", "Notes", "Matches SliQ (Y/N)", "Checked by"];
  const rows = jr.jobs.map((i, n) => [n + 1, i.number, i.open && !i.held.length ? i.number : "", result(i), i.statusRaw, i.tolraStatus ?? "", i.open ? i.stage ?? "material" : "",
    i.customerRef, i.customerName ?? "", i.quote ?? "", i.salesOrder ?? "", i.description ?? "", i.dueDate ?? "", i.startedDate ?? "", i.finishedDate ?? "", plainPounds(i.valuePence),
    (i.purchaseOrders ?? []).join(" "), i.wipRows ?? "", i.wipRows ? plainPounds(i.wipPence) : "", i.flags.join("; "), "", ""]);
  const c = jr.counts;
  const foot = [[], ["Totals"], ["Open jobs in the SliQ file", c.openInFile], ["Imported as open jobs", c.jobsWritten], ["Held (not imported, see Result)", c.jobsHeld],
    ["Closed in SliQ (not imported)", c.closedInFile], ["The open jobs on Tolra's Job Board must equal the open jobs in SliQ less the held ones"]];
  return csv([head, ...rows, ...foot]);
}

/** One row per opening WIP line, as stated in SliQ, for John to confirm each value. Totals at the foot. */
export function wipVerificationCsv(jr) {
  const head = ["Check", "SliQ job no", "Linked to", "Description", "Quantity", "Value (as stated)", "As at", "Reference", "Notes", "Value confirmed by John (Y/N)", "Checked by"];
  const w = jr.wip;
  const rows = w.items.map((x, n) => [n + 1, x.jobRef ?? "", x.link ? (x.link.kind === "imported" ? `job ${x.jobRef} (this import)` : `job ${x.jobRef} (already in Tolra)`) : "not linked",
    x.description ?? "", x.quantityMilli === null ? "" : x.quantityMilli / 1000, x.valuePence === null ? "not valued in SliQ" : plainPounds(x.valuePence), x.asOf ?? "", x.reference ?? "", x.problem ?? "", "", ""]);
  const foot = [[], ["Totals"], ["WIP rows", w.rows], ["Stated value, all rows", plainPounds(w.totalPence)], ["Linked to jobs", plainPounds(w.linked.totalPence), `${w.linked.rows} rows`],
    ["Not linked", plainPounds(w.unlinked.totalPence), `${w.unlinked.rows} rows`], ["Rows with no value in SliQ (none worked out)", w.notValued],
    ["Opening WIP is not invoiced and is not revenue: it is kept in its own table"]];
  return csv([head, ...rows, ...foot]);
}

export function renderJobsMarkdown(jr) {
  if (!jr) return "";
  const money = (p) => (p === null || p === undefined ? "" : poundsString(p));
  const esc = (s) => String(s ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  const table = (h, rows) => (rows.length ? [`| ${h.join(" | ")} |`, `|${h.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`), ""] : ["None.", ""]);
  const c = jr.counts;
  const L = ["## 15. Jobs, sales orders, purchase order job links and opening WIP", ""];
  L.push(`Files: ${jr.inputs.map((i) => `${i.file}${i.sheet ? ` [${i.sheet}]` : ""} (${i.rows} rows, sha256 ${i.sha256.slice(0, 12)})`).join("; ") || "none"}. Not supplied: ${jr.filesNotSupplied.join(", ") || "none"}.`, "");
  L.push(`Customers matched by ${jr.customerMatching}.`, "");
  if (jr.blockers.length) L.push("**A write is refused:**", "", ...jr.blockers.map((b) => `* ${b}`), "");
  L.push(`**Open jobs in the SliQ file: ${c.openInFile}.** Imported ${c.jobsWritten}; held ${c.jobsHeld}. Closed in SliQ (not imported): ${c.closedInFile}. The verification sheet (jobs-verification.csv) lists every job for a second person to check against SliQ.`, "");
  L.push("Held jobs:", "", ...table(["Job", "Customer", "Why"], jr.jobs.filter((i) => i.open && i.held.length).map((i) => [i.number, i.customerRef, i.held.join("; ")])));
  L.push("Closed jobs (not imported):", "", ...table(["Job", "SliQ status", "Customer"], jr.jobs.filter((i) => !i.open).map((i) => [i.number, i.statusRaw, i.customerRef])));
  L.push("Imported jobs with notes:", "", ...table(["Job", "Notes"], jr.jobs.filter((i) => i.open && !i.held.length && i.flags.length).map((i) => [i.number, i.flags.join("; ")])));
  const n = jr.numbering;
  L.push(`Numbering: the SliQ job number is the Tolra job number. Highest SliQ job number ${n.highestSourceJob || "none"} (pattern ${n.jobNumberPattern}); the J counter is moved to at least that, so the next new Tolra job follows it. Highest sales order ${n.highestSourceSalesOrder || "none"} (pattern ${n.salesOrderNumberPattern}).${n.jobNumbersOutsidePattern.length ? ` Job numbers outside the pattern (kept as written, not counted): ${n.jobNumbersOutsidePattern.join(", ")}.` : ""}`, "");
  L.push(`Sales orders: ${c.salesOrderRows} in the file; ${c.salesOrdersWritten} imported (each feeds one imported job, written as converted to it); ${c.salesOrdersHeld} held; ${c.salesOrdersNotImported} not imported.`, "");
  L.push(...table(["Order", "SliQ status", "Result"], jr.salesOrders.filter((s) => s.notImported || s.held.length || s.flags.length).map((s) => [s.number, s.statusRaw, s.notImported ?? (s.held.length ? `HELD: ${s.held.join("; ")}` : s.flags.join("; "))])));
  L.push(`Purchase orders written by the main import: ${c.purchaseOrdersWritten} (${Object.entries(jr.purchaseOrders.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}); open ${c.purchaseOrdersOpen}. Linked to a job: ${c.purchaseOrdersLinked}. Refused for an unknown supplier: ${c.purchaseOrdersRefusedSupplier}${jr.purchaseOrders.refusedSupplier.length ? ` (${jr.purchaseOrders.refusedSupplier.map((p) => p.number).join(", ")})` : ""}.`, "");
  L.push("Job links not made (the order is written, without the link):", "", ...table(["PO", "Job", "Why"], jr.purchaseOrders.items.filter((p) => p.problem).map((p) => [p.number, p.jobRef, p.problem])));
  const w = jr.wip;
  L.push(`**Opening WIP (reconciliation):** ${w.rows} rows, stated value ${money(w.totalPence)} = linked to jobs ${money(w.linked.totalPence)} (${w.linked.rows} rows) + not linked ${money(w.unlinked.totalPence)} (${w.unlinked.rows} rows). Rows with no value in SliQ: ${w.notValued} (left blank; nothing is worked out). Opening WIP is kept in its own table: it is not an invoice, not money owed and not revenue. John confirms each value (wip-verification.csv).`, "");
  L.push("WIP not linked to a job:", "", ...table(["Row", "Job", "Value", "Why"], w.items.filter((x) => !x.link).map((x) => [x.row, x.jobRef ?? "", money(x.valuePence) || "not valued", x.problem])));
  return L.join("\n");
}
