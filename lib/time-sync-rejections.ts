/**
 * Refused late time actions, made visible to the office (migration 075, G18).
 *
 * A clock or job Start/Stop queued on a phone is refused when it syncs if its time falls in a week that was approved before it arrived
 * (week_approved) or is more than 14 days old (time_too_old). Until 075 that refusal stayed on the phone. Now the device reports it
 * (report_time_sync_rejection: the caller's own action, keyed by the action's client_op_id, so a repeat is answered, never doubled), and
 * the weekly review tells the office "N time actions from <person>'s device were refused ... add them as a correction", with the details.
 * The office marks each one resolved (resolve_time_sync_rejection, audited).
 *
 * BEFORE 075 IS APPLIED (the app deploys first): the report fails with "function not found" and is dropped silently (the refusal still
 * shows on the device, as before); held refusals are offered again once per page load, so they reach the office after the SQL is applied.
 * The week review shows the notice only once the database has 075 (useDatabaseHas075).
 */
import type { ClockOp, HeldEntry, LabourOp, OutboxOp, ReplayOutcome } from "@/lib/offline/outbox";
import { fmtDateTimeText } from "@/lib/dates";

/** The refusals reported to the office: the two a phone syncing late can meet. */
export const REPORTED_CODES = ["week_approved", "time_too_old"] as const;
export type ReportedCode = (typeof REPORTED_CODES)[number];
export const isReportedCode = (code: unknown): code is ReportedCode => typeof code === "string" && (REPORTED_CODES as readonly string[]).includes(code);

export const CODE_TEXT: Record<ReportedCode, string> = { week_approved: "week approved", time_too_old: "over 14 days" };
export const ACTION_TEXT: Record<string, string> = { in: "Clock in", out: "Clock out", break_start: "Break start", break_end: "Break end", start: "Job start", stop: "Job stop" };

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/** The report's arguments for a refused clock or labour action, or null when it is not one the office is told about. */
export function rejectionReportArgs(op: OutboxOp, code: unknown, reason: string | null | undefined): Record<string, unknown> | null {
  if (!isReportedCode(code) || (op.kind !== "clock" && op.kind !== "labour")) return null;
  const time = op as ClockOp | LabourOp;
  return {
    p_client_op_id: time.clientOpId,
    p_kind: time.kind,
    p_action: time.action,
    p_at: time.at,
    p_code: code,
    p_reason: reason ? reason.slice(0, 500) : null,
    p_job: time.kind === "labour" ? time.jobNo.slice(0, 80) : null,
    p_device: time.kind === "clock" && time.device ? time.device.slice(0, 80) : null,
  };
}

/** Keys reported (or tried) during this page load: each refusal is sent at most once per load. */
const sentThisLoad = new Set<string>();

/**
 * Tells the office about one refused action. Best effort: never throws, never changes the outcome; a server without 075, no
 * connection, or any refusal of the report itself is ignored (the device still shows the refusal).
 */
export async function reportTimeSyncRejection(client: Rpc | null | undefined, op: OutboxOp, outcome: ReplayOutcome | { status: string; code?: string; reason?: string }): Promise<boolean> {
  if (!client || outcome.status !== "rejected") return false;
  const args = rejectionReportArgs(op, (outcome as { code?: string }).code, (outcome as { reason?: string }).reason);
  if (!args) return false;
  const key = String(args.p_client_op_id);
  if (sentThisLoad.has(key)) return false;
  sentThisLoad.add(key);
  try {
    // Never holds up the sync: a report that hasn't answered within REPORT_TIMEOUT_MS is given up (it may still land; the server
    // answers a repeat of the key). Any refusal (no 075 yet, too_many_rejections, not_refused, ...) is ignored.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      Promise.resolve(client.rpc("report_time_sync_rejection", args)).then(({ error }) => !error, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), REPORT_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    return answer;
  } catch {
    return false;
  }
}

