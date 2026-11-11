/**
 * The self-check gap list: one row per ISO 9001:2015 clause with Met / Minor / Major / Not evidenced by Tolra. Inputs: counts read from
 * the company's own records (GapEvidence; null means "could not be read"). Output: the rows, and a CSV column spec.
 * Must not change: the default is "Not evidenced by Tolra"; nothing is "Met" without a supporting database row; clauses Tolra keeps no
 * records for are always "Not evidenced by Tolra"; NO input here may come from the NCR review reminder (that is an internal reminder
 * and never moves a clause: tests/unit/iso-ncr-reminder.test.ts). This is a self-check aid, not an audit result.
 *
 * Pure (no React, no browser, no I/O).
 */
import type { SheetColumn } from "@/lib/spreadsheet";

export const GAP_STATUSES = ["Met", "Minor", "Major", "Not evidenced by Tolra"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];
export const NOT_EVIDENCED: GapStatus = "Not evidenced by Tolra";

/** Jobs that carry a flag (drawing revision required, or traceable): how many, how many have been inspected, and how many of those are missing the data. */
export type FlaggedJobs = { flagged: number; finished: number; finishedMissing: number; truncated: boolean };

export type GapEvidence = {
  /** 7.2: people on the authorised inspectors list, and how many of them have a recorded reason for being on it. */
  inspectors: { current: number; withReason: number } | null;
  /** 7.5.3: whether the change history (audit log) has any row. */
  changeHistoryPresent: boolean | null;
  /** 8.2 / 8.5.1: jobs that require a drawing revision. finishedMissing = inspected (Complete) with no revision. */
  drawingRevision: FlaggedJobs | null;
  /** 8.4: suppliers by status. */
  suppliers: { total: number; approved: number; conditional: number; blocked: number; truncated: boolean } | null;
  /** 8.5.2: traceable jobs. finishedMissing = inspected with no material cert no. or no heat/cast no. */
  traceability: FlaggedJobs | null;
};

export type GapRow = { clause: string; requirement: string; status: GapStatus; basis: string };

/** 8.7 and 10.2: Tolra holds NCR records, but the review and corrective action are the company's to evidence, so these never move (not even with overdue NCRs). */
const NCR_NOTE = "Tolra holds NCR records (see the NCR register); the company must evidence its review and corrective action.";

/** Clauses Tolra keeps no records for: always "Not evidenced by Tolra". */
const NO_RECORDS: [string, string, string][] = [
  ["4.1", "Understanding the organisation and its context", "Tolra keeps no record of this."],
  ["4.2", "Needs and expectations of interested parties", "Tolra keeps no record of this."],
  ["4.3", "Scope of the quality management system", "Tolra keeps no record of this."],
  ["5.2", "Quality policy", "Tolra keeps no record of this."],
  ["6.1", "Actions to address risks and opportunities", "Tolra keeps no record of this."],
  ["6.2", "Quality objectives and planning to achieve them", "Tolra keeps no record of this."],
  ["7.1.5", "Monitoring and measuring resources (calibration)", "Tolra keeps no calibration records."],
  ["7.3", "Awareness", "Tolra keeps no record of this."],
  ["9.1.2", "Customer satisfaction", "Tolra keeps no record of this."],
  ["9.2", "Internal audit", "Tolra keeps no audit records."],
  ["8.7", "Control of nonconforming outputs", NCR_NOTE],
  ["9.3", "Management review", "Tolra keeps no management review records."],
  ["10.1", "Improvement (general)", "Tolra keeps no record of this."],
  ["10.2", "Nonconformity and corrective action", NCR_NOTE],
];

const none = (basis: string) => ({ status: NOT_EVIDENCED, basis });
const unread = "The records could not be read, so nothing is shown.";

/**
 * 7.2: authorised inspectors (migration 083). None on the list, or not readable: Not evidenced. Everyone on the list has a recorded
 * reason: Met. Anyone without a recorded reason: Minor. (The reason is the company's own words; Tolra does not check training.)
 */
export function rule72(e: GapEvidence["inspectors"]): { status: GapStatus; basis: string } {
  if (!e) return none(unread);
  if (e.current <= 0) return none("No authorised inspectors are on the list.");
  if (e.withReason >= e.current) return { status: "Met", basis: `${e.current} authorised inspector${e.current === 1 ? "" : "s"}, each with a recorded reason. Tolra does not check the training behind it.` };
  return { status: "Minor", basis: `${e.current} authorised inspector${e.current === 1 ? "" : "s"}; ${e.current - e.withReason} without a recorded reason.` };
}

/**
 * 7.5.3: the change history. Never Met: how long records are kept and how they are protected are the company's decisions, which Tolra
 * cannot see. History present: Minor. Absent or not readable: Not evidenced.
 */
export function rule753(present: boolean | null): { status: GapStatus; basis: string } {
  if (present === null) return none(unread);
  if (!present) return none("The change history has no entries.");
  return { status: "Minor", basis: "Tolra keeps a change history. Retention and protection rules are the company's own and are not recorded in Tolra." };
}

/**
 * 8.2 and 8.5.1: the drawing revision on jobs that require one (migration 083). None require it, or not readable: Not evidenced.
 * An inspected (Complete) job that requires a revision has none: Major. At least one inspected job and none missing, and every row
 * was read: Met. Otherwise Minor (jobs require it but none has finished yet, or the read was cut short).
 */
