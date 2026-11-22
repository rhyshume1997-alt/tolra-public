/**
 * Reads what the operations reports need. SELECTs only, under the signed-in person's own session (RLS applies, so another company's rows
 * never come back). Inputs: a read client, the number of London months (default 12), `now`, and the person's hidden sections.
 * Output: one result per card: ok (data, and `truncated` when a cap was hit: "may be incomplete"), error, or hidden (a section the card's
 * data needs is hidden for this person: the card shows a notice, never a 0). Never throws and never writes.
 *
 * Reads: jobs finished in the range (on-time, and the first 500 newest for machine hours), open jobs (WIP ageing), delivery notes of the
 * finished jobs (last despatch, information only), and via lib/jobs the plan / runs / labour of those jobs and the NCR records of the range.
 * The frozen loadNcrRegister also reads rework material cost (admin and office only); the Reports module never shows, exports or keeps any cost.
 * Must not change: it must stay read-only; the 500-job cap for machine hours.
 */
import { fetchAll } from "@/lib/fetch-all";
import { londonMonthsEnding, windowOf, type Period } from "@/lib/numbers";
import { loadPlannedVsActualBatch } from "@/lib/jobs/load-planned-vs-actual";
import { loadNcrRegister } from "@/lib/jobs/load-ncr-register";
import { buildNcrRows, ncrByMonth } from "@/lib/jobs/ncr-register";
import { sumStepsByMachine } from "@/lib/jobs/planned-vs-actual";
import { lastDespatchByJob, type DespatchRow } from "@/lib/reports/last-despatch";
import { jobsPerMachine, machineHoursVariance, type MachineVarianceReport } from "@/lib/reports/machine-hours-variance";
import { ncrTrend, type NcrTrendReport } from "@/lib/reports/ncr-trend";
import { onTimeCompletion, type OnTimeJob, type OnTimeReport } from "@/lib/reports/on-time-completion";
import { wipAgeing, type WipJob, type WipReport } from "@/lib/reports/wip-ageing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadClient = { from: (table: string) => any };

export const REPORT_DEFAULT_MONTHS = 12;
/** Most jobs the machine-hours card looks at (the newest finished in the range). */
export const MACHINE_HOURS_JOB_CAP = 500;
/** Most job rows read for one list; more are cut and the card says it may be incomplete. */
export const REPORT_JOB_ROW_CAP = 5_000;
const CHUNK = 100;

/** The sections (lib/sections.ts keys) each card's data needs; a hidden one turns that card into a notice. */
export const REPORT_SECTION_NEEDS = {
  onTime: ["jobs"],
  wip: ["jobs"],
  machines: ["jobs", "schedule"],
  ncr: ["jobs"],
  despatch: ["delivery-notes"],
} as const;

export type ReportCard<T> = { state: "ok"; data: T; truncated: boolean; note?: string } | { state: "error" } | { state: "hidden"; sections: string[] };
export type ReportsData = {
  periods: Period[];
  calculatedAt: string;
  onTime: ReportCard<OnTimeReport>;
  wip: ReportCard<WipReport>;
  machines: ReportCard<MachineVarianceReport>;
  ncr: ReportCard<NcrTrendReport>;
};

const JOB_COLUMNS = "id, job_no, customer, is_internal, started_at, finished_at, date_required, due_date";

