/**
 * SliQ import Part B (reviewer decisions 4-6, 2 Nov): open jobs, the sales orders that feed them, purchase order statuses and job
 * links, opening WIP, and the strict header check. Synthetic fixtures only (tests/fixtures/sliq/basic plus jobs files written here);
 * no database is touched (the rehearsal, scripts/sliq-import/rehearsal/run-rehearsal.sh, covers the write on a local PG16).
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dryRun } from "../../scripts/sliq-import/cli.mjs";
import { assertCoreHeaders, coreHeaderProblems } from "../../scripts/sliq-import/headers.mjs";
import { legacyId } from "../../scripts/sliq-import/ids.mjs";
import { loadJobsFolder } from "../../scripts/sliq-import/jobs-load.mjs";
import { compareHeaders, getHeaderCheck, getJobsProfile, JOBS_CANONICAL } from "../../scripts/sliq-import/jobs-mapping.mjs";
import { analyseJobs, jobsKnownNumbers, jobsVerificationCsv, mergeJobsIntoReport, renderJobsMarkdown, wipVerificationCsv } from "../../scripts/sliq-import/jobs-plan.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile, MappingError } from "../../scripts/sliq-import/mapping.mjs";
import { parseCsv } from "../../scripts/sliq-import/parse.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";

const FIXTURE = path.resolve(__dirname, "../fixtures/sliq/basic");
const ORG = "11111111-2222-4333-8444-555555555555";
const JOBS_H = "Job No,Account,Quote No,Order No,Description,Status,Stage,Due,Specification,Started,Finished,Value";
const JOBS = [
  "J-0100,C001,Q2001,SO-0010,Bracket x 4,Open,Machining,20/11/2026,\"EN8, deburr\",01/11/2026,,1200.00",
  "J-0101,C002,,SO-0011,Shaft,Late,,21/11/2026,,,,",
  "J-0102,C999,,,Unknown customer,Open,Setup,22/11/2026,,,,50.00",
  "J-0103,C002,Q9999,,Quote not in the file,Open,Setup,22/11/2026,,,,",
  "J-0104,C003,,,Finished but open,In Progress,,23/11/2026,,02/11/2026,05/11/2026,75.50",
  "J-0105,C001,Q2001,SO-0012,Same quote as J-0100,At Risk,Material,24/11/2026,,,,10.00",
  "J-0106,C001,,,Duplicate number,Open,Setup,25/11/2026,,,,",
  "J-0106,C001,,,Duplicate number (second),Open,Setup,25/11/2026,,,,",
  "J-0190,C001,,,Closed long ago,Complete,,,,01/01/2026,02/01/2026,",
];
const SO_H = "Order No,Account,Quote No,Status,Order Date,Delivery Date,Total,Notes,Job No";
const SOS = [
  "SO-0010,C001,Q2001,Open,01/11/2026,30/11/2026,1440.00,,J-0100",
  "SO-0011,C002,,Confirmed,02/11/2026,30/11/2026,99.00,,J-0101",
  "SO-0012,C001,Q2001,Open,03/11/2026,30/11/2026,12.00,,J-0105",
  "SO-0013,C003,,Open,04/11/2026,,10.00,,",
  "SO-0020,C003,,Closed,04/10/2026,,10.00,,",
];
const WIP_H = "Job No,Description,Qty,Value,As At,Reference";
const WIP = [
  "J-0100,Material issued,2.5,125.40,30/10/2026,W1",
  "J-0100,Labour to date,,,30/10/2026,",
  "J-0102,On a held job,,10.00,30/10/2026,",
  "J-0190,On a closed job,,5.00,30/10/2026,",
  "J-0050,On a job not in the file,,20.00,30/10/2026,",
  ",No job,,,30/10/2026,",
];

type Edit = { jobs?: string; salesOrders?: string; wip?: string; po?: (t: string) => string; customers?: (t: string) => string };
function folder(edit: Edit = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sliq-jobs-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const po = readFileSync(path.join(dir, "purchase-orders.csv"), "utf8").split(/\r?\n/).filter(Boolean)
    .map((l, i) => `${l},${i === 0 ? "Job No" : i === 1 ? "J-0100" : i === 3 ? "J-0190" : ""}`).join("\r\n");
  writeFileSync(path.join(dir, "purchase-orders.csv"), `${edit.po ? edit.po(po) : po}\r\n`);
  if (edit.customers) writeFileSync(path.join(dir, "customers.csv"), edit.customers(readFileSync(path.join(dir, "customers.csv"), "utf8")));
  writeFileSync(path.join(dir, "jobs.csv"), edit.jobs ?? `${[JOBS_H, ...JOBS].join("\r\n")}\r\n`);
  writeFileSync(path.join(dir, "sales-orders.csv"), edit.salesOrders ?? `${[SO_H, ...SOS].join("\r\n")}\r\n`);
  writeFileSync(path.join(dir, "wip.csv"), edit.wip ?? `${[WIP_H, ...WIP].join("\r\n")}\r\n`);
  return dir;
}
const synthetic = getProfile("synthetic");
function run(dir: string, target: unknown = null, { excludeNumbers = [] as string[], resolutions = null as object | null } = {}) {
  const loaded = loadFolder(dir, synthetic);
  const jobsLoaded = loadJobsFolder(dir, "synthetic", loaded);
  const res = resolutions ? { file: "r.json", sha256: "0".repeat(64), entries: [], customerMatches: [], customerNames: [], jobLinks: [], ...resolutions } : null;
  const { report, plan: corePlan } = analyse(loaded, { organizationId: ORG, target: null, excludeNumbers, resolutions: res, otherNumbers: jobsKnownNumbers(jobsLoaded) });
  const jobs = analyseJobs(loaded, jobsLoaded, { plan: corePlan, coreReport: report, organizationId: ORG, target, excludeNumbers, resolutions: res });
  return { loaded, jobsLoaded, report, corePlan, plan: jobs.plan, jr: jobs.report };
}
type JobItem = { number: string; held: string[]; [k: string]: unknown };
const job = (jr: { jobs: JobItem[] }, n: string) => jr.jobs.filter((j) => j.number === n);

describe("jobs mapping", () => {
  it("refuses status, stage and order words that are not Tolra's, and a number pattern without one capture group", () => {
    expect(() => getJobsProfile({ jobsImport: { jobStatusWords: { Open: { open: true, status: "busy" } } } })).toThrow(MappingError);
    expect(() => getJobsProfile({ jobsImport: { jobStageWords: { Paint: "painting" } } })).toThrow(/jobStageWords "Paint"/);
    expect(() => getJobsProfile({ jobsImport: { salesOrderStatusWords: { Open: "pending" } } })).toThrow(/salesOrderStatusWords/);
    expect(() => getJobsProfile({ jobsImport: { jobNumberPattern: "^J-\\d+$" } })).toThrow(/one capture group/);
    expect(() => getJobsProfile({ jobsImport: { files: { jobs: { columns: { foreman: "Foreman" } } } } })).toThrow(/"foreman" is not a field of jobs/);
    expect(getJobsProfile({})).toBeNull();
  });
  it("compares a header row: missing mapped columns, unknown columns, a column twice; ignoreColumns accepted", () => {
    const cols = { number: "Job No", customer: "Account", status: "Status", dueDate: "Due" };
    const r = compareHeaders(cols, JOBS_CANONICAL.jobs, ["Job No", "account", "Status", "Foreman", "Notes", "Job No"]);
    expect(r.missing).toEqual([{ field: "dueDate", columns: ["Due"] }]);
    expect(r.unknown).toEqual(["Foreman", "Notes"]);
    expect(r.twice).toEqual(["job no"]);
    const ok = compareHeaders(cols, JOBS_CANONICAL.jobs, ["Job No", "Account", "Status", "Due", "Notes"], getHeaderCheck({ ignoreColumns: { jobs: ["notes"] } }).ignore.jobs);
    expect(ok).toEqual({ missing: [], unknown: [], twice: [] });
  });
  it("the real SliQ mapping holds every file to its header row; the synthetic one does not", () => {
    const raw = (n: string) => JSON.parse(readFileSync(path.resolve(__dirname, `../../scripts/sliq-import/mappings/${n}.json`), "utf8"));
    expect(getHeaderCheck(raw("sliq")).strict).toBe(true);
    expect(getHeaderCheck(raw("synthetic")).strict).toBe(false);
    expect(getJobsProfile(raw("sliq"))).not.toBeNull();
  });
});

describe("loading the jobs files", () => {
  it("adds their checksums to the inputs (a changed jobs file makes the approved report stale) and their encoding", () => {
    const a = run(folder());
    expect(a.loaded.inputs.map((i: { kind: string }) => i.kind)).toEqual(expect.arrayContaining(["jobs", "salesOrders", "wip"]));
    expect(a.loaded.formats.encoding.perFile.map((e: { file: string }) => e.file)).toEqual(expect.arrayContaining(["jobs.csv", "wip.csv"]));
    const b = run(folder({ jobs: `${[JOBS_H, ...JOBS.slice(0, -1), JOBS.at(-1)!.replace("Complete", "Invoiced")].join("\r\n")}\r\n` }));
    const key = (x: { kind: string; sha256: string }) => `${x.kind}|${x.sha256}`;
    expect(a.loaded.inputs.filter((i: { kind: string }) => i.kind === "jobs").map(key)).not.toEqual(b.loaded.inputs.filter((i: { kind: string }) => i.kind === "jobs").map(key));
  });
  it("refuses an unknown or a missing column in a jobs file, with the list, before anything is read", () => {
    expect(() => run(folder({ jobs: `${JOBS_H},Foreman\r\n${JOBS[0]},Bob\r\n` }))).toThrow(/jobs\.csv: unknown column "Foreman"/);
    expect(() => run(folder({ wip: "Job No,Description,Qty,As At,Reference\r\nJ-0100,x,,30/10/2026,\r\n" }))).toThrow(/wip\.csv: missing column "Value" \(for "value"\)/);
  });
  it("an unlisted status or stage word is a row error (the write is refused), never guessed", () => {
    const r = run(folder({ jobs: `${JOBS_H}\r\nJ-0100,C001,,,x,Paused,,,,,,\r\nJ-0101,C001,,,x,Open,Paint,,,,,\r\n` }));
    expect(r.loaded.errors.map((e: { message: string }) => e.message)).toEqual([expect.stringMatching(/Job status "Paused"/), expect.stringMatching(/Job stage "Paint"/)]);
    expect(r.report.writable).toBe(false);
  });
  it("without a jobsImport section in the mapping the jobs files are not read at all", () => {
    const dir = folder();
    const raw = JSON.parse(readFileSync(path.resolve(__dirname, "../../scripts/sliq-import/mappings/synthetic.json"), "utf8"));
    delete raw.jobsImport;
    const mp = path.join(dir, "no-jobs.json");
    writeFileSync(mp, JSON.stringify(raw));
    const loaded = loadFolder(dir, getProfile(mp));
    const jl = loadJobsFolder(dir, mp, loaded);
    expect(jl.profile).toBeNull();
    expect(loaded.inputs.map((i: { kind: string }) => i.kind)).not.toContain("jobs");
  });
});

describe("what the jobs import would do", () => {
  const { jr, plan } = run(folder());
  it("imports only open jobs; a closed SliQ job is listed, never imported", () => {
    expect(jr.counts).toMatchObject({ jobRows: 9, openInFile: 8, closedInFile: 1 });
    expect(job(jr, "J-0190")[0]).toMatchObject({ open: false, statusRaw: "Complete" });
    expect(plan.jobs.map((j: { number: string }) => j.number)).toEqual(["J-0100", "J-0101", "J-0104", "J-0105", "J-0106", "J-0106-B"]);
  });
  it("holds an unknown customer (stops the write: ambiguity.csv) and a quote this import does not write; a duplicate number keeps both", () => {
    expect(job(jr, "J-0102")[0].held).toEqual(["customer unmatched: no record has this account or name (see the ambiguity report)"]);
    expect(jr.ambiguities.map((a: { kind: string; number: string; status: string; blocksWrite: boolean }) => [a.kind, a.number, a.status, a.blocksWrite])).toEqual([["job", "J-0102", "unmatched", true]]);
    expect(jr.unresolvedMatchCount).toBe(1);
    expect(job(jr, "J-0103")[0].held[0]).toMatch(/quote Q9999 is not written by this import/);
    // Decision 2 for jobs: the first copy in the file keeps the number, the next is -B; both keep J-0106 as their SliQ reference.
    expect(jr.jobs.filter((j: { sourceNumber: string }) => j.sourceNumber === "J-0106").map((j: JobItem) => [j.number, j.sourceNumber, j.held, j.oldId]))
      .toEqual([["J-0106", "J-0106", [], legacyId(ORG, "jobs", "J-0106")], ["J-0106-B", "J-0106", [], legacyId(ORG, "jobs", "J-0106-B")]]);
    expect(jr.renames.map((x: { kind: string; sourceNumber: string; number: string; keeps: boolean }) => [x.kind, x.sourceNumber, x.number, x.keeps])).toEqual([["job", "J-0106", "J-0106", true], ["job", "J-0106", "J-0106-B", false]]);
    expect(jr.customerMatching).toMatch(/^account, or a name exactly one customer has/);
  });
  it("keeps the SliQ job number, the customer's name, the quote link, the status and stage words, dates and value as stated", () => {
    const j = plan.jobs.find((x: { number: string }) => x.number === "J-0100");
    expect(j).toMatchObject({ number: "J-0100", customerName: "Alpha Fabrications Ltd", tolraStatus: "on_track", stage: "machining", dueDate: "2026-11-20", startedDate: "2026-11-01", specification: "EN8, deburr", valuePence: 120000 });
    expect(j.quoteOldId).toBe(legacyId(ORG, "quotes", "Q2001"));
    expect(j.oldId).toBe(legacyId(ORG, "jobs", "J-0100"));
    const late = plan.jobs.find((x: { number: string }) => x.number === "J-0101");
    expect(late).toMatchObject({ tolraStatus: "overdue", stage: null, valuePence: null });
    expect(late.flags).toContain("no quote in the source: imported without a quote link");
    expect(plan.jobs.find((x: { number: string }) => x.number === "J-0104")).toMatchObject({ stage: "inspection", finishedDate: "2026-11-05" });
  });
  it("imports a sales order only where it feeds an imported job; one order per quote (the second loses the quote link, listed)", () => {
    expect(plan.salesOrders.map((s: { number: string; feeds: string[] }) => `${s.number}>${s.feeds}`)).toEqual(["SO-0010>J-0100", "SO-0011>J-0101", "SO-0012>J-0105"]);
    expect(plan.salesOrders.find((s: { number: string }) => s.number === "SO-0012")).toMatchObject({ quoteOldId: null, flags: [expect.stringMatching(/already has a sales order/)] });
    const not = jr.salesOrders.filter((s: { notImported?: string }) => s.notImported).map((s: { number: string; notImported: string }) => [s.number, s.notImported]);
    expect(not).toEqual([["SO-0013", expect.stringMatching(/key it by hand/)], ["SO-0020", expect.stringMatching(/not imported/)]]);
    expect(plan.jobs.find((x: { number: string }) => x.number === "J-0100").soOldId).toBe(legacyId(ORG, "sales_orders", "SO-0010"));
    // The order's customer is linked by the id the core import gives that customer.
    expect(plan.salesOrders.find((s: { number: string }) => s.number === "SO-0010").customerOldId).toBe(legacyId(ORG, "customers", "key:c001"));
  });
  it("purchase orders: the supplier is checked by the main import (unknown refused), the job link here (closed job: no link, listed)", () => {
    expect(jr.purchaseOrders.refusedSupplier.map((p: { number: string }) => p.number)).toEqual(["PO-0002"]);
    const items = jr.purchaseOrders.items.map((p: { number: string; jobRef: string | null; link: unknown; problem: string | null }) => [p.number, p.jobRef, !!p.link, p.problem]);
    expect(items).toContainEqual(["PO-0001", "J-0100", true, null]);
    expect(items.find((i: unknown[]) => i[1] === "J-0190")).toBeUndefined(); // PO-0003 has no status: held by the main import
    expect(jr.counts.purchaseOrdersOpen).toBe(1);
  });
  it("opening WIP: only stated values, linked where the job is imported, the rest unlinked with the reason; totals reconcile", () => {
    expect(jr.wip).toMatchObject({ rows: 6, valued: 4, notValued: 2, totalPence: 16040, linked: { rows: 2, totalPence: 12540 }, unlinked: { rows: 4, totalPence: 3500 } });
    expect(jr.wip.items.map((w: { problem: string | null }) => w.problem)).toEqual([null, null, "job J-0102 is held in this import: kept unlinked",
      "job J-0190 is closed in SliQ (not imported): kept unlinked", "job J-0050 is not in the jobs file or in Tolra: kept unlinked", "no job in the source: kept unlinked"]);
    expect(jr.wip.items[1].valuePence).toBeNull();
    expect(new Set(jr.wip.items.map((w: { key: string }) => w.key)).size).toBe(6);
  });
  it("numbering: the highest SliQ job number counts closed jobs too", () => {
    expect(jr.numbering).toMatchObject({ highestSourceJob: 190, highestSourceSalesOrder: 20, jobNumbersOutsidePattern: [] });
  });
  it("a number Tolra already uses is held; one an earlier run of this import made is not; a missing WIP table refuses the write", () => {
    const id = legacyId(ORG, "jobs", "J-0100");
    const t = (mapped: Map<string, string>, hasOpeningWip = true) => ({ jobs: new Map([["J-0100", "uuid-1"], ["J-7000", "uuid-7"]]), salesOrders: new Map(), mappedJobs: mapped, mappedSalesOrders: new Map(), salesOrderQuotes: new Map(), hasOpeningWip, counters: {} });
    expect(job(run(folder(), t(new Map())).jr, "J-0100")[0].held).toEqual([expect.stringMatching(/already used by a Tolra job/)]);
    expect(job(run(folder(), t(new Map([[String(id), "uuid-1"]]))).jr, "J-0100")[0].held).toEqual([]);
    expect(run(folder(), t(new Map(), false)).jr.blockers).toEqual([expect.stringMatching(/migration 136 is not applied/)]);
    // A WIP line on a job already in Tolra (an earlier import) is linked to it.
    const r = run(folder({ wip: `${WIP_H}\r\nJ-7000,Old job,,1.00,30/10/2026,\r\n` }), t(new Map()));
    expect(r.jr.wip.items[0].link).toEqual({ kind: "tolra", jobId: "uuid-7", jobNo: "J-7000" });
  });
  it("customers file without account codes: matched by a name exactly one customer has; a match only after normalising stops the write", () => {
    const noKeys = (t: string) => t.replace(/^Account,/m, "Code,").replace(/\nC00(\d),/g, "\nX$1,") + "C009,Alpha Fabrications Limited,,,,,,,,\r\n";
    const dir = folder({ customers: noKeys, jobs: `${JOBS_H}\r\nJ-0300,Beta Engineering Ltd,,,x,Open,,,,,,\r\nJ-0301,Alpha Fabrications Ltd,,,x,Open,,,,,,\r\n` });
    const raw = JSON.parse(readFileSync(path.resolve(__dirname, "../../scripts/sliq-import/mappings/synthetic.json"), "utf8"));
    delete raw.files.customers.columns.key;
    const mp = path.join(dir, "no-keys.json");
    writeFileSync(mp, JSON.stringify(raw));
    const prof = getProfile(mp);
    const loaded = loadFolder(dir, prof);
    const jl = loadJobsFolder(dir, mp, loaded);
    const { report, plan } = analyse(loaded, { organizationId: ORG });
    const jr = analyseJobs(loaded, jl, { plan, coreReport: report, organizationId: ORG }).report;
    expect(job(jr, "J-0301")[0].held).toEqual([]);
    expect(job(jr, "J-0300")[0].held).toEqual([expect.stringMatching(/customer ambiguous: matches only after normalising/)]);
    expect(jr.ambiguities.filter((a: { blocksWrite: boolean }) => a.blocksWrite).map((a: { number: string }) => a.number)).toEqual(["J-0300"]);
  });
});

describe("duplicates and ambiguity across jobs, sales orders, purchase orders and WIP (core decisions 2 and 3)", () => {
  type Amb = { kind: string; number: string; sourceNumber: string | null; status: string; blocksWrite: boolean; row: number; resolveWith?: string };
  const blocking = (jr: { ambiguities: Amb[] }) => jr.ambiguities.filter((a) => a.blocksWrite).map((a) => `${a.kind} ${a.number}`);
  // J-0106 is used twice: a WIP line and a purchase order on J-0106 cannot say which job they are for.
  const dupLinks = () => folder({ wip: `${WIP_H}\r\nJ-0106,Material for J-0106,,7.00,30/10/2026,\r\nJ-0100,Material,,1.00,30/10/2026,\r\n`, po: (t) => t.replace("PO-0001,Steel Supplies Ltd,01/03/2026,15/03/2026,250.00,Open,J-0100", "PO-0001,Steel Supplies Ltd,01/03/2026,15/03/2026,250.00,Open,J-0106") });
  it("a WIP line or purchase order on a job number SliQ used twice is ambiguous and stops the write; never linked to a guess", () => {
    const { jr } = run(dupLinks());
    expect(blocking(jr)).toEqual(["job J-0102", "purchase_order PO-0001", "wip row 2"]);
    const wipAmb = jr.ambiguities.find((a: Amb) => a.kind === "wip");
    expect(wipAmb).toMatchObject({ sourceNumber: null, status: "ambiguous", reason: expect.stringMatching(/SliQ used job number J-0106 for 2 jobs/) });
    expect(wipAmb.candidates.map((c: { account: string }) => c.account)).toEqual(["J-0106", "J-0106-B"]);
    expect(wipAmb.resolveWith).toBe('jobLinks: {"kind":"wip","row":2,"job":"<Tolra number, or null>"}');
    expect(jr.wip.items[0]).toMatchObject({ link: null, problem: "ambiguous job link (see the ambiguity report): kept unlinked" });
    expect(jr.purchaseOrders.items.find((p: { number: string }) => p.number === "PO-0001")).toMatchObject({ link: null, problem: expect.stringMatching(/ambiguous/) });
  });
  it("the resolutions file names the Tolra job (jobLinks) and the customer of a job (customerMatches kind job): 0 left, links as named", () => {
    const resolutions = { jobLinks: [{ kind: "wip", row: 2, job: "J-0106-B" }, { kind: "purchase_order", number: "PO-0001", job: "J-0106" }], customerMatches: [{ kind: "job", number: "J-0102", account: "C003" }] };
    const { jr, plan } = run(dupLinks(), null, { resolutions });
    expect(blocking(jr)).toEqual([]);
    expect(jr.problems).toEqual([]);
    expect(jr.wip.items[0].link).toEqual({ kind: "imported", jobOldId: legacyId(ORG, "jobs", "J-0106-B"), jobNo: "J-0106-B" });
    expect(plan.purchaseOrders.find((p: { number: string }) => p.number === "PO-0001").link).toMatchObject({ kind: "imported", jobNo: "J-0106" });
    expect(plan.jobs.find((j: { number: string }) => j.number === "J-0102")).toMatchObject({ customerName: "Gamma Supplies" });
    // An entry that fits nothing, or names a job that is not imported, refuses the write (writable false once merged).
    const bad = run(dupLinks(), null, { resolutions: { jobLinks: [...resolutions.jobLinks, { kind: "wip", row: 99, job: "J-0100" }, { kind: "purchase_order", number: "PO-0003", job: "J-0101" }] } });
    expect(bad.jr.problems).toEqual(["jobLinks entry 3 (wip row 99) fits no record in the jobs files", "jobLinks entry 4 (purchase_order PO-0003) fits no record in the jobs files"]);
    expect(mergeJobsIntoReport(bad.report, bad.jr).writable).toBe(false);
  });
  it("an excluded job is held and its ambiguity no longer stops the write; --exclude may name a job number", () => {
    const { jr, report } = run(folder(), null, { excludeNumbers: ["J-0102"] });
    expect(report.unknownExcludedNumbers).toEqual([]);
    expect(job(jr, "J-0102")[0].held).toContain("excluded by number (operator decision)");
    expect(jr.ambiguities.map((a: Amb) => [a.number, a.blocksWrite])).toEqual([["J-0102", false]]);
    expect(jr.unresolvedMatchCount).toBe(0);
  });
  it("a sales order number SliQ used twice keeps both (earliest order date keeps it); the job naming it is ambiguous until resolved", () => {
    const sos = `${[SO_H, ...SOS, "SO-0011,C002,,Open,05/11/2026,30/11/2026,5.00,,"].join("\r\n")}\r\n`;
    const { jr } = run(folder({ salesOrders: sos }));
    expect(jr.salesOrders.filter((x: { sourceNumber: string }) => x.sourceNumber === "SO-0011").map((x: { number: string }) => x.number)).toEqual(["SO-0011", "SO-0011-B"]);
    expect(blocking(jr)).toEqual(["job J-0101", "job J-0102"]);
    expect(job(jr, "J-0101")[0].held).toEqual(["sales order link ambiguous (see the ambiguity report)"]);
    const ok = run(folder({ salesOrders: sos }), null, { resolutions: { jobLinks: [{ kind: "job", number: "J-0101", salesOrder: "SO-0011-B" }] }, excludeNumbers: ["J-0102"] });
    expect(ok.jr.unresolvedMatchCount).toBe(0);
    expect(ok.plan.salesOrders.map((x: { number: string; feeds: string[] }) => `${x.number}>${x.feeds}`)).toContain("SO-0011-B>J-0101");
  });
  it("a quote number SliQ used twice cannot be linked from a job: ambiguous until jobLinks names the Tolra quote", () => {
    const dir = folder({ jobs: `${JOBS_H}\r\nJ-0400,C001,Q2001,,x,Open,,,,,,\r\n`, salesOrders: `${SO_H}\r\n`, wip: `${WIP_H}\r\n` });
    const qf = path.join(dir, "quotes.csv");
    writeFileSync(qf, `${readFileSync(qf, "utf8").trimEnd()}\r\nQ2001,02/02/2026,C001,10.00,2.00,12.00,Sent,01/05/2026,\r\n`);
    const { jr } = run(dir);
    expect(blocking(jr)).toEqual(["job J-0400"]);
    expect(jr.ambiguities[0].reason).toMatch(/SliQ used quote number Q2001 for 2 quotes/);
    const ok = run(dir, null, { resolutions: { jobLinks: [{ kind: "job", number: "J-0400", quote: "Q2001-B" }] } });
    expect(ok.jr.unresolvedMatchCount).toBe(0);
    expect(ok.plan.jobs[0]).toMatchObject({ quoteNumber: "Q2001-B", quoteOldId: legacyId(ORG, "quotes", "Q2001-B") });
  });
  it("a WIP line SliQ lists twice is kept twice (its own key each), flagged on the sheet", () => {
    const { jr } = run(folder({ wip: `${WIP_H}\r\nJ-0100,Material,,1.00,30/10/2026,\r\nJ-0100,Material,,1.00,30/10/2026,\r\n` }));
    expect(jr.wip.items.map((w: { key: string }) => w.key)).toEqual([String(legacyId(ORG, "opening_wip", "J-0100|1")), String(legacyId(ORG, "opening_wip", "J-0100|2"))]);
    expect(jr.wip.repeatedLines).toBe(2);
    expect(wipVerificationCsv(jr)).toContain("the same line appears 2 times in the WIP file: every copy is kept");
  });
});

describe("verification sheets and report", () => {
  const { jr } = run(folder());
  it("the jobs sheet: one rectangular row per SliQ job, the result of each, and the open-job totals", () => {
    const { headers, rows } = parseCsv(jobsVerificationCsv(jr));
    expect(headers.slice(0, 4)).toEqual(["Check", "SliQ job no", "Tolra job no", "Result"]);
    const body = rows.filter((r: string[]) => /^\d+$/.test(r[0]));
    expect(body.map((r: string[]) => [r[1], r[2], r[3].split(":")[0]])).toEqual([["J-0100", "J-0100", "imported"], ["J-0101", "J-0101", "imported"], ["J-0102", "", "HELD"],
      ["J-0103", "", "HELD"], ["J-0104", "J-0104", "imported"], ["J-0105", "J-0105", "imported"], ["J-0106", "J-0106", "imported"], ["J-0106", "J-0106-B", "imported"], ["J-0190", "", "not imported"]]);
    expect(rows.find((r: string[]) => r[0] === "Open jobs in the SliQ file")?.[1]).toBe("8");
    expect(rows.find((r: string[]) => r[0] === "Imported as open jobs")?.[1]).toBe("6");
  });
  it("the WIP sheet: every line as stated (blank: not valued), with the reconciliation totals", () => {
    const { rows } = parseCsv(wipVerificationCsv(jr));
    expect(rows.filter((r: string[]) => /^\d+$/.test(r[0])).map((r: string[]) => r[5])).toEqual(["125.40", "not valued in SliQ", "10.00", "5.00", "20.00", "not valued in SliQ"]);
    expect(rows.find((r: string[]) => r[0] === "Stated value, all rows")?.[1]).toBe("160.40");
  });
  it("the report section says WIP is not revenue and gives the reconciliation", () => {
    const md = renderJobsMarkdown(jr);
    expect(md).toContain("**Open jobs in the SliQ file: 8.** Imported 6; held 2.");
    expect(md).toContain("stated value £160.40 = linked to jobs £125.40 (2 rows) + not linked £35.00 (4 rows)");
    expect(md).toContain("not an invoice, not money owed and not revenue");
  });
  it("a dry run writes report.jobsImport and both sheets", async () => {
    const dir = folder();
    const out = mkdtempSync(path.join(tmpdir(), "sliq-jobs-out-"));
    const { report } = await dryRun({ folder: dir, outDir: out, mapping: "synthetic" });
    expect(report.jobsImport.counts.jobsWritten).toBe(6);
    // The jobs files' ambiguity joins the core report's: ambiguity.csv and the stop count.
    expect(report.customerMatching.ambiguities.some((a: { kind: string; number: string }) => a.kind === "job" && a.number === "J-0102")).toBe(true);
    expect(readFileSync(path.join(out, "ambiguity.csv"), "utf8")).toMatch(/\r\njob,J-0102,J-0102,jobs\.csv,4,C999,unmatched,/);
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain("## 15. Jobs, sales orders");
    expect(readFileSync(path.join(out, "jobs-verification.csv"), "utf8")).toContain("J-0190");
    expect(readFileSync(path.join(out, "wip-verification.csv"), "utf8")).toContain("Value confirmed by John");
  });
});

describe("strict header check on the main files", () => {
  it("lists an unknown column and a missing optional mapped one, and refuses only when the mapping says strict", () => {
    const dir = folder({ customers: (t) => t.replace(/^(Account,.*)$/m, "$1,Credit Limit").replace(/\r?\n(C00\d,[^\r\n]*)/g, "\n$1,") });
    const loaded = loadFolder(dir, synthetic);
    const strict = getHeaderCheck({ headerCheck: "strict" });
    const problems = coreHeaderProblems(loaded, strict);
    expect(problems.find((p: { kind: string }) => p.kind === "customers")).toMatchObject({ unknown: ["Credit Limit"], missing: [] });
    expect(() => assertCoreHeaders(loaded, strict)).toThrow(/customers\.csv: unknown column "Credit Limit"/);
    expect(assertCoreHeaders(loaded, getHeaderCheck({}))).toEqual([]);
    expect(() => assertCoreHeaders(loaded, getHeaderCheck({ headerCheck: "strict", ignoreColumns: { customers: ["credit limit"] } }))).not.toThrow();
    // a mapped optional column that is absent (the basic fixture's invoice-lines have no "VAT Code" etc.) is listed as missing
    const none = loadFolder(FIXTURE, synthetic);
    const missing = coreHeaderProblems(none, strict).flatMap((p: { missing: { field: string }[] }) => p.missing.map((m) => m.field));
    expect(missing).toContain("jobRef");
  });
});