/** How long a sync waits for a report's answer before carrying on. */
export const REPORT_TIMEOUT_MS = 5_000;

/** Offers the device's held refusals once per page load (so a refusal held before 075 was applied reaches the office later). */
export async function reportHeldTimeRejections(client: Rpc | null | undefined, held: HeldEntry[]): Promise<number> {
  let sent = 0;
  for (const entry of held) {
    if (await reportTimeSyncRejection(client, entry.op, { status: "rejected", code: entry.code, reason: entry.reason })) sent += 1;
  }
  return sent;
}

/** For tests: forget what this load has sent. */
export function resetReportedThisLoad() {
  sentThisLoad.clear();
}

// ----- the office's view ---------------------------------------------------------------------------------------------------------------
export type TimeSyncRejection = {
  id: string;
  user_id: string;
  client_op_id: string;
  op_kind: "clock" | "labour";
  action: string;
  intended_at: string;
  code: ReportedCode;
  device_reason: string | null;
  job_label: string | null;
  device_label: string | null;
  reported_at: string;
  resolved_at: string | null;
};
export type RejectionNotice = { userId: string; rows: TimeSyncRejection[]; text: string };

/**
 * One notice per person (unresolved rows only, oldest first), e.g. "3 time actions from Lee's device were refused (week approved,
 * over 14 days): add them as a correction".
 */
export function rejectionNotices(rows: TimeSyncRejection[], nameOf: (userId: string) => string): RejectionNotice[] {
  const byUser = new Map<string, TimeSyncRejection[]>();
  for (const row of rows) {
    if (row.resolved_at) continue;
    byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
  }
  return [...byUser.entries()]
    .map(([userId, list]) => {
      const sorted = list.slice().sort((a, b) => a.intended_at.localeCompare(b.intended_at));
      const codes = REPORTED_CODES.filter((c) => sorted.some((r) => r.code === c)).map((c) => CODE_TEXT[c]).join(", ");
      const n = sorted.length;
      const text = `${n} time action${n === 1 ? "" : "s"} from ${nameOf(userId)}'s device ${n === 1 ? "was" : "were"} refused (${codes}): add ${n === 1 ? "it" : "them"} as a correction`;
      return { userId, rows: sorted, text };
    })
    .sort((a, b) => a.text.localeCompare(b.text));
}

/** One refused action, for the details list: "Clock in, Tue 13 Oct 08:02 (week approved), J-1042, Phone". */
export function rejectionLine(row: TimeSyncRejection): string {
  const when = fmtDateTimeText(row.intended_at, { weekday: "short" });
  return [`${ACTION_TEXT[row.action] ?? row.action}, ${when} (${CODE_TEXT[row.code] ?? row.code})`, row.job_label, row.device_label].filter(Boolean).join(", ");
}

/** The London date of the intended time (the day sheet to add the correction on). */
export const rejectionDay = (row: Pick<TimeSyncRejection, "intended_at">) =>
  new Date(row.intended_at).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

type Reader = { from: (table: string) => { select: (columns: string) => { is: (column: string, value: null) => { order: (column: string, opts: { ascending: boolean }) => PromiseLike<{ data: unknown; error: unknown }> } } } };

/** The company's unresolved refused actions (admin and office see the company's; row rules decide). Throws on a read error. */
export async function loadOpenRejections(client: Reader): Promise<TimeSyncRejection[]> {
  const { data, error } = await client.from("time_sync_rejections")
    .select("id, user_id, client_op_id, op_kind, action, intended_at, code, device_reason, job_label, device_label, reported_at, resolved_at")
    .is("resolved_at", null)
    .order("intended_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TimeSyncRejection[];
}

/** Marks one resolved (office or admin; audited). Throws the server's refusal. */
export async function resolveRejection(client: Rpc, id: string, note: string | null) {
  const { error } = await client.rpc("resolve_time_sync_rejection", { p_id: id, p_note: note });
  if (error) throw error;
}