export function ruleDrawingRevision(e: GapEvidence["drawingRevision"]): { status: GapStatus; basis: string } {
  if (!e) return none(unread);
  if (e.flagged <= 0) return none("No job is set to require a drawing revision.");
  if (e.finishedMissing > 0) return { status: "Major", basis: `${e.finishedMissing} Complete job${e.finishedMissing === 1 ? "" : "s"} require a drawing revision and have none recorded.` };
  if (e.finished > 0 && !e.truncated) return { status: "Met", basis: `${e.finished} Complete job${e.finished === 1 ? "" : "s"} requiring a drawing revision, all with one recorded.` };
  return { status: "Minor", basis: e.truncated ? "Some jobs were not read: too many to check at once." : `${e.flagged} job${e.flagged === 1 ? "" : "s"} require a drawing revision; none is Complete yet.` };
}

/**
 * 8.4: supplier status (migration 082). Why: suppliers.supplier_status defaults to Approved on creation (082), so "all Approved" shows
 * no decision was made (Minor), while any Conditional or Blocked supplier shows an admin deliberately used the control (Met). No suppliers, or not readable: Not evidenced. A status is a flag, and every existing supplier
 * starts Approved, so "all Approved" is not evidence of a decision: Minor. At least one Conditional or Blocked supplier (an admin has
 * used the control) and every row read: Met. A cut-short read is never Met.
 */
export function rule84(e: GapEvidence["suppliers"]): { status: GapStatus; basis: string } {
  if (!e) return none(unread);
  if (e.total <= 0) return none("No suppliers are listed.");
  const text = `${e.total} supplier${e.total === 1 ? "" : "s"}: ${e.approved} Approved, ${e.conditional} Conditional, ${e.blocked} Blocked.`;
  if ((e.conditional > 0 || e.blocked > 0) && !e.truncated) return { status: "Met", basis: `${text} An admin has set a status other than the starting one. Tolra holds no evaluation records.` };
  return { status: "Minor", basis: `${text} ${e.truncated ? "Some suppliers were not read. " : "Every supplier still has the starting status. "}Tolra holds no evaluation records.` };
}

/**
 * 8.5.2: traceability (migration 082). No job is marked traceable, or not readable: Not evidenced. An inspected traceable job lacks its
 * material cert no. or heat/cast no.: Major. At least one inspected traceable job and none missing, and every row read: Met.
 * Otherwise Minor (traceable jobs exist, none inspected yet, or the read was cut short).
 */
export function rule852(e: GapEvidence["traceability"]): { status: GapStatus; basis: string } {
  if (!e) return none(unread);
  if (e.flagged <= 0) return none("No job is marked traceable.");
  if (e.finishedMissing > 0) return { status: "Major", basis: `${e.finishedMissing} inspected traceable job${e.finishedMissing === 1 ? "" : "s"} lack a material cert no. or heat/cast no.` };
  if (e.finished > 0 && !e.truncated) return { status: "Met", basis: `${e.finished} inspected traceable job${e.finished === 1 ? "" : "s"}, each with a material cert no. and heat/cast no.` };
  return { status: "Minor", basis: e.truncated ? "Some jobs were not read: too many to check at once." : `${e.flagged} job${e.flagged === 1 ? " is" : "s are"} marked traceable; none has been inspected yet.` };
}

/** The whole list, in clause order. The only input is the company's own records. */
export function buildGapChecklist(e: GapEvidence): GapRow[] {
  const row = (clause: string, requirement: string, r: { status: GapStatus; basis: string }): GapRow => ({ clause, requirement, ...r });
  const rows: GapRow[] = [
    ...NO_RECORDS.map(([clause, requirement, basis]) => row(clause, requirement, none(basis))),
    row("7.2", "Competence (authorised inspectors)", rule72(e.inspectors)),
    row("7.5.3", "Control of documented information", rule753(e.changeHistoryPresent)),
    row("8.2", "Requirements for products and services (drawing revision)", ruleDrawingRevision(e.drawingRevision)),
    row("8.4", "Control of externally provided processes, products and services", rule84(e.suppliers)),
    row("8.5.1", "Control of production (drawing revision)", ruleDrawingRevision(e.drawingRevision)),
    row("8.5.2", "Identification and traceability", rule852(e.traceability)),
  ];
  const order = (c: string) => c.split(".").map((n) => n.padStart(3, "0")).join(".");
  return rows.sort((a, b) => (order(a.clause) < order(b.clause) ? -1 : order(a.clause) > order(b.clause) ? 1 : 0));
}

/** Every clause "Not evidenced by Tolra": used when nothing could be read. */
export const EMPTY_EVIDENCE: GapEvidence = { inspectors: null, changeHistoryPresent: null, drawingRevision: null, suppliers: null, traceability: null };

export const GAP_CSV_COLUMNS: SheetColumn<GapRow>[] = [
  { header: "Clause", type: "text", value: (r) => r.clause },
  { header: "Requirement", type: "text", value: (r) => r.requirement },
  { header: "Status", type: "text", value: (r) => r.status },
  { header: "Basis", type: "text", value: (r) => r.basis },
];
