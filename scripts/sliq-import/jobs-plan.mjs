// What the jobs import would do: open jobs, the sales orders that feed them, the job link of each supplier purchase order, and the
// opening WIP, checked against the main import's plan (customers, quotes, purchase orders) and, when given, the target. Pure: no
// database, no files. The report section (report.jobsImport), the verification sheets and the markdown are made here.
//
// Rules (reviewer decisions 4-6, 2 Nov, held to the core import's decisions 2 and 3 when the two were joined):
//   * Jobs: only OPEN jobs are imported (the status word says so); a closed or finished job is listed, never imported. Numbering
//     is the core import's rule for invoices, quotes and purchase orders: the SliQ job number is the Tolra job number (job_no), the
//     number SliQ printed is kept in source_ref (migration 135), and a number SliQ used for two open jobs keeps every copy (the
//     first in the file keeps J-1512, the next is J-1512-B, then -C; the same every run). The J counter is moved past the highest
//     SliQ job number, open or closed. A number a live Tolra job already uses is held (nothing is adopted).
//   * Customers: matched exactly as the core import matches documents (reconcile.mjs, decision 3): the account, or a name exactly
//     one customer has; anything else is ambiguous or unmatched, listed in ambiguity.csv, and stops the write until the resolutions
//     file names the account (customerMatches, kind "job" or "sales_order") or the job is excluded by number.
//   * Links: a job's quote and sales order, a sales order's quote, a purchase order's job and a WIP line's job name a SliQ number.
//     When SliQ used that number for more than one record the link cannot be made from the files: it is ambiguous, listed, and stops
//     the write until the resolutions file names the Tolra number to link to (jobLinks) or the record is excluded. Never a guess.
//   * Sales orders: imported only where they feed an imported job (as Tolra's "converted" order linked to that job); numbered and
//     kept like jobs (SO-0205, SO-0205-B; earliest order date first). The rest are listed: open ones are keyed by hand.
//   * Purchase orders: written by the main import (supplier matched, status word mapped; an unknown supplier stops the write there).
//     Here each one's job link is resolved: an imported job, or a job already in Tolra; otherwise the link is not made and listed.
//   * Opening WIP: only what the source states. A blank value stays blank (no valuation is worked out); it is never an invoice and
//     never revenue. Every line is kept, a line SliQ lists twice too (flagged). Linked to a job where the job is imported (or
//     already in Tolra), otherwise kept unlinked and listed.
import { legacyId, normNumber } from "./ids.mjs";
import { poundsString } from "./parse.mjs";
import { numberCopies } from "./reconcile.mjs";

export const JOBS_REPORT_FORMAT = "sliq-jobs/2";
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
// Jobs: SliQ exports no creation date, so the first copy in the file keeps the number. Sales orders: the earliest order date.
const numberJobs = (jobsLoaded) => numberCopies(good(jobsLoaded.records.jobs).filter((j) => j.status?.open), "job", "_noDate");
const numberSalesOrders = (jobsLoaded) => numberCopies(good(jobsLoaded.records.salesOrders), "sales_order", "orderDate");

/** Every job and sales-order number of the jobs files, as SliQ wrote it and as Tolra will number it, so --exclude may name them. */
export function jobsKnownNumbers(jobsLoaded) {
  if (!jobsLoaded?.profile) return [];
  const rec = jobsLoaded.records;
  return [...new Set([...good(rec.jobs), ...good(rec.salesOrders), ...numberJobs(jobsLoaded).rows, ...numberSalesOrders(jobsLoaded).rows].map((r) => normNumber(r.number)).filter(Boolean))];
}

/** Adds the jobs import's ambiguities, resolution problems and renamed numbers to the core report (dry run and write alike). */
export function mergeJobsIntoReport(report, jr) {
  if (!jr) return report;
  report.customerMatching.ambiguities.push(...jr.ambiguities);
  report.customerMatching.problems.push(...jr.problems);
  report.unresolvedMatchCount += jr.unresolvedMatchCount;
  report.renames.push(...jr.renames);
  report.writePlan.renamedDocuments = report.renames.filter((x) => !x.keeps).length;
  if (jr.problems.length) report.writable = false;
  return report;
}