export async function loadReports(client: ReadClient, options: { months?: number; now?: Date; hiddenSections?: readonly string[] } = {}): Promise<ReportsData> {
  const now = options.now ?? new Date();
  const periods = londonMonthsEnding(now, options.months ?? REPORT_DEFAULT_MONTHS);
  const window = windowOf(periods);
  const hidden = options.hiddenSections ?? [];
  const blocked = (needs: readonly string[]) => needs.filter((s) => hidden.includes(s));
  const hiddenCard = (needs: readonly string[]): ReportCard<never> | null => (blocked(needs).length ? { state: "hidden", sections: blocked(needs) } : null);

  const onTimeHidden = hiddenCard(REPORT_SECTION_NEEDS.onTime);
  const machinesHidden = hiddenCard(REPORT_SECTION_NEEDS.machines);
  const despatchHidden = blocked(REPORT_SECTION_NEEDS.despatch).length > 0;

  // Finished jobs of the range, newest first: shared by the on-time and machine-hours cards (one read, not two).
  let finished: Promise<{ rows: (OnTimeJob & WipJob)[]; truncated: boolean }> | null = null;
  const finishedJobs = () => (finished ??= fetchAll<OnTimeJob & WipJob>((from, to) =>
    client.from("jobs").select(JOB_COLUMNS).gte("finished_at", window.startAt).lt("finished_at", window.endAt).order("finished_at", { ascending: false }).order("id").range(from, to) as never,
  { maxRows: REPORT_JOB_ROW_CAP }));

  const onTime = async (): Promise<ReportCard<OnTimeReport>> => {
    if (onTimeHidden) return onTimeHidden;
    try {
      const jobs = await finishedJobs();
      let truncated = jobs.truncated;
      let despatches = new Map<string, string>();
      let note: string | undefined;
      if (despatchHidden) note = "Last despatch is not shown: Delivery Notes are hidden for you.";
      else {
        try {
          const ids = jobs.rows.filter((j) => !j.is_internal).map((j) => j.id);
          const rows: DespatchRow[] = [];
          for (let i = 0; i < ids.length; i += CHUNK) {
            const got = await fetchAll<DespatchRow & { id: string }>((from, to) => client.from("delivery_notes").select("id, job_id, despatched_at").in("job_id", ids.slice(i, i + CHUNK)).not("despatched_at", "is", null).order("id").range(from, to) as never);
            if (got.truncated) truncated = true;
            rows.push(...got.rows);
          }
          despatches = lastDespatchByJob(rows);
        } catch {
          note = "Last despatch could not be read, so it is left blank.";
        }
      }
      return { state: "ok", data: onTimeCompletion(jobs.rows, periods, despatches), truncated, note };
    } catch {
      return { state: "error" };
    }
  };

  const wip = async (): Promise<ReportCard<WipReport>> => {
    const gate = hiddenCard(REPORT_SECTION_NEEDS.wip);
    if (gate) return gate;
    try {
      const open = await fetchAll<WipJob>((from, to) => client.from("jobs").select(JOB_COLUMNS).is("finished_at", null).order("id").range(from, to) as never, { maxRows: REPORT_JOB_ROW_CAP });
      return { state: "ok", data: wipAgeing(open.rows, now), truncated: open.truncated };
    } catch {
      return { state: "error" };
    }
  };

  const machines = async (): Promise<ReportCard<MachineVarianceReport>> => {
    if (machinesHidden) return machinesHidden;
    try {
      const jobs = await finishedJobs();
      // Internal jobs are left out before the cap, like the other cards.
      const ids = jobs.rows.filter((j) => !j.is_internal).map((j) => j.id);
      const batch = await loadPlannedVsActualBatch(client, ids.slice(0, MACHINE_HOURS_JOB_CAP), now);
      // 3b's batch has no cap of its own: this loader caps the job list, and any job flagged truncated by 3b (its whole chunk) also means "may be incomplete".
      const truncated = jobs.truncated || ids.length > MACHINE_HOURS_JOB_CAP || [...batch.values()].some((r) => r.truncated);
      return { state: "ok", data: machineHoursVariance(sumStepsByMachine(batch.values()), jobsPerMachine(batch.values())), truncated };
    } catch {
      return { state: "error" };
    }
  };

  const ncr = async (): Promise<ReportCard<NcrTrendReport>> => {
    const gate = hiddenCard(REPORT_SECTION_NEEDS.ncr);
    if (gate) return gate;
    try {
      const got = await loadNcrRegister({ from: window.start, to: window.end }, client);
      if (!got.ok) return { state: "error" };
      return { state: "ok", data: ncrTrend(ncrByMonth(buildNcrRows(got.sources, now), periods), periods), truncated: got.truncated };
    } catch {
      return { state: "error" };
    }
  };

  const [a, b, c, d] = await Promise.all([onTime(), wip(), machines(), ncr()]);
  return { periods, calculatedAt: now.toISOString(), onTime: a, wip: b, machines: c, ncr: d };
}