const LINK_FIELDS = { job: ["salesOrder", "quote"], sales_order: ["quote"], purchase_order: ["job"], wip: ["job"] };

/**
 * @param loaded      loadFolder's result
 * @param jobsLoaded  loadJobsFolder's result
 * @param opts        { plan, coreReport, organizationId, target, excludeNumbers, resolutions } target = readJobsTarget's result or null
 */
export function analyseJobs(loaded, jobsLoaded, { plan, coreReport, organizationId = null, target = null, excludeNumbers = [], resolutions = null }) {
  if (!jobsLoaded?.profile) return { report: null, plan: null };
  const prof = jobsLoaded.profile;
  const rec = jobsLoaded.records;
  const oid = (kind, identity) => (organizationId ? legacyId(organizationId, kind, identity) : null);
  const excluded = new Set(excludeNumbers.map(normNumber));
  const isExcluded = (it) => excluded.has(it.number) || excluded.has(it.sourceNumber);
  const ambiguities = [];
  const problems = [];

  // ---- the resolutions file: jobLinks ------------------------------------------------------------------------------------------
  const linkEntries = (resolutions?.jobLinks ?? []).map((e, i) => ({ e, i, used: 0 }));
  for (const m of linkEntries) {
    const fields = LINK_FIELDS[m.e?.kind];
    if (!fields) problems.push(`jobLinks entry ${m.i + 1}: kind must be one of ${Object.keys(LINK_FIELDS).join(", ")}`);
    else if (m.e.kind === "wip" ? !Number.isInteger(m.e.row) : !normNumber(m.e.number)) problems.push(`jobLinks entry ${m.i + 1}: ${m.e.kind === "wip" ? "\"row\" (the WIP file's row number)" : "\"number\""} is needed`);
    else if (!fields.some((f) => f in m.e)) problems.push(`jobLinks entry ${m.i + 1}: give ${fields.map((f) => `"${f}"`).join(" or ")} (a Tolra number, or null for no link)`);
  }
  // The link the resolutions file names for one record's field: undefined (none given), { value } (a Tolra number or null), or
  // { conflict } when two entries fit.
  const linkFor = (kind, it, field) => {
    const hits = linkEntries.filter((m) => LINK_FIELDS[m.e?.kind] && m.e.kind === kind && field in m.e
      && (kind === "wip" ? m.e.row === it.row : [it.number, it.sourceNumber].includes(normNumber(m.e.number)) && (m.e.row === undefined || m.e.row === it.row)));
    if (hits.length === 0) return undefined;
    for (const h of hits) h.used++;
    if (hits.length > 1) return { conflict: true };
    return { value: hits[0].e[field] === null ? null : normNumber(hits[0].e[field]) };
  };
  const blocked = (it, kind, ref, reason, candidates, resolveWith) => {
    ambiguities.push({ kind, number: it.number ?? `row ${it.row}`, sourceNumber: it.sourceNumber ?? null, reference: ref ?? null, status: "ambiguous", reason, candidates,
      blocksWrite: !it.excluded, resolveWith, file: it.file, row: it.row });
  };
  const resolveHint = (kind, it, field) => `jobLinks: {"kind":"${kind}",${kind === "wip" ? `"row":${it.row}` : `"number":"${it.number}"`},"${field}":"<Tolra number, or null>"}${kind === "wip" ? "" : ` or --exclude ${it.number}`}`;
  const customerOldId = new Map(plan.customers.map((c) => [c.identity, c.oldId]));
  // Customers: the core import's match (account, or a name exactly one customer has; customerMatches for kind job / sales_order).
  const matchCustomer = (kind, it, ref) => {
    const m = plan.matchCustomer(kind, { number: it.number, sourceNumber: it.sourceNumber, _row: it.row, date: it.date ?? undefined }, ref);
    if (m.status === "ok") return m.entry;
    it.held.push(`customer ${m.status}: ${m.reason} (see the ambiguity report)`);
    ambiguities.push({ kind, number: it.number, sourceNumber: it.sourceNumber, reference: ref ?? null, status: m.status, reason: m.reason, candidates: m.candidates, blocksWrite: !it.excluded, file: it.file, row: it.row });
    return null;
  };

  // ---- quotes as SliQ numbered them: a number used twice cannot be linked from the files ---------------------------------------
  const quoteRowsBySource = group(good(loaded.records.quotes), "number");
  const writtenQuotesBySource = group(plan.quotes, "sourceRef");
  const writtenQuotesByNo = new Map(plan.quotes.map((q) => [normNumber(q.number), q]));
  const quoteFor = (kind, it, raw) => {
    const ref = normNumber(raw);
    const r = linkFor(kind, it, "quote");
    if (r?.conflict) {
      blocked(it, kind, ref, "more than one jobLinks entry gives this record's quote", [], resolveHint(kind, it, "quote"));
      return { held: "quote link ambiguous (see the ambiguity report)" };
    }
    if (r) {
      if (r.value === null) return { flag: `quote ${ref}: no quote link (resolutions file)` };
      const q = writtenQuotesByNo.get(r.value);
      if (!q) problems.push(`jobLinks: ${kind} ${it.number} names quote ${r.value}, which this import does not write`);
      return { quote: q ?? null };
    }
    const copies = quoteRowsBySource.get(ref) ?? [];
    if (copies.length > 1) {
      blocked(it, kind, ref, `SliQ used quote number ${ref} for ${copies.length} quotes: the files cannot say which one this is`,
        (writtenQuotesBySource.get(ref) ?? []).map((q) => ({ account: q.number, name: q.customerName, row: q._row })), resolveHint(kind, it, "quote"));
      return { held: "quote link ambiguous (see the ambiguity report)" };
    }
    const q = (writtenQuotesBySource.get(ref) ?? [])[0];
    return q ? { quote: q } : { held: `quote ${raw} is not written by this import (not in the quotes file, or held there)` };
  };

  // ---- numbering: every copy of a number SliQ used twice is kept, under its own Tolra number (as the core import's decision 2) --
  const jobCopies = numberJobs(jobsLoaded);
  const soCopies = numberSalesOrders(jobsLoaded);
  const jobRows = good(rec.jobs);
  const jobRowsBySource = group(jobRows, "number");
  const numberedJob = new Map(jobCopies.rows.map((r) => [`${r._file}\u0000${r._row}`, r]));
  const soRows = soCopies.rows;
  const soBySource = group(soRows, "sourceNumber");

  // ---- jobs --------------------------------------------------------------------------------------------------------------------
  const items = [];
  for (const j of jobRows) {
    const nj = numberedJob.get(`${j._file}\u0000${j._row}`) ?? { ...j, sourceNumber: j.number };
    const number = normNumber(nj.number);
    const sourceNumber = normNumber(j.number);
    const it = { number, sourceNumber, renamed: number !== sourceNumber, statusRaw: j.statusRaw, open: !!j.status?.open, tolraStatus: j.status?.open ? j.status.status : null, stageRaw: j.stageRaw,
      stage: j.stage ?? (j.finishedDate ? "inspection" : null), customerRef: j.customer, customerName: null, quote: j.quote, salesOrder: j.salesOrder,
      description: j.description, dueDate: j.dueDate, specification: j.specification, startedDate: j.startedDate, finishedDate: j.finishedDate,
      valuePence: j.value, held: [], flags: [], excluded: false, oldId: oid("jobs", number), ...where(j) };
    items.push(it);
    if (!it.open) continue;
    if (isExcluded(it)) {
      it.excluded = true;
      it.held.push("excluded by number (operator decision)");
    }
    if (it.renamed) it.flags.push(`SliQ used ${sourceNumber} for ${jobRowsBySource.get(sourceNumber).length} jobs: this one is ${number} in Tolra (SliQ number kept as its source reference)`);
    const c = matchCustomer("job", it, j.customer);
    if (c) {
      it.customerName = c.tolraName;
      it.customerOldId = customerOldId.get(c.identity);
      it.customerIdentity = c.identity;
    }
    if (j.quote) {
      const q = quoteFor("job", it, j.quote);
      if (q.held) it.held.push(q.held);
      if (q.flag) it.flags.push(q.flag);
      if (q.quote) {
        it.quoteOldId = q.quote.oldId;
        it.quoteNumber = q.quote.number;
        if (c && q.quote.customerName !== c.tolraName) it.flags.push(`quote ${q.quote.number} is for ${q.quote.customerName}, the job for ${c.tolraName}`);
      }
    } else it.flags.push("no quote in the source: imported without a quote link");
    if (j.salesOrder) {
      const ref = normNumber(j.salesOrder);
      const r = linkFor("job", it, "salesOrder");
      const copies = soBySource.get(ref) ?? [];
      if (r?.conflict) {
        blocked(it, "job", ref, "more than one jobLinks entry gives this job's sales order", [], resolveHint("job", it, "salesOrder"));
        it.held.push("sales order link ambiguous (see the ambiguity report)");
      } else if (r) {
        if (r.value === null) it.flags.push(`sales order ${ref}: no order link (resolutions file)`);
        else if (!soRows.some((s) => normNumber(s.number) === r.value)) problems.push(`jobLinks: job ${number} names sales order ${r.value}, which is not in the sales orders file`);
        else it.soNumber = r.value;
      } else if (copies.length > 1) {
        blocked(it, "job", ref, `SliQ used sales order number ${ref} for ${copies.length} orders: the files cannot say which one feeds this job`,
          copies.map((s) => ({ account: normNumber(s.number), name: s.customer ?? "", row: s._row })), resolveHint("job", it, "salesOrder"));
        it.held.push("sales order link ambiguous (see the ambiguity report)");
      } else if (copies.length === 0) it.flags.push(`sales order ${j.salesOrder} is not in the sales orders file: no order link`);
      else it.soNumber = normNumber(copies[0].number);
    }
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
    const sourceNumber = normNumber(s.sourceNumber);
    const feeding = written.filter((i) => i.soNumber === number);
    const it = { number, sourceNumber, renamed: number !== sourceNumber, statusRaw: s.statusRaw, status: s.status, customerRef: s.customer, quote: s.quote, orderDate: s.orderDate, date: s.orderDate ?? undefined,
      deliveryDate: s.deliveryDate, totalPence: s.total, notes: s.notes, job: s.job, feeds: feeding.map((i) => i.number), held: [], flags: [], excluded: false, oldId: oid("sales_orders", number), ...where(s) };
    soItems.push(it);
    if (it.renamed) it.flags.push(`SliQ used ${sourceNumber} for ${soBySource.get(sourceNumber).length} orders: this one is ${number} in Tolra (SliQ number kept as its source reference)`);
    if (feeding.length === 0) {
      it.notImported = ["open", "confirmed", "in_production"].includes(s.status) ? "open order with no open job in the jobs file: key it by hand (cutover plan section 3)" : `${s.statusRaw}: does not feed an open job, not imported`;
      continue;
    }
    if (isExcluded(it)) {
      it.excluded = true;
      it.held.push("excluded by number (operator decision)");
    }
    if (feeding.length > 1) it.held.push(`feeds ${feeding.length} jobs (${it.feeds.join(", ")}): Tolra links one order to one job`);
    const c = matchCustomer("sales_order", it, s.customer);
    if (c) {
      it.customerName = c.tolraName;
      it.customerOldId = customerOldId.get(c.identity);
      if (feeding.length === 1 && feeding[0].customerIdentity !== c.identity) it.flags.push(`the order's customer differs from job ${feeding[0].number}'s`);
    }
    if (s.job && feeding.length === 1 && normNumber(s.job) !== feeding[0].sourceNumber) it.flags.push(`the order says job ${s.job}, the jobs file links it to ${feeding[0].number}`);
    let q = null;
    if (s.quote) {
      const r = quoteFor("sales_order", it, s.quote);
      if (r.held && r.held.startsWith("quote link ambiguous")) it.held.push(r.held);
      else if (r.held) it.flags.push(`quote ${s.quote} is not written by this import: no quote link`);
      if (r.flag) it.flags.push(r.flag);
      q = r.quote ?? null;
    } else if (feeding.length === 1 && feeding[0].quoteNumber) q = writtenQuotesByNo.get(feeding[0].quoteNumber);
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

  // ---- job links (purchase orders and WIP): a SliQ job number, made only when it names one job ----------------------------------
  const closedNos = new Set(items.filter((i) => !i.open).map((i) => i.sourceNumber));
  const heldNos = new Set(openItems.filter((i) => i.held.length).map((i) => i.sourceNumber));
  const jobLinkProblem = (ref) => closedNos.has(ref) ? `job ${ref} is closed in SliQ (not imported)` : heldNos.has(ref) ? `job ${ref} is held in this import` : `job ${ref} is not in the jobs file or in Tolra`;
  const toTolraJob = (no) => (writtenByNo.has(no) ? { kind: "imported", jobOldId: writtenByNo.get(no).oldId, jobNo: no } : target?.jobs.has(no) ? { kind: "tolra", jobId: target.jobs.get(no), jobNo: no } : null);
  const jobLink = (kind, it, ref) => {
    const r = linkFor(kind, it, "job");
    if (r?.conflict) {
      blocked(it, kind, ref, "more than one jobLinks entry gives this record's job", [], resolveHint(kind, it, "job"));
      return { problem: "ambiguous job link (see the ambiguity report)" };
    }
    if (r) {
      if (r.value === null) return { problem: "no job link (resolutions file)" };
      const link = toTolraJob(r.value);
      if (!link) problems.push(`jobLinks: ${kind} ${it.number ?? `row ${it.row}`} names job ${r.value}, which is neither imported here nor in Tolra`);
      return link ? { link, resolved: true } : { problem: `job ${r.value} (resolutions file) is not imported here or in Tolra` };
    }
    if (!ref) return {};
    const copies = jobRowsBySource.get(ref) ?? [];
    if (copies.length > 1) {
      blocked(it, kind, ref, `SliQ used job number ${ref} for ${copies.length} jobs: the files cannot say which one this is for`,
        copies.map((c) => {
          const n = numberedJob.get(`${c._file}\u0000${c._row}`);
          return { account: n ? normNumber(n.number) : `${ref} (closed)`, name: c.customer ?? "", row: c._row };
        }), resolveHint(kind, it, "job"));
      return { problem: "ambiguous job link (see the ambiguity report)" };
    }
    const link = toTolraJob(ref);
    return link ? { link } : { problem: jobLinkProblem(ref) };
  };

  // ---- purchase orders: the job link of each one the main import writes ----------------------------------------------------------
  const poItems = plan.purchaseOrders.map((p) => {
    const ref = p.jobRef ? normNumber(p.jobRef) : null;
    const it = { number: normNumber(p.number), sourceNumber: normNumber(p.sourceRef ?? p.number), supplier: p.supplierName, status: p.status, statusRaw: p.statusRaw ?? null, open: OPEN_PO.has(p.status),
      totalPence: p.total, jobRef: ref, link: null, problem: null, oldId: p.oldId, excluded: false, ...where(p) };
    const l = jobLink("purchase_order", it, ref);
    it.link = l.link ?? null;
    it.problem = l.problem ?? null;
    return it;
  });
  const poByJob = new Map();
  for (const p of poItems) if (p.link) poByJob.set(p.link.jobNo, [...(poByJob.get(p.link.jobNo) ?? []), p.number]);
  const byStatus = {};
  for (const p of poItems) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const poRefused = (coreReport?.purchaseOrders?.notWritten ?? []).filter((p) => p.reasons.some((r) => /supplier/.test(r)));

  // ---- opening WIP -------------------------------------------------------------------------------------------------------------
  const ordinal = new Map();
  const wipRows = good(rec.wip);
  const sig = (w) => JSON.stringify([w.job, w.description, w.quantity, w.value, w.asOf, w.reference]);
  const repeats = new Map();
  for (const w of wipRows) repeats.set(sig(w), (repeats.get(sig(w)) ?? 0) + 1);
  const wipItems = wipRows.map((w) => {
    const ref = w.job ? normNumber(w.job) : null;
    const n = (ordinal.get(ref ?? "") ?? 0) + 1;
    ordinal.set(ref ?? "", n);
    const identity = `${ref ?? ""}|${n}`;
    const key = organizationId ? String(legacyId(organizationId, "opening_wip", identity)) : null;
    const it = { jobRef: ref, description: w.description, quantityMilli: w.quantity, valuePence: w.value, asOf: w.asOf, reference: w.reference, key, link: null, problem: null, flags: [], excluded: false, ...where(w) };
    if (repeats.get(sig(w)) > 1) it.flags.push(`the same line appears ${repeats.get(sig(w))} times in the WIP file: every copy is kept, as SliQ lists it`);
    const l = jobLink("wip", it, ref);
    it.link = l.link ?? null;
    if (!ref && !l.link && !l.problem) it.problem = "no job in the source: kept unlinked";
    else if (l.problem) it.problem = `${l.problem}: kept unlinked`;
    return it;
  });
  const sum = (xs) => xs.reduce((a, x) => a + (x.valuePence ?? 0), 0);
  const wipByJob = new Map();
  for (const w of wipItems) if (w.link) wipByJob.set(w.link.jobNo, [...(wipByJob.get(w.link.jobNo) ?? []), w]);
  const wip = {
    rows: wipItems.length,
    valued: wipItems.filter((w) => w.valuePence !== null).length,
    notValued: wipItems.filter((w) => w.valuePence === null).length,
    totalPence: sum(wipItems),
    linked: { rows: wipItems.filter((w) => w.link).length, totalPence: sum(wipItems.filter((w) => w.link)) },
    unlinked: { rows: wipItems.filter((w) => !w.link).length, totalPence: sum(wipItems.filter((w) => !w.link)) },
    repeatedLines: wipItems.filter((w) => w.flags.length).length,
    items: wipItems,
  };

  for (const i of written) {
    i.purchaseOrders = poByJob.get(i.number) ?? [];
    i.wipRows = (wipByJob.get(i.number) ?? []).length;
    i.wipPence = sum(wipByJob.get(i.number) ?? []);
  }
  for (const m of linkEntries) if (m.used === 0 && LINK_FIELDS[m.e?.kind]) problems.push(`jobLinks entry ${m.i + 1} (${m.e.kind} ${m.e.number ?? `row ${m.e.row}`}) fits no record in the jobs files`);
  for (const u of plan.unusedMatchEntries?.(["job", "sales_order"]) ?? []) problems.push(`customerMatches entry ${u.entry} (${u.kind} ${u.number}) fits no job or sales order in the source`);
  const blockers = [];
  if (wipItems.length && target && !target.hasOpeningWip) blockers.push("the target has no public.opening_wip table (migration 136 is not applied): opening WIP cannot be written");
  const numbering = {
    highestSourceJob: highest(jobRows, "number", prof.jobNumberPattern),
    highestSourceSalesOrder: highest(good(rec.salesOrders), "number", prof.salesOrderNumberPattern),
    jobNumberPattern: prof.jobNumberPattern.source,
    salesOrderNumberPattern: prof.salesOrderNumberPattern.source,
    jobNumbersOutsidePattern: jobRows.filter((r) => !prof.jobNumberPattern.test(normNumber(r.number))).map((r) => r.number),
  };
  const renames = [...jobCopies.log, ...soCopies.log];
  const unresolved = ambiguities.filter((a) => a.blocksWrite);

  const report = {
    format: JOBS_REPORT_FORMAT,
    customerMatching: "account, or a name exactly one customer has (as the core import); customerMatches entries of kind job or sales_order",
    inputs: jobsLoaded.inputs,
    filesNotSupplied: ["jobs", "salesOrders", "wip"].filter((k) => !jobsLoaded.present[k]),
    counts: {
      jobRows: rec.jobs.length, openInFile: openItems.length, closedInFile: items.length - openItems.length, jobsWritten: written.length, jobsHeld: openItems.length - written.length,
      jobsRenamed: openItems.filter((i) => i.renamed).length,
      salesOrderRows: rec.salesOrders.length, salesOrdersWritten: soWritten.length, salesOrdersHeld: soItems.filter((s) => !s.notImported && s.held.length).length, salesOrdersNotImported: soItems.filter((s) => s.notImported).length,
      salesOrdersRenamed: soItems.filter((s) => s.renamed).length,
      purchaseOrdersWritten: poItems.length, purchaseOrdersOpen: poItems.filter((p) => p.open).length, purchaseOrdersLinked: poItems.filter((p) => p.link).length,
      purchaseOrderLinksNotMade: poItems.filter((p) => p.problem).length, purchaseOrdersRefusedSupplier: poRefused.length,
      wipRows: wip.rows, wipLinked: wip.linked.rows, wipUnlinked: wip.unlinked.rows, wipRepeatedLines: wip.repeatedLines,
      ambiguous: unresolved.length,
    },
    jobs: items,
    salesOrders: soItems,
    purchaseOrders: { byStatus, items: poItems, refusedSupplier: poRefused.map((p) => ({ number: p.number, reasons: p.reasons })) },
    wip,
    numbering,
    renames,
    ambiguities,
    unresolvedMatchCount: unresolved.length,
    problems,
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
  const rows = jr.jobs.map((i, n) => [n + 1, i.sourceNumber, i.open && !i.held.length ? i.number : "", result(i), i.statusRaw, i.tolraStatus ?? "", i.open ? i.stage ?? "material" : "",
    i.customerRef, i.customerName ?? "", i.quote ?? "", i.salesOrder ?? "", i.description ?? "", i.dueDate ?? "", i.startedDate ?? "", i.finishedDate ?? "", plainPounds(i.valuePence),
    (i.purchaseOrders ?? []).join(" "), i.wipRows ?? "", i.wipRows ? plainPounds(i.wipPence) : "", i.flags.join("; "), "", ""]);
  const c = jr.counts;
  const foot = [[], ["Totals"], ["Open jobs in the SliQ file", c.openInFile], ["Imported as open jobs", c.jobsWritten], ["Held (not imported, see Result)", c.jobsHeld],
    ["Closed in SliQ (not imported)", c.closedInFile], ["Open jobs SliQ numbered the same as another (each kept, Tolra number -B, -C)", c.jobsRenamed], ["The open jobs on Tolra's Job Board must equal the open jobs in SliQ less the held ones"]];
  return csv([head, ...rows, ...foot]);
}

/** One row per opening WIP line, as stated in SliQ, for John to confirm each value. Totals at the foot. */
export function wipVerificationCsv(jr) {
  const head = ["Check", "SliQ job no", "Linked to", "Description", "Quantity", "Value (as stated)", "As at", "Reference", "Notes", "Value confirmed by John (Y/N)", "Checked by"];
  const w = jr.wip;
  const rows = w.items.map((x, n) => [n + 1, x.jobRef ?? "", x.link ? (x.link.kind === "imported" ? `job ${x.link.jobNo} (this import)` : `job ${x.link.jobNo} (already in Tolra)`) : "not linked",
    x.description ?? "", x.quantityMilli === null ? "" : x.quantityMilli / 1000, x.valuePence === null ? "not valued in SliQ" : plainPounds(x.valuePence), x.asOf ?? "", x.reference ?? "", [x.problem, ...x.flags].filter(Boolean).join("; "), "", ""]);
  const foot = [[], ["Totals"], ["WIP rows", w.rows], ["Stated value, all rows", plainPounds(w.totalPence)], ["Linked to jobs", plainPounds(w.linked.totalPence), `${w.linked.rows} rows`],
    ["Not linked", plainPounds(w.unlinked.totalPence), `${w.unlinked.rows} rows`], ["Rows with no value in SliQ (none worked out)", w.notValued], ["Lines SliQ lists more than once (every copy kept)", w.repeatedLines],
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
  if (jr.ambiguities.length) L.push(`**Ambiguous or unmatched in the jobs files (also in ambiguity.csv): ${jr.unresolvedMatchCount} stop the write.** Resolve each in the resolutions file (customerMatches with kind job or sales_order; jobLinks for a link SliQ's numbers cannot make) or exclude the job or order by number.`, "",
    ...table(["Kind", "Tolra number", "SliQ number", "Status", "Why", "Row", "Stops the write"], jr.ambiguities.map((x) => [x.kind, x.number, x.sourceNumber ?? "", x.status, x.reason, x.row, x.blocksWrite ? "YES" : "no (excluded)"])));
  if (jr.problems.length) L.push("**Resolutions file problems (a write is refused):**", "", ...jr.problems.map((p) => `* ${p}`), "");
  L.push(`Numbering: the SliQ job number is the Tolra job number and is kept as its source reference (migration 135); a number SliQ used for two open jobs keeps every copy (the first in the file keeps it, then -B, -C), and sales orders the same (earliest order date first). Renamed: ${c.jobsRenamed} jobs, ${c.salesOrdersRenamed} sales orders. Highest SliQ job number ${n.highestSourceJob || "none"} (pattern ${n.jobNumberPattern}); the J counter is moved to at least that, so the next new Tolra job follows it. Highest sales order ${n.highestSourceSalesOrder || "none"} (pattern ${n.salesOrderNumberPattern}).${n.jobNumbersOutsidePattern.length ? ` Job numbers outside the pattern (kept as written, not counted): ${n.jobNumbersOutsidePattern.join(", ")}.` : ""}`, "");
  L.push(`Sales orders: ${c.salesOrderRows} in the file; ${c.salesOrdersWritten} imported (each feeds one imported job, written as converted to it); ${c.salesOrdersHeld} held; ${c.salesOrdersNotImported} not imported.`, "");
  L.push(...table(["Order", "SliQ status", "Result"], jr.salesOrders.filter((s) => s.notImported || s.held.length || s.flags.length).map((s) => [s.number, s.statusRaw, s.notImported ?? (s.held.length ? `HELD: ${s.held.join("; ")}` : s.flags.join("; "))])));
  L.push(`Purchase orders written by the main import: ${c.purchaseOrdersWritten} (${Object.entries(jr.purchaseOrders.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}); open ${c.purchaseOrdersOpen}. Linked to a job: ${c.purchaseOrdersLinked}. Refused for an unknown supplier: ${c.purchaseOrdersRefusedSupplier}${jr.purchaseOrders.refusedSupplier.length ? ` (${jr.purchaseOrders.refusedSupplier.map((p) => p.number).join(", ")})` : ""}.`, "");
  L.push("Job links not made (the order is written, without the link):", "", ...table(["PO", "Job", "Why"], jr.purchaseOrders.items.filter((p) => p.problem).map((p) => [p.number, p.jobRef, p.problem])));
  const w = jr.wip;
  L.push(`**Opening WIP (reconciliation):** ${w.rows} rows, stated value ${money(w.totalPence)} = linked to jobs ${money(w.linked.totalPence)} (${w.linked.rows} rows) + not linked ${money(w.unlinked.totalPence)} (${w.unlinked.rows} rows). Rows with no value in SliQ: ${w.notValued} (left blank; nothing is worked out). Opening WIP is kept in its own table: it is not an invoice, not money owed and not revenue. John confirms each value (wip-verification.csv).`, "");
  L.push("WIP not linked to a job:", "", ...table(["Row", "Job", "Value", "Why"], w.items.filter((x) => !x.link).map((x) => [x.row, x.jobRef ?? "", money(x.valuePence) || "not valued", x.problem])));
  return L.join("\n");
}
