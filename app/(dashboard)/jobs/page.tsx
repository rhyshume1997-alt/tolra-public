"use client";

import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status-badge";
import { COLOUR_CLASSES } from "@/lib/status-colours";
import { ActivityPanel } from "@/components/activity-panel";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, CheckCheck, ChevronRight, ClipboardList, Cog, FastForward, Loader2, Mail, PauseCircle, Play, Plus, Printer, RotateCcw, ShieldCheck, Truck, Unlock, Wrench } from "lucide-react";

import { BOARD_KPI_LABEL, BOARD_TABLE_HEADINGS, BoardFilterRow, BoardHeading } from "@/components/board-heading";
import { ColumnToggle } from "@/components/column-toggle";
import { FilterBar } from "@/components/filter-bar";
import { ListToolbar } from "@/components/list-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import { useIsPhone, useViewMode } from "@/lib/view-mode";
import { ArchiveButton } from "@/components/phase-filter";
import { phaseOf as archivePhase, useArchive } from "@/lib/archive";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SelectBox } from "@/components/ui/select-box";
import { cn } from "@/lib/utils";
import { linkedJobId } from "@/lib/job-link";
import { type BulkKind, DEFAULT_START_STAGE, bulkDisabledReason, keepVisibleSelected, type JobRunState, type MachinePick, type StartStage, canPauseRole, defaultPick, stageAfterStart, finishCheck, finishPatch, groupByPatch, isInRework, missedReason, pendingRunView, planBulk, playState, runViewLabel, stagesBeforeStart, summariseJobNumbers } from "@/lib/job-actions";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { InspectionDialog } from "@/components/inspection-dialog";
import { ReworkDialog } from "@/components/rework-dialog";
import { ReleaseEarlyDialog } from "@/components/release-early-dialog";
import { JobWorksheetForm } from "@/components/job-worksheet-form";
import { JobDrawingRevision } from "@/components/job-drawing-revision";
import { NewJobDialog } from "@/components/new-job-dialog";
import { JobMachinesDialog } from "@/components/job-machines-dialog";
import { type JobMachineChip, chipBookingSuffix, loadBoardJobMachines } from "@/lib/job-machine-plan";
import { MachinePicker, type PickerMachine } from "@/components/machine-picker";
import { PausedMachineDialog } from "@/components/paused-machine-dialog";
import { type BenchRow, type InUseRow, type JobRunFacts, type PausedRow, type RunStartAnswer, SERVER_UPGRADE_REASON, benchAfter, benchRows, benchState, groupJobsByMachine, inUseRows, indexInUse, isServerTooOld, isStale, missingRunsReason, newClientOpId, pausedAckPayload, pausedFor, pausedRows, releaseFacts, requestedRunsPresent, runFactsByJob, runRefusal, withReleaseReasons } from "@/lib/machine-runs";
import { conflictEntries, pendingEntries, rejectedEntries, setReplayMachineNames, type OutboxEntry, type RunPauseOp, type RunStartOp } from "@/lib/offline/outbox";
import { offlineScope } from "@/lib/offline/scope";
import { onSyncComplete, runStartArgs } from "@/lib/offline/sync";
import { type PeopleMap, personName } from "@/lib/people";
import { canReadUsernames, loadCompanyPeople } from "@/lib/company-people";
import { formatHours } from "@/lib/so-machines";
import { JobPhotos } from "@/components/job-photos";
import { auditEvent } from "@/lib/audit";
import { cleanName, UNKNOWN } from "@/lib/people";
import { DespatchFromOrder } from "@/components/despatch-from-order";
import { canOfferJobDeliveryNote } from "@/lib/job-delivery-note";
import { jobsEmptyHint } from "@/lib/empty-hints";
import { NAME_NOT_SET } from "@/lib/display-name";
import { loadOfflineSnapshot, queueOffline, reportOffline, saveOfflineSnapshot } from "@/lib/offline/scope";
import { isNetworkError, stripJobMoney } from "@/lib/offline/store";
import { ListFilterNotice, useListFilter } from "@/components/list-filter-notice";
import { unbilledJobsOf } from "@/lib/attention-load";
import { jobMatchesFilter } from "@/lib/list-filter";
import { fmtDate, fmtDateTime, nowIso, toDateInput } from "@/lib/dates";
import { DUE_CHIPS, formatAverageJobTime, hasRequiredDate, jobMatchesStatus, jobStatus, requiredDate } from "@/lib/job-status";
import { DEMO_MODE } from "@/lib/demo";
import { EXPORT_TITLES, exportRows, exportSpreadsheet } from "@/lib/export-records";
import { warmPdfExport } from "@/lib/pdf-warm";
import { JOB_COLUMNS } from "@/lib/import-columns";
import { exportScopeRows, exportScopeTitle } from "@/lib/spreadsheet";
import { friendlyError } from "@/lib/friendly-error";
import { type InspectionRecord, type RecordedInspection, inspectedActionOffered, inspectionSummary, latestByJob, loadCanInspect, loadInspections } from "@/lib/inspection";
import { JOB_STAGES, JOB_STATUS_LABELS, type JobStatusKey, STAGE_LABELS, confirmedFinishers, earlyReleaseOffered, finishesLeftQueue, flowBadge, jobStatusOf, reopenCheck, reworkTag, stageLabel, stageOf } from "@/lib/job-flow";
import { ReopenJobDialog } from "@/components/reopen-job-dialog";
import { REWORK_STATUS_LABELS, type ReworkRecord, loadReworks, quantityText } from "@/lib/rework";
import { ValidationError } from "@/lib/validation/schemas";
import { supabase } from "@/lib/supabase";
import { useSaving } from "@/lib/use-saving";
import { useNow } from "@/lib/use-now";
import { type RunBooking, loadRunBookings } from "@/lib/run-bookings";
import { type RunPlan, loadRunPlan, planBooking, runPlanKey } from "@/lib/run-plan";
import { runClock, runTimerText } from "@/lib/machine-schedule";
import { useUser } from "@/lib/use-user";
import { canOpenDestination } from "@/lib/destinations";
import { useOrgSettings } from "@/lib/org-settings";
import type { JobRecord } from "@/types";
import { fetchAll, truncationNotice } from "@/lib/fetch-all";
import { type BoardFiles, boardDescription, shownJobColumns, jobBoardFiles, loadBoardJobFiles } from "@/lib/job-board-files";
import { useColumnVisibility } from "@/lib/org-settings";

const JOB_FILTER_LABELS: Record<string, string> = { overdue: "Jobs past their required date", "awaiting-inspection": "Jobs waiting for inspection", "complete-unbilled": "Complete jobs not yet fully despatched or invoiced" };

type WorkshopJob = JobRecord & {
  /** Who finished it (035): the person who may undo their own Finish while it awaits inspection (081). */
  finished_by?: string;
  started_at?: string;
  finished_at?: string;
  inspected_at?: string;
  inspected_by?: string;
  specification: string;
  drawings: string[];
  customer_po?: string;
  date_received?: string;
  date_required?: string;
  quote_ref?: string;
  quantity_required?: number | string;
  drawing_no?: string;
  /** Made for the company itself (migration 042): no customer needed, tagged "Internal" on the board. */
  is_internal?: boolean;
  /** The one job this job relates to (rework or tooling for job X), shown both ways on the board. */
  related_job_id?: string;
  /** The operator the job is assigned to (migration 044; informational, shown by display name). */
  assigned_to?: string;
  /** Made from a sales order (converted_from_sales_order_id): a delivery note can be made from it. */
  from_sales_order?: boolean;
};

/**
 * Every job's machines in one go (read by the whole company); null when it can't be read (the board still shows). The plan joined with
 * the job's bookings (lib/job-machine-plan): a machine booked on the schedule shows its booked hours, even when the plan row isn't linked.
 */
async function loadJobMachines(): Promise<Map<string, JobMachineChip[]> | null> {
  const map = await loadBoardJobMachines();
  // Kept on the device (migration 044), so an offline Start still asks which planned machine the job runs on.
  if (map) void saveOfflineSnapshot("job_machines", [...map]);
  return map;
}

/**
 * Each unfinished job's runs, read straight from machine_runs (plan R2.3: SELECT for the four roles, no SQL): whether it ever ran, what is
 * open, how its latest run ended and what it last ran on. One paged read joined to the job (unfinished jobs only), not one per id chunk.
 * Null when it can't be read.
 */
async function loadRunFacts(): Promise<Record<string, unknown>[] | null> {
  if (!supabase) return null;
  const client = supabase;
  try {
    const { rows } = await fetchAll((from, to) => client.from("machine_runs").select("id, job_id, machine_id, started_at, ended_at, end_reason, ended_by, jobs!inner(finished_at)")
      .is("jobs.finished_at", null).order("id").range(from, to));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let runs: Record<string, unknown>[] = rows.map(({ jobs: _job, ...run }) => run);
    // 092: why an admin released a job's machine (on the job time it ended). Not readable (before 092, other people's time): no reason.
    const released = [...new Set(runs.filter((r) => r.end_reason === "admin_released").map((r) => r.job_id as string))];
    for (let i = 0; i < released.length; i += 200) {
      const reasons = await client.from("operator_sessions").select("job_id, ended_at, end_reason").eq("end_source", "admin_released").in("job_id", released.slice(i, i + 200));
      if (!reasons.error) runs = withReleaseReasons(runs, reasons.data);
    }
    return runs;
  } catch {
    return null;
  }
}

/** File names on the board (drawings or attachments), wrapped in full; the same on the table, list and cards. */
function FileNames({ names, empty = "", testId }: { names: string[]; empty?: string; testId: string }) {
  return names.length ? <span data-testid={testId} className="block break-words">{names.join(", ")}</span> : empty ? <>{empty}</> : null;
}

/** The "Internal" tag, the same in the list, the table and the cards. */
function InternalBadge() {
  return <span data-testid="internal-badge" className="inline-flex shrink-0 items-center rounded-none bg-violet-100 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">Internal</span>;
}
type JobType = "all" | "customer" | "internal";

// Sample rows. Only ever used when DEMO_MODE is on; real tenants start empty and trust the database.
const demoJobs: WorkshopJob[] = [
  { id: "1", job_no: "JNR-J-218", customer: "Aerospace Components", description: "Titanium brackets", stage: "machining", due_date: "2026-05-14", value: 8400, status: "on_track", started_at: "2026-05-14T07:15:00Z", specification: "Ti-6Al-4V Grade 5, 50 units, milled pockets, deburr all edges, inspect first-off.", drawings: ["ACL-BRACKET-REV3.pdf", "MATERIAL-SPEC-TI-G5.pdf"] },
  { id: "2", job_no: "JNR-J-219", customer: "Industrial Systems", description: "Aluminium plates", stage: "setup", due_date: "2026-05-18", value: 15600, status: "on_track", specification: "6082 aluminium, saw cut blanks, face both sides, drill M8 pattern.", drawings: ["ISL-PLATE-2026-04.pdf"] },
  { id: "3", job_no: "JNR-J-220", customer: "Precision Engineering", description: "SS shafts", stage: "inspection", due_date: "2026-05-12", value: 6200, status: "at_risk", started_at: "2026-05-13T08:10:00Z", finished_at: "2026-05-14T10:40:00Z", specification: "316 stainless shafts, turn to tolerance, polish bearing faces.", drawings: ["PEG-SHAFT-316.pdf"] },
];

async function loadDemoJobs(): Promise<WorkshopJob[]> {
  if (!DEMO_MODE) return [];
  const { JNR_TEST_JOBS } = await import("@/lib/jnr-test-data");
  return [
    ...JNR_TEST_JOBS.map((job): WorkshopJob => ({ id: job.id, job_no: job.jobNo, customer: job.customer, description: job.description, stage: job.stage, due_date: job.dueDate, value: job.value, status: job.status, specification: job.specification, drawings: [], customer_po: job.customerPo, date_received: job.dateReceived, date_required: job.dateRequired, quote_ref: job.quoteRef, quantity_required: job.quantityRequired, drawing_no: job.drawingNo })),
    ...demoJobs,
  ];
}

type JobState = { started_at?: string; finished_at?: string; inspected_at?: string; due_date?: string; status: string; stage?: string };
/** A failed inspection holds the job in the rework stage (migration 037) until the rework is finished and it is inspected again. */
const inRework = (job: JobState) => isInRework(job);
/**
 * The due-date light (On time, At risk, Overdue, No due date): for Not started and Running jobs only, the jobs the due-date chips
 * count. A job waiting for inspection or Complete shows its status alone. Always shown with its word, never colour alone.
 */
type DueLight = (typeof DUE_CHIPS)[number]["value"];
const DUE_LABEL = Object.fromEntries(DUE_CHIPS.map((chip) => [chip.value, chip.label])) as Record<DueLight, string>;

/**
 * The selection bar on a phone (below sm): the shared toolbar (components/list-toolbar) laid out in three columns, its buttons'
 * words wrapping inside them (each at least 48px tall, taller if its words need three lines; the workshop's Finish Selected keeps
 * its 64px on a touch screen), and the reason Finish Selected is off on a row of its own.
 */
const SELECTION_BAR_PHONE = [
  "max-sm:[&_[role=toolbar]]:grid max-sm:[&_[role=toolbar]]:grid-cols-3 max-sm:[&_[role=toolbar]]:items-center",
  "max-sm:[&_[role=toolbar]>button]:h-auto max-sm:[&_[role=toolbar]>button]:px-2 max-sm:[&_[role=toolbar]>button]:py-1 max-sm:[&_[role=toolbar]>button]:text-center max-sm:[&_[role=toolbar]>button]:leading-tight max-sm:[&_[role=toolbar]>button]:whitespace-normal",
  "max-sm:[&_[data-testid=finish-blocked]]:col-span-full",
].join(" ");
const inDueScope = (job: JobState) => { const status = jobStatusOf(job); return status === "not_started" || status === "running"; };
function dueLightOf(job: JobState): DueLight | null {
  if (!inDueScope(job)) return null;
  if (!hasRequiredDate(job)) return "no_due_date";
  return job.status === "overdue" || job.status === "at_risk" ? job.status : "on_track";
}
/** Where a job sits on the Show tabs: Open (Not started, Running, Waiting for inspection) or Complete (archived is worked out below). */
const phaseOf = (job: JobState) => (jobStatusOf(job) === "complete" ? "done" : "active");
/**
 * A job's status (Not started, Running, Waiting for inspection, Complete), its Rework tag and its due-date light: the same badges, words
 * and colours on the cards, the table and the list. `progress` (cards and table) is the plain run text after them while it adds something.
 */
function JobStatusBadges({ job, progress, failedUndecided = false, compact = false, paused = false, wrap: wrapBadges = false }: { job: JobState; progress?: string; failedUndecided?: boolean; compact?: boolean; paused?: boolean; wrap?: boolean }) {
  const status = flowBadge(job, { paused });
  const tag = reworkTag(job, failedUndecided);
  const due = dueLightOf(job);
  // compact (List) and wrap (Table): a long badge ("Waiting for inspection") wraps inside a narrow cell instead of spilling out of it.
  const wrap = compact || wrapBadges ? "h-auto whitespace-normal text-left" : undefined;
  const showProgress = progress && inDueScope(job) && progress !== status.label;
  return (
    <span data-testid="job-status" className={cn("inline-flex min-w-0 flex-wrap items-center gap-1 text-xs font-semibold", compact ? "flex-col items-start gap-0.5" : "")}>
      <StatusBadge status={status.status} label={status.label} className={wrap} />
      {tag ? <StatusBadge data-testid="rework-tag" status={tag.status} label={tag.label} className={wrap} /> : null}
      {due ? <StatusBadge data-testid="due-light" status={due} label={DUE_LABEL[due]} className={wrap} /> : null}
      {showProgress ? <span data-testid="job-progress-text" className="min-w-0 max-w-full basis-full whitespace-normal font-normal text-slate-600 [overflow-wrap:anywhere] dark:text-slate-300">{`\u00b7 ${progress}`}</span> : null}
    </span>
  );
}
type Show = "active" | "done" | "archived" | "all";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Dates come from the database as ISO text; show them in UK format. */
const showDate = (value?: string) => (value ? fmtDate(value) : "");

const AVG_DAY_MS = 86_400_000;

function averageJobDays(jobs: WorkshopJob[]) {
  const durations = jobs
    .map((job) => (job.started_at && job.finished_at ? new Date(job.finished_at).getTime() - new Date(job.started_at).getTime() : NaN))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (!durations.length) return null;
  return durations.reduce((sum, ms) => sum + ms, 0) / durations.length / AVG_DAY_MS;
}

function rowToJob(row: Record<string, any>): WorkshopJob { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: row.id,
    job_no: row.job_no || row.reference || `JOB-${String(row.id).slice(0, 8)}`,
    customer: row.customer || row.customer_name || row.customer_id || (row.is_internal ? "Internal" : "Customer not linked"),
    description: row.description || "",
    stage: row.stage || "material",
    due_date: requiredDate(row),
    // The due-date state (lib/job-status): overdue is derived from the required date for unfinished jobs (finished_at null, as the
    // dashboard's Late and /jobs?filter=overdue count it); manual "at risk" is kept. Rework itself is a tag (the stage), not a status.
    status: jobStatus(row, toDateInput(new Date())),
    started_at: row.started_at || "",
    finished_at: row.finished_at || "",
    inspected_at: row.inspected_at || "",
    inspected_by: row.inspected_by || "",
    finished_by: row.finished_by || undefined,
    specification: row.specification || "No specification recorded.",
    drawings: Array.isArray(row.drawings) ? row.drawings : [],
    customer_po: row.customer_po || undefined,
    date_received: row.date_received || undefined,
    date_required: row.date_required || undefined,
    quote_ref: row.quote_ref || undefined,
    quantity_required: row.quantity_required ?? undefined,
    drawing_no: row.drawing_no || undefined,
    is_internal: Boolean(row.is_internal),
    related_job_id: row.related_job_id || undefined,
    assigned_to: row.assigned_to || undefined,
    from_sales_order: Boolean(row.converted_from_sales_order_id),
  };
}

export default function JobsPage() {
  const { activeRole, profile, hiddenSections } = useUser();
  const orgSettings = useOrgSettings();
  const [jobs, setJobs] = useState<WorkshopJob[]>(DEMO_MODE ? demoJobs : []);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [statusFilters, setStatusFilters] = useState(new Set(["all"]));
  const [stageFilters, setStageFilters] = useState(new Set<string>());
  // /jobs?filter=overdue|awaiting-inspection (the dashboard's "View all"): only those jobs, whatever Show says.
  const [listFilter, clearListFilter] = useListFilter("jobs");
  // Open jobs by default (Not started, Running, Waiting for inspection); a Complete job moves to "Complete" (one click away).
  const [show, setShow] = useState<Show>("active");
  // A headline status tile (Not started, Running, Waiting for inspection, Complete) narrows the board to that status; null: every status.
  const [statusTile, setStatusTile] = useState<JobStatusKey | null>(null);
  // The Rework tag chip: only jobs carrying the Rework tag.
  const [reworkOnly, setReworkOnly] = useState(false);
  // Customer or internal jobs (migration 042).
  const [jobType, setJobType] = useState<JobType>("all");
  const [newJobOpen, setNewJobOpen] = useState(false);
  // The machines each job runs on (job_machines, migrations 042/043): shown on every view, edited in a dialog.
  const [machinesByJob, setMachinesByJob] = useState<Map<string, JobMachineChip[]>>(new Map());
  const [machineJob, setMachineJob] = useState<WorkshopJob | null>(null);
  // Each job's drawings and attachments (job_files): shown on every view; the board works without them when they can't be read.
  const [filesByJob, setFilesByJob] = useState<Map<string, BoardFiles> | null>(null);
  // Live machine use and assignment (migration 044): who is on what now, the company's people by display name, the machines to start on.
  const [inUse, setInUse] = useState<InUseRow[]>([]);
  // Bench jobs (migration 046): each unfinished job's latest bench run (a run with no machine), for Pause and "Paused".
  const [bench, setBench] = useState<BenchRow[]>([]);
  const [people, setPeople] = useState<PeopleMap>({});
  const [assignable, setAssignable] = useState<{ user_id: string; display_name: string }[]>([]);
  const [machinesList, setMachinesList] = useState<{ id: string; name: string }[]>([]);
  /** The machines read failed (the picker then says so rather than "No machines set up yet"). */
  const [machinesLoadError, setMachinesLoadError] = useState(false);
  /** The machines read has finished once (a list, an offline copy, or a failure): until then an empty picker says "Loading machines…". */
  const [machinesLoaded, setMachinesLoaded] = useState(false);
  // Job Board Play/Pause (migration 049, plan R2.2, R2.3, R3.4): each job's run facts, the machines paused on another job, this device's
  // pending Starts and Pauses (folded into the board's state, so it survives a reload), the Machine column's picks, the Start in flight.
  const [runFacts, setRunFacts] = useState<Map<string, JobRunFacts> | null>(null);
  const [paused, setPaused] = useState<PausedRow[]>([]);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const [picks, setPicks] = useState<Map<string, MachinePick>>(new Map());
  const [startingId, setStartingId] = useState<string | null>(null);
  // The stage Play moves a job to (Machining by default; Setup when chosen in the picker).
  const [stages, setStages] = useState<Map<string, StartStage>>(new Map());
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ job: WorkshopJob; pick: MachinePick; rows: PausedRow[]; takeover: string[] } | null>(null);
  const isPhone = useIsPhone();
  const jobsRef = useRef(jobs);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  const [groupBy, setGroupBy] = useState<"none" | "machine">("none");
  const live = useMemo(() => indexInUse(inUse), [inUse]);
  // The live run timer: one clock for the whole board (a minute), and the hours of the bookings the running jobs work against. Each
  // reload of the open runs (every minute) re-reads them, so an estimate changed on the schedule shows; a failed read keeps what was shown.
  const now = useNow();
  // The hours are kept with the open runs they were read for: when the runs change (a Resume is a new run on the same booking) the old
  // hours are not used until the new read arrives, so "left" never overstates; the board shows the elapsed time alone in between.
  const runSig = useMemo(() => inUse.map((row) => row.run_id).sort().join(","), [inUse]);
  const [runBookingsRead, setRunBookingsRead] = useState<{ sig: string; map: Map<string, RunBooking> }>({ sig: "", map: new Map() });
  const runBookings = runBookingsRead.sig === runSig ? runBookingsRead.map : null;
  useEffect(() => {
    let active = true;
    void loadRunBookings(inUse.map((row) => row.booking_id).filter((id): id is string => Boolean(id))).then((map) => { if (active && map) setRunBookingsRead({ sig: runSig, map }); }, () => undefined);
    return () => { active = false; };
  }, [inUse, runSig]);
  // A run with no booking takes its hours from the job's plan row for that machine (lib/run-plan), read the same way and kept with the same runs.
  const [runPlanRead, setRunPlanRead] = useState<{ sig: string; map: Map<string, RunPlan> }>({ sig: "", map: new Map() });
  const runPlan = runPlanRead.sig === runSig ? runPlanRead.map : null;
  useEffect(() => {
    let active = true;
    void loadRunPlan(inUse.filter((row) => !row.booking_id).map((row) => row.job_id)).then((map) => { if (active && map) setRunPlanRead({ sig: runSig, map }); }, () => undefined);
    return () => { active = false; };
  }, [inUse, runSig]);
  const benchByJob = useMemo(() => new Map(bench.map((row) => [row.job_id, row])), [bench]);
  const benchRef = useRef<BenchRow[]>([]);
  useEffect(() => { benchRef.current = bench; }, [bench]);
  /** A change made on this device (offline): the board and its offline copy both follow. */
  const rememberBench = (update: (rows: BenchRow[]) => BenchRow[]) => {
    const next = update(benchRef.current);
    benchRef.current = next;
    setBench(next);
    void saveOfflineSnapshot("bench_runs", next);
  };
  /** Running on the bench (an open bench run: Pause shows), or Paused (its bench run was paused and nothing runs: Start resumes). */
  // The job's actual active work wins: while a machine run is open (live, or as bench_runs_state says) it is on the machine, never
  // "Paused" or on the bench.
  const benchOf = (job: WorkshopJob) => benchState(benchByJob.get(job.id), job, Boolean(live.byJob.get(job.id)?.length));
  const benchRunning = (job: WorkshopJob) => benchOf(job) === "running";
  const benchPaused = (job: WorkshopJob) => benchOf(job) === "paused";
  /** Jobs whose Finish is queued on this device (only added to here; settled by confirmQueuedFinishes after a sync pass). */
  const queuedFinishes = useRef(new Set<string>());
  /** This device's queue, read from the device store (so a reload shows the same state); refolded on every change. */
  const refreshPending = useCallback(async () => {
    const scope = offlineScope();
    try {
      const entries = scope ? await pendingEntries(scope) : [];
      for (const entry of entries) if (entry.op.kind === "finish") queuedFinishes.current.add(entry.op.jobId);
      setPending(entries);
    } catch {
      /* the board works without it */
    }
  }, []);
  /**
   * After a sync pass: a queued Finish that left the queue (not still waiting, not held as a conflict or refused) is asked of the server,
   * and the board takes the finisher the server recorded, so Reopen shows without a reload (the offline twin of the stamp in updateJobs).
   * A refused or failed replay stays in the queue or is held, so nothing changes for it; a read that fails keeps the jobs for the next pass.
   */
  const confirmQueuedFinishes = useCallback(async () => {
    const scope = offlineScope();
    const client = supabase;
    if (!scope || !client || !queuedFinishes.current.size) return;
    try {
      const [waiting, conflicts, refused] = await Promise.all([pendingEntries(scope), conflictEntries(scope), rejectedEntries(scope)]);
      const ids = finishesLeftQueue(queuedFinishes.current, [...waiting, ...conflicts, ...refused]);
      if (!ids.length) return;
      const { data, error } = await client.from("jobs").select("id, finished_at, finished_by").in("id", ids);
      if (error) return;
      setJobs((current) => confirmedFinishers(current, (data ?? []) as { id: string; finished_at?: string | null; finished_by?: string | null }[]));
      for (const id of ids) queuedFinishes.current.delete(id);
    } catch {
      /* the board works without it; a reload reads the finisher */
    }
  }, []);
  // Live state: on load, on focus or visibility, every 60 s while visible (plan R2.2, the pattern of /schedule); one read at a time.
  // A call made while one runs is folded into one more read straight after (the people lists too, when any call asked for them).
  const liveBusy = useRef(false);
  const liveAgain = useRef<{ withPeople: boolean } | null>(null);
  const loadLive = useCallback(async (withPeopleFirst = true) => {
    if (!supabase) return;
    if (liveBusy.current) {
      liveAgain.current = { withPeople: Boolean(liveAgain.current?.withPeople) || withPeopleFirst };
      return;
    }
    liveBusy.current = true;
    let next: { withPeople: boolean } | null = { withPeople: withPeopleFirst };
    try {
      while (next) {
        const { withPeople } = next;
        liveAgain.current = null;
        const client = supabase;
        // Run facts are read with the rest and applied in the same synchronous block (one render): the board never shows a machine
        // freed (Pause) while the job's last-run facts are still the old ones, which made Resume forget what it last ran on.
        const [runsRes, benchRes, pausedRes, whoRes, canRes, facts] = await Promise.all([
          client.rpc("machines_in_use"), client.rpc("bench_runs_state"), client.rpc("paused_machines"),
          withPeople ? loadCompanyPeople(client, { usernames: canReadUsernames(profile) }) : Promise.resolve(null), withPeople ? client.rpc("assignable_people") : Promise.resolve(null),
          loadRunFacts(),
        ]);
        if (!runsRes.error) {
          const rows = inUseRows(runsRes.data);
          setInUse(rows);
          void saveOfflineSnapshot("in_use", rows);
        } else if (isNetworkError(runsRes.error)) {
          void loadOfflineSnapshot<InUseRow[]>("in_use").then((cached) => { if (cached) setInUse(inUseRows(cached.data)); });
        }
        if (!benchRes.error) {
          const rows = benchRows(benchRes.data);
          setBench(rows);
          // Kept on the device, so an offline board still shows Paused and offers Pause.
          void saveOfflineSnapshot("bench_runs", rows);
        } else if (isNetworkError(benchRes.error)) {
          void loadOfflineSnapshot<BenchRow[]>("bench_runs").then((cached) => { if (cached) setBench(benchRows(cached.data)); });
        }
        if (!pausedRes.error) {
          const rows = pausedRows(pausedRes.data);
          setPaused(rows);
          void saveOfflineSnapshot("paused_machines", rows);
        } else if (isNetworkError(pausedRes.error)) {
          void loadOfflineSnapshot<PausedRow[]>("paused_machines").then((cached) => { if (cached) setPaused(pausedRows(cached.data)); });
        }
        if (whoRes) setPeople(whoRes);
        if (canRes && !canRes.error && Array.isArray(canRes.data)) setAssignable(canRes.data.filter((row: { user_id?: unknown; display_name?: unknown }) => typeof row.user_id === "string").map((row: { user_id: string; display_name?: unknown }) => ({ user_id: row.user_id, display_name: cleanName(row.display_name) ?? NAME_NOT_SET })));
        if (facts) {
          setRunFacts(runFactsByJob(facts));
          void saveOfflineSnapshot("run_facts", facts);
        } else {
          void loadOfflineSnapshot<Record<string, unknown>[]>("run_facts").then((cached) => { if (cached) setRunFacts(runFactsByJob(cached.data)); });
        }
        next = liveAgain.current;
      }
    } finally {
      liveBusy.current = false;
    }
  }, [profile]);
  useEffect(() => {
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const timer = window.setInterval(() => { if (visible()) void loadLive(false); }, 60_000);
    const onFocus = () => { if (visible()) { void loadLive(false); void refreshPending(); } };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loadLive, refreshPending]);
  // After every sync pass: what left the queue is the server's now (re-read), what is still pending is folded again (R3.4).
  useEffect(() => {
    void refreshPending();
    return onSyncComplete(() => { void refreshPending(); void loadLive(false); void confirmQueuedFinishes(); });
  }, [loadLive, refreshPending, confirmQueuedFinishes]);
  const loadMachinesList = useCallback(async () => {
    if (!supabase) { setMachinesLoaded(true); return; }
    const { data, error } = await supabase.from("machines").select("id, name, active").order("name");
    if (error) { setMachinesLoadError(true); setMachinesLoaded(true); return; }
    setMachinesLoadError(false);
    setMachinesLoaded(true);
    const list = (data ?? []).filter((m) => m.active !== false).map((m) => ({ id: String(m.id), name: String(m.name) }));
    setMachinesList(list);
    // Kept on the device, so an offline Start can still name the machine.
    void saveOfflineSnapshot("machines", list);
  }, []);
  // A related-job link was followed: that row is scrolled to and highlighted for a moment.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Done jobs older than the company's archive setting (or archived by hand) move to Archived; nothing is deleted.
  const archive = useArchive("jobs");
  const showOf = useCallback((job: WorkshopJob): Exclude<Show, "all"> => {
    const manual = archive.manual.get(job.id);
    if (archivePhase({ final: jobStatusOf(job) === "complete", finalDate: job.inspected_at }, manual, archive.months) === "archived") return "archived";
    return phaseOf(job);
  }, [archive.manual, archive.months]);
  // Average job time in hours or days, remembered on this device.
  const [timeUnit, setTimeUnit] = useState<"hours" | "days">("days");
  useEffect(() => { try { if (window.localStorage.getItem("job-time-unit") === "hours") setTimeUnit("hours"); } catch { /* not remembered */ } }, []);
  // Export PDF must work with no signal: once the board has loaded, online and idle, fetch its code (lib/pdf-warm.ts).
  useEffect(() => warmPdfExport(), []);
  const chooseTimeUnit = (unit: "hours" | "days") => { setTimeUnit(unit); try { window.localStorage.setItem("job-time-unit", unit); } catch { /* not remembered */ } };
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sendJob, setSendJob] = useState<WorkshopJob | null>(null);
  // One request key per e-mail in an open send dialog, so a retry or double click can't send it twice.
  const sendKeys = useRef(new Map<string, string>());
  const openSend = (job: WorkshopJob) => {
    sendKeys.current.clear();
    setSendJob(job);
  };
  const [worksheetJob, setWorksheetJob] = useState<WorkshopJob | null>(null);
  const [deliveryNoteJob, setDeliveryNoteJob] = useState<WorkshopJob | null>(null);
  /** Unsaved worksheet edits (audit D5): closing asks first. */
  const [worksheetDirty, setWorksheetDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const closeWorksheet = () => {
    if (worksheetDirty) setConfirmDiscard(true);
    else setWorksheetJob(null);
  };
  // Job Board view: one line per job by default (fits the screen), full table or cards on request (lib/view-mode).
  const [view, setView] = useViewMode("jobs", "list");
  // The Columns picker (admin and office): which of the shared columns Table, List and Cards show. Job No, Due and Actions always.
  const { isVisible: columnOn } = useColumnVisibility("jobs");
  const jobColumns = useMemo(() => shownJobColumns(columnOn), [columnOn]);
  /** A Cards field shows when its column does (locked columns always). */
  const fieldOn = (key: string) => jobColumns.some((column) => column.key === key);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const { saving, run } = useSaving();
  const isViewer = activeRole === "viewer";
  const canSend = activeRole === "admin" || activeRole === "office";

  useEffect(() => {
    let active = true;
    async function loadJobs() {
      setLoading(true);
      setLoadError(null);
      try {
        if (!supabase) {
          if (active) setJobs(await loadDemoJobs());
          return;
        }
        // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
        const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("jobs").select("*").order("created_at", { ascending: false }).order("id").range(from, to));
        const error = null;
        if (truncated) toast.warning(truncationNotice(data.length));
        if (error) throw error;
        if (active) setJobs((data ?? []).map(rowToJob));
        void loadJobMachines().then((map) => { if (active && map) setMachinesByJob(map); });
        void loadBoardJobFiles().then((map) => { if (active && map) setFilesByJob(map); });
        void loadLive(true).catch(() => { /* the board works without the live view */ });
        void loadMachinesList();
        // This device's offline copy of the Job Board (lib/offline): refreshed on every successful load, no money fields.
        void saveOfflineSnapshot("jobs", (data ?? []).map((row) => stripJobMoney(row as Record<string, unknown>)));
        reportOffline(false);
      } catch (error) {
        console.error(error);
        const copy = isNetworkError(error) ? await loadOfflineSnapshot<Record<string, unknown>[]>("jobs") : null;
        if (copy && active) {
          setJobs(copy.data.map(rowToJob));
          void loadOfflineSnapshot<{ id: string; name: string }[]>("machines").then((cached) => { if (!active) return; if (cached) setMachinesList(cached.data); else setMachinesLoadError(true); setMachinesLoaded(true); });
          void loadOfflineSnapshot<[string, JobMachineChip[]][]>("job_machines").then((cached) => { if (cached && active) setMachinesByJob(new Map(cached.data)); });
          void loadOfflineSnapshot<BenchRow[]>("bench_runs").then((cached) => { if (cached && active) setBench(benchRows(cached.data)); });
          void loadOfflineSnapshot<InUseRow[]>("in_use").then((cached) => { if (cached && active) setInUse(inUseRows(cached.data)); });
          void loadOfflineSnapshot<PausedRow[]>("paused_machines").then((cached) => { if (cached && active) setPaused(pausedRows(cached.data)); });
          void loadOfflineSnapshot<Record<string, unknown>[]>("run_facts").then((cached) => { if (cached && active) setRunFacts(runFactsByJob(cached.data)); });
          void refreshPending();
          reportOffline(true, copy.syncedAt);
          return;
        }
        if (active) setLoadError(friendlyError(error, "Couldn't load jobs."));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadJobs();
    return () => { active = false; };
  }, [attempt, loadLive, loadMachinesList, refreshPending]);

  // 099: "Complete jobs not yet fully despatched or invoiced" (from the dashboard) asks the database which jobs those are.
  const [unbilledIds, setUnbilledIds] = useState<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (listFilter !== "complete-unbilled" || !supabase) return;
    let active = true;
    void unbilledJobsOf(supabase).then((rows) => { if (active) setUnbilledIds(new Set((rows ?? []).map((row) => String(row.job_id)))); });
    return () => { active = false; };
  }, [listFilter, attempt]);

  const visible = useMemo(
    () => listFilter ? jobs.filter((job) => jobMatchesFilter(listFilter, job, toDateInput(new Date()), unbilledIds)) : jobs.filter((job) => (show === "all" || show === showOf(job)) && (!statusTile || jobStatusOf(job) === statusTile) && (!reworkOnly || reworkTag(job) !== null)
      && (statusFilters.has("all") || (inDueScope(job) && [...statusFilters].some((status) => jobMatchesStatus(job, status)))) && (stageFilters.size === 0 || stageFilters.has(stageOf(job.stage) ?? ""))
      && (jobType === "all" || (jobType === "internal") === Boolean(job.is_internal))),
    [jobs, listFilter, unbilledIds, show, showOf, statusTile, reworkOnly, stageFilters, statusFilters, jobType]
  );

  // Related jobs, both ways: the job a job is for, and the jobs that name it.
  const jobById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const relatedFrom = useMemo(() => {
    const map = new Map<string, WorkshopJob[]>();
    for (const job of jobs) if (job.related_job_id) map.set(job.related_job_id, [...(map.get(job.related_job_id) ?? []), job]);
    return map;
  }, [jobs]);
  /** Show every job (no filter hides it), then scroll to the job and highlight it: there is no job page to open. */
  const goToJob = useCallback((id: string) => {
    setShow("all");
    setJobType("all");
    setStatusTile(null);
    setReworkOnly(false);
    setStatusFilters(new Set(["all"]));
    setStageFilters(new Set());
    setHighlightId(id);
  }, []);
  // A link from elsewhere (the dashboard's Priority Jobs) names a job as /jobs?job=<id>: once the board has loaded, show and highlight that job (once).
  const linkedJobDone = useRef(false);
  useEffect(() => {
    if (linkedJobDone.current || loading || !jobs.length) return;
    linkedJobDone.current = true;
    const id = linkedJobId(window.location.search, jobs);
    if (id) goToJob(id);
  }, [loading, jobs, goToJob]);
  useEffect(() => {
    if (!highlightId) return;
    const scroll = window.setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>(`[data-job-id="${highlightId}"]`)].find((el) => el.offsetParent !== null);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    const clear = window.setTimeout(() => setHighlightId(null), 4000);
    return () => { window.clearTimeout(scroll); window.clearTimeout(clear); };
  }, [highlightId, visible]);

  /** Throws on failure; local state changes only after the database accepted the update. */
  async function updateJobs(ids: string[], patch: Partial<WorkshopJob>) {
    if (!ids.length) throw new Error("Select at least one job first.");
    let changed = ids;
    let reason = "";
    if (supabase && patch.finished_at) {
      // Finish goes through finish_job (migration 044): it fills an empty finish time only, ends the job's machine runs and completes
      // their bookings in the database's lock order. One call per job; a job that can't be reached is queued for when the connection is back.
      const client = supabase;
      const at = patch.finished_at;
      const done: string[] = [];
      let already = 0;
      let gone = 0;
      let networkError: unknown = null;
      const pending: string[] = [];
      for (const id of ids) {
        if (networkError) { pending.push(id); continue; }
        const { data, error } = await client.rpc("finish_job", { p_job: id, p_client_op_id: newClientOpId(), p_finished_at: at });
        if (error) {
          if (isNetworkError(error)) { networkError = error; pending.push(id); continue; }
          if (error.code === "P0002") { gone += 1; continue; }
          const refused = runRefusal(error);
          throw refused ? new ValidationError(refused.message) : error;
        }
        if ((data as { changed?: boolean } | null)?.changed) done.push(id); else already += 1;
      }
      if (networkError) {
        for (const id of pending) {
          const job = jobs.find((item) => item.id === id);
          if (!(await queueOffline({ kind: "finish", jobId: id, jobNo: job?.job_no ?? "", at, clientOpId: newClientOpId() }))) throw networkError;
        }
        for (const id of pending) queuedFinishes.current.add(id);
        const touched = [...done, ...pending];
        setJobs((current) => current.map((job) => (touched.includes(job.id) ? { ...job, ...patch } : job)));
        setInUse((current) => current.filter((row) => !touched.includes(row.job_id)));
        rememberBench((current) => touched.reduce((rows, id) => benchAfter(rows, id, "finish", at), current));
        const copy = await loadOfflineSnapshot<Record<string, unknown>[]>("jobs");
        if (copy) void saveOfflineSnapshot("jobs", copy.data.map((row) => (touched.includes(String(row.id)) ? { ...row, ...patch } : row)));
        reportOffline(true, copy?.syncedAt);
        return "queued" as const;
      }
      changed = done;
      if (already || gone) reason = missedReason("finish", already, gone);
      if (!changed.length) {
        if (ids.length === 1) {
          throw new ValidationError(already ? "The job wasn't updated: it was already finished, so the recorded time is kept. Reload the board." : "The job wasn't updated: removed, or you no longer have access. Reload the board.");
        }
        throw new ValidationError(`None of the selected jobs were updated: ${reason}. Reload the board.`);
      }
      void loadLive();
    } else if (supabase) {
      // A recorded start time is never replaced, even from a board that is out of date: the update only reaches rows where that time
      // is still empty (the others are reported as not updated, below).
      let update = supabase.from("jobs").update(patch).in("id", ids);
      if (patch.started_at) update = update.is("started_at", null);
      if (patch.finished_at) update = update.is("finished_at", null);
      const { data, error } = await update.select("id");
      if (error) {
        // Offline Start/Finish: queued on this device and sent in order when back online (lib/offline).
        const kinds = [...(patch.started_at ? (["start"] as const) : []), ...(patch.finished_at ? (["finish"] as const) : [])];
        if (!kinds.length || !isNetworkError(error)) throw error;
        for (const id of ids) {
          const job = jobs.find((item) => item.id === id);
          for (const kind of kinds) {
            const at = (kind === "start" ? patch.started_at : patch.finished_at) as string;
            if (!(await queueOffline({ kind, jobId: id, jobNo: job?.job_no ?? "", at }))) throw error;
            if (kind === "finish") queuedFinishes.current.add(id);
          }
        }
        const next = jobs.map((job) => (ids.includes(job.id) ? { ...job, ...patch } : job));
        setJobs(next);
        const copy = await loadOfflineSnapshot<Record<string, unknown>[]>("jobs");
        if (copy) void saveOfflineSnapshot("jobs", copy.data.map((row) => (ids.includes(String(row.id)) ? { ...row, ...patch } : row)));
        reportOffline(true, copy?.syncedAt);
        return "queued" as const;
      }
      // Only rows the database returns were changed (audit R7): a job removed or no longer visible isn't.
      const returned = new Set((data ?? []).map((row) => String(row.id)));
      changed = ids.filter((id) => returned.has(id));
      const missedIds = ids.filter((id) => !returned.has(id));
      if (missedIds.length) {
        // Tell "already started/finished elsewhere" (time kept) apart from "removed or not visible": read the missed rows back.
        const column = patch.finished_at ? "finished_at" : "started_at";
        const { data: rows } = await supabase.from("jobs").select(`id, ${column}`).in("id", missedIds);
        const alreadyDone = (rows ?? []).filter((row) => Boolean((row as Record<string, unknown>)[column])).length;
        reason = missedReason(patch.finished_at ? "finish" : "start", alreadyDone, missedIds.length - alreadyDone);
      }
      if (!changed.length) {
        if (ids.length === 1) {
          throw new ValidationError(reason.startsWith("1 was already")
            ? `The job wasn't updated: it was already ${patch.finished_at ? "finished" : "started"}, so the recorded time is kept. Reload the board.`
            : "The job wasn't updated: removed, or you no longer have access. Reload the board.");
        }
        throw new ValidationError(`None of the selected jobs were updated: ${reason}. Reload the board.`);
      }
    } else if (!DEMO_MODE) {
      throw new Error("Supabase is not configured.");
    }
    // A finish the database accepted was stamped with who finished it (035's actor_stamp): the board says so too, so the finisher can
    // reopen their own Finish (081, reopenCheck) without reloading the board.
    const stamp = patch.finished_at && profile?.id ? { finished_by: profile.id } : {};
    setJobs((current) => current.map((job) => (changed.includes(job.id) ? { ...job, ...patch, ...stamp } : job)));
    void auditEvent({ action: "UPDATE", entityTable: "jobs", metadata: { ids: changed, patch } });
    return { updated: changed.length, missed: ids.length - changed.length, reason };
  }

  /**
   * Inspection (migration 034): a result, measured notes and an optional file are recorded first; only a pass, or an admin's
   * concession, releases the job to Done, and the database refuses any other way of setting it.
   */
  const [inspectJob, setInspectJob] = useState<WorkshopJob | null>(null);
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const latestInspection = useMemo(() => latestByJob(inspections), [inspections]);
  // Failed inspections open a rework for the workshop (migration 037): the board shows it, the rework dialog works it.
  const [reworks, setReworks] = useState<ReworkRecord[]>([]);
  const [reworkJob, setReworkJob] = useState<WorkshopJob | null>(null);
  const liveRework = useCallback((job: WorkshopJob) => reworks.find((item) => item.job_id === job.id && item.status !== "closed"), [reworks]);
  const hasRework = useCallback((job: WorkshopJob) => inRework(job) || reworks.some((item) => item.job_id === job.id), [reworks]);
  useEffect(() => {
    if (!supabase || DEMO_MODE) return;
    let active = true;
    loadInspections().then((rows) => { if (active) setInspections(rows); }).catch(() => { /* the board works without the summary */ });
    loadReworks().then((rows) => { if (active) setReworks(rows); }).catch(() => { /* the board works without the rework details */ });
    return () => { active = false; };
  }, [attempt]);
  // 083: only people on the authorised inspectors list record an inspection, so the Inspected action is hidden from everyone else (the
  // same check the dialog makes; null = not known yet or offline, so it stays offered and the dialog and database still decide).
  const [canInspect, setCanInspect] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supabase || DEMO_MODE || !activeRole || activeRole === "viewer") return;
    let active = true;
    loadCanInspect(activeRole === "admin").then((may) => { if (active) setCanInspect(may); }).catch(() => { /* not known: the action stays offered */ });
    return () => { active = false; };
  }, [activeRole, profile?.id]);
  const inspectOffered = inspectedActionOffered(canInspect);
  const inspectionNote = (job: WorkshopJob) => inspectionSummary(latestInspection.get(job.id), Boolean(job.inspected_at));
  /** 081: the job's latest inspection failed with no disposition recorded (a fail made the older way): red until it is. */
  const failedUndecided = (job: WorkshopJob) => { const latest = latestInspection.get(job.id); return Boolean(latest && latest.result === "fail" && !latest.disposition); };
  /** Reopen (081): who may, with a reason; the server checks again (and refuses once it has gone out or been invoiced). */
  const [reopenFor, setReopenFor] = useState<WorkshopJob | null>(null);
  const reopenOf = (job: WorkshopJob) => reopenCheck(job, { role: activeRole, me: profile?.id });
  function onReopened(job: WorkshopJob) {
    setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, finished_at: "", finished_by: undefined, inspected_at: "", inspected_by: "", stage: ["inspection", "complete"].includes(item.stage) ? "machining" : item.stage } : item)));
    setReopenFor(null);
    toast.success(`${job.job_no} reopened: back to ${JOB_STATUS_LABELS[jobStatusOf({ ...job, finished_at: "", inspected_at: "" })]}`);
  }
  /** An admin's early release (081), from the job's details: with a reason; the server checks again and records it. */
  const [releaseFor, setReleaseFor] = useState<WorkshopJob | null>(null);
  const releaseOffered = (job: WorkshopJob) => earlyReleaseOffered(job, activeRole);
  const releaseButton = (job: WorkshopJob, card = false) => (releaseOffered(job)
    ? <Button size={card ? undefined : "sm"} variant="outline" className={rowTouch} disabled={saving} title="Let it go out before it passes inspection (admin, with a reason)" onClick={() => setReleaseFor(job)}><FastForward className="size-4" /> Release early</Button>
    : null);
  /** Archive / Unarchive (components/phase-filter, shared by every list): wrapped so its button is a 48px row target here only. */
  const archiveButton = (job: WorkshopJob) => (
    <span className="contents [&_button]:min-h-12"><ArchiveButton id={job.id} phase={showOf(job) === "archived" ? "archived" : "done"} manual={archive.manual.get(job.id)} onSet={archive.setState} /></span>
  );
  const reworkNote = (job: WorkshopJob) => {
    const live = liveRework(job);
    return live ? `${REWORK_STATUS_LABELS[live.status]}: ${quantityText(live, job.quantity_required)}. ${live.reason}` : "";
  };
  function onInspected(job: WorkshopJob, done: RecordedInspection) {
    if (done.queued) {
      // Offline: kept on this device and sent when the connection is back. Nothing is released meanwhile.
      setInspectJob(null);
      toast.info(`${job.job_no}: inspection saved on this device, sync pending. The job isn't Complete until it syncs.`);
      return;
    }
    const released = done.release_decision === "released";
    setJobs((current) => current.map((item) => (item.id === job.id
      ? { ...item, ...(released ? { inspected_at: done.inspected_at, inspected_by: profile?.full_name || profile?.email || "", stage: "complete", status: "on_track" as const } : { inspected_at: "", inspected_by: "", stage: "rework" }) }
      : item)));
    void loadInspections().then(setInspections).catch(() => { /* shown next time the board loads */ });
    void loadReworks().then(setReworks).catch(() => { /* shown next time the board loads */ });
    setInspectJob(null);
    toast.success(released ? `${job.job_no} inspected: Complete` : `${job.job_no} failed inspection: put back to Running, tagged Rework`);
  }

  function applyUpdate(ids: string[], patch: Partial<WorkshopJob>, message: string) {
    if (!ids.length) {
      toast.error("Select at least one job first.");
      return;
    }
    void run(() =>
      updateJobs(ids, patch)
        .then((result) => {
          if (result === "queued") toast.success(`${message} on this device. It will sync when you're back online.`);
          else if (result.missed) toast.warning(`${message}: ${result.updated} of ${result.updated + result.missed} jobs. ${result.missed} couldn't be updated (${result.reason}). Reload the board.`);
          else toast.success(message);
        })
        .catch((e) => { toast.error(e instanceof ValidationError ? e.message : friendlyError(e)); }),
    );
  }

  /** The board as it is now (jobsRef, above), for the checks below: a tap can arrive before the screen has redrawn. */
  const actionContext = useMemo(() => ({ viewer: isViewer }), [isViewer]);
  const finishedMessage = show === "active" ? "Job finished: Waiting for inspection" : "Job finished";

  /**
   * A Start moves the job on from Material (or Setup) to Machining, or to the stage chosen in the Start dialog (lib/job-actions
   * stageAfterStart). Only rows still at an earlier stage change (the update is filtered on the stage), so a job already further on, or
   * in rework, keeps its stage. Best effort: the Start itself is already recorded; a failure here is said, never thrown.
   */
  async function advanceStage(ids: string[], to: StartStage) {
    if (!supabase || DEMO_MODE || !ids.length) return;
    const from = stagesBeforeStart(to);
    // Two filtered updates (an earlier stage, or none yet): PostgREST refuses an `or` filter on an update (42703).
    const [named, empty] = await Promise.all([
      supabase.from("jobs").update({ stage: to }).in("id", ids).in("stage", from).select("id"),
      supabase.from("jobs").update({ stage: to }).in("id", ids).is("stage", null).select("id"),
    ]);
    const error = named.error ?? empty.error;
    if (error) {
      if (!isNetworkError(error)) toast.warning(`Started, but the stage couldn't be moved to ${label(to)}: ${friendlyError(error)}`);
      return;
    }
    const moved = new Set([...(named.data ?? []), ...(empty.data ?? [])].map((row) => String((row as { id: unknown }).id)));
    if (moved.size) setJobs((current) => current.map((job) => (moved.has(job.id) ? { ...job, stage: to } : job)));
  }

  // ----- Play / Pause (migration 049, plan 2.1, R2.2, R2.4, R3.1, R3.3, R3.4) --------------------------------------------------
  const canAct = canPauseRole(activeRole);
  const machineName = useCallback((id: string) => machinesList.find((m) => m.id === id)?.name ?? live.byMachine.get(id)?.machine_name ?? "the machine", [machinesList, live]);
  const pausedByMachine = useMemo(() => new Map(paused.map((row) => [row.machine_id, row])), [paused]);
  // Reasons written while replaying (a Pause held because its Start was refused) name the machine.
  useEffect(() => {
    setReplayMachineNames(machineName);
    return () => setReplayMachineNames(null);
  }, [machineName]);
  /** The server's view of the job's runs: machines held now (machines_in_use), its open bench run (bench_runs_state), its latest run. */
  const serverRun = (job: WorkshopJob): JobRunState => ({ jobId: job.id, machines: (live.byJob.get(job.id) ?? []).map((row) => row.machine_id), bench: benchRunning(job) });
  /** Server state + this device's pending Starts and Pauses, folded in capture order (R3.4). */
  const viewOf = (job: WorkshopJob) => pendingRunView(serverRun(job), pending);
  /** How the job last ran. Unknown (not read yet, no offline copy): never claims "not timed". */
  const factsOf = (job: WorkshopJob) => {
    if (!runFacts) return { hasRuns: true, lastEnd: benchByJob.get(job.id)?.end_reason ?? null, lastMachines: [] as string[], lastBench: benchPaused(job) };
    const facts = runFacts.get(job.id);
    return facts ?? { hasRuns: false, lastEnd: null, lastMachines: [] as string[], lastBench: false, openMachines: [], benchOpen: false };
  };
  /** The control and the words (the same for every role; the control only for admin, office and workshop). */
  const playOf = (job: WorkshopJob) => {
    const facts = factsOf(job);
    const state = playState(job, { viewer: false }, viewOf(job), { ...facts, ...releaseFacts(facts, people) }, machineName);
    return canAct ? state : { ...state, button: null };
  };
  /** The Play state is "Paused" (the status chip then says Paused, not Running). */
  const isPaused = (job: WorkshopJob) => playOf(job).kind === "paused";
  const statusOf = (job: WorkshopJob) => runViewLabel(viewOf(job), machineName) ?? playOf(job).status;
  const busyOther = (job: WorkshopJob) => (machineId: string) => { const row = live.byMachine.get(machineId); return Boolean(row && row.job_id !== job.id); };
  /** What Play starts on: the column's ticks, else the default (free planned machines; Resume: what it last ran on). */
  const pickOf = (job: WorkshopJob): MachinePick => {
    const chosen = picks.get(job.id);
    if (chosen) return chosen;
    const facts = factsOf(job);
    const kind = playOf(job).kind;
    // What it last ran on: what the server still has open when a Pause is waiting on this device, else its latest closed runs.
    const server = serverRun(job);
    const open = server.machines.length > 0 || server.bench;
    return defaultPick({
      planned: (machinesByJob.get(job.id) ?? []).map((chip) => chip.machine_id),
      lastMachines: open ? server.machines : facts.lastMachines, lastBench: open ? server.bench : facts.lastBench || benchPaused(job),
      resuming: kind === "paused" || kind === "stopped_admin" || kind === "stopped_override", busy: busyOther(job),
    });
  };
  const setPick = (job: WorkshopJob, pick: MachinePick) => setPicks((current) => new Map(current).set(job.id, pick));
  const pickerMachines = (job: WorkshopJob): PickerMachine[] => {
    const plan = new Map((machinesByJob.get(job.id) ?? []).map((chip) => [chip.machine_id, chip]));
    return [...machinesList].sort((a, b) => Number(plan.has(b.id)) - Number(plan.has(a.id)) || a.name.localeCompare(b.name))
      .map((m) => ({ id: m.id, name: m.name, planned: plan.has(m.id), booked: Boolean(plan.get(m.id)?.booked) }));
  };
  /** Planned machines, all held by other jobs: Play says "Pick a machine" (R2.4). */
  const allPlannedBusy = (job: WorkshopJob) => { const plan = machinesByJob.get(job.id) ?? []; return plan.length > 0 && plan.every((chip) => busyOther(job)(chip.machine_id)); };

  /**
   * Play: the ticked machines (or the bench, ticked deliberately). Nothing ticked: the picker opens. A machine another job holds: workshop
   * and office can't use it; an admin takes it over with a reason. A machine paused on another unfinished job: the warning first (soft:
   * "I've checked" always goes on, and is recorded against the run shown).
   */
  function play(job: WorkshopJob, chosen?: MachinePick) {
    if (!canAct) { toast.error("Only admin, office or workshop staff can start a job."); return; }
    if (saving || startingId) { toast.info("Wait for the last change to finish."); return; }
    const pick = chosen ?? pickOf(job);
    if (!pick.bench && !pick.machines.length) {
      setPickerFor(job.id);
      toast.info(`${job.job_no}: pick a machine, or No machine (bench), then press Play.`);
      return;
    }
    const taken = pick.machines.filter(busyOther(job));
    if (taken.length && activeRole !== "admin") {
      const row = live.byMachine.get(taken[0])!;
      toast.error(`${row.machine_name} is in use by ${row.operator_name ?? "someone"} on ${row.job_no}. Pick a free machine, or ask an admin to take it over.`);
      return;
    }
    const rows = pausedFor(paused, job.id, pick.machines.filter((id) => !taken.includes(id)));
    if (rows.length || taken.length) { setPrompt({ job, pick, rows, takeover: taken.map(machineName) }); return; }
    startRun(job, pick, [], false, null);
  }

  /** Puts the job's started_at on the board and its offline copy (an offline Start: the server stamps it when it syncs). */
  async function markStarted(job: WorkshopJob, at: string) {
    if (job.started_at) return;
    setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, started_at: at } : item)));
    const copy = await loadOfflineSnapshot<Record<string, unknown>[]>("jobs");
    if (copy) void saveOfflineSnapshot("jobs", copy.data.map((row) => (String(row.id) === job.id && !row.started_at ? { ...row, started_at: at } : row)));
  }

  /**
   * One Start through start_machine_run (049): the six 046 arguments, p_bench only for a deliberate bench Start, p_paused_ack only with a
   * confirmed check. Online there is no optimistic state: Play says "Starting..." until the server answers. A dropped connection queues the
   * Start (run_start) and the board folds it in. A server without 049 says it needs an update and queues nothing (R3.3).
   */
  function startRun(job: WorkshopJob, pick: MachinePick, ack: { machine_id: string; paused_run_id: string }[], override: boolean, reason: string | null) {
    if (!supabase) { toast.error("Supabase is not configured."); return; }
    const client = supabase;
    const stage = stages.get(job.id) ?? DEFAULT_START_STAGE;
    const op: RunStartOp = { kind: "run_start", v: 2, jobRef: job.id, jobNo: job.job_no, at: nowIso(), clientOpId: newClientOpId(), machines: pick.bench ? [] : pick.machines, bench: pick.bench, pausedAck: ack, stage };
    const where = pick.bench ? "on the bench" : `on ${pick.machines.map(machineName).sort((a, b) => a.localeCompare(b)).join(", ")}`;
    // A Pause or Start of this job still waits on the device: this one queues behind it, so the order is kept.
    const queueFirst = pending.some((entry) => (entry.op.kind === "run_start" || entry.op.kind === "run_pause") && entry.op.jobRef === job.id);
    setStartingId(job.id);
    void run(async () => {
      try {
        const queue = async () => {
          if (override) { toast.error("Taking a machine over needs a connection. Try again when you're back online."); return; }
          if (!(await queueOffline(op))) { toast.error("This device can't keep the Start offline. Reconnect and try again."); return; }
          await markStarted(job, op.at);
          await refreshPending();
          reportOffline(true);
          setPicks((current) => { const next = new Map(current); next.delete(job.id); return next; });
          toast.success(`${job.job_no} started ${where} on this device. It will sync when you're back online.`);
        };
        if (queueFirst) { await queue(); return; }
        const { data, error } = await client.rpc("start_machine_run", runStartArgs(op, override, override ? reason : null));
        if (error) {
          if (isNetworkError(error)) { await queue(); return; }
          if (isServerTooOld(error)) { toast.error(`${job.job_no} wasn't started: ${SERVER_UPGRADE_REASON.replace(/^Waiting: /, "").replace(/ Nothing was lost\.$/, "")} Nothing was queued.`); return; }
          if ((error as { code?: string }).code === "P0002") { toast.error("The job wasn't updated: removed, or you no longer have access. Reload the board."); return; }
          const refused = runRefusal(error);
          toast.error(refused ? refused.message : friendlyError(error));
          void loadLive(false);
          return;
        }
        const answer = data as RunStartAnswer | null;
        if (answer?.started_at) setJobs((current) => current.map((item) => (item.id === job.id && !item.started_at ? { ...item, started_at: answer.started_at } : item)));
        setPicks((current) => { const next = new Map(current); next.delete(job.id); return next; });
        if (!requestedRunsPresent(op, answer)) toast.warning(missingRunsReason(op, answer, machineName));
        else {
          const took = (answer as { overrides?: { job_no?: string; machine?: string }[] } | null)?.overrides?.length ? " Takeover recorded." : "";
          toast.success(`${job.job_no} started ${where}.${took}`);
          if (answer?.paused_warnings?.length) toast.info(`Recorded: started over ${answer.paused_warnings.map((w) => `${w.machine ?? machineName(w.machine_id)} (paused on ${w.job_no})`).join(", ")}. Check with that operator.`);
          await advanceStage([job.id], stage);
        }
        await Promise.all([loadLive(false), loadJobMachines().then((map) => { if (map) setMachinesByJob(map); })]);
      } finally {
        setStartingId(null);
      }
    });
  }

  /** Pause: every machine the job holds is freed and its bench run ends; the job's time stops; it stays started. Offline, queued (run_pause). */
  function pauseJob(job: WorkshopJob) {
    if (!supabase) return;
    if (!canAct) { toast.error("Only admin, office or workshop staff can pause a job."); return; }
    if (saving || startingId) { toast.info("Wait for the last change to finish."); return; }
    const client = supabase;
    const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: job.id, jobNo: job.job_no, at: nowIso(), clientOpId: newClientOpId(), machines: null, afterStart: null };
    const names = viewOf(job).machines.map(machineName);
    const queueFirst = pending.some((entry) => (entry.op.kind === "run_start" || entry.op.kind === "run_pause") && entry.op.jobRef === job.id);
    void run(async () => {
      const queue = async () => {
        if (!(await queueOffline(op))) { toast.error("This device can't keep the Pause offline. Reconnect and try again."); return; }
        await refreshPending();
        reportOffline(true);
        toast.success(`${job.job_no} paused on this device. It will sync when you're back online.`);
      };
      if (queueFirst) { await queue(); return; }
      const { error } = await client.rpc("pause_machine_run", { p_job: op.jobRef, p_machines: null, p_client_op_id: op.clientOpId, p_ended_at: op.at });
      if (error) {
        if (isNetworkError(error)) { await queue(); return; }
        const refused = runRefusal(error);
        toast.error(refused ? refused.message : friendlyError(error));
        void loadLive(false);
        return;
      }
      toast.success(names.length ? `${job.job_no} paused: ${names.join(", ")} freed.` : `${job.job_no} paused.`);
      await loadLive(false);
    });
  }
  /** Admin: free a machine whose run was forgotten, with a reason (asked in a dialog; recorded). */
  const [releaseRow, setReleaseRow] = useState<InUseRow | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  function releaseMachine(row: InUseRow, reason: string) {
    if (!supabase) return;
    const client = supabase;
    setReleaseRow(null);
    void run(async () => {
      const { error } = await client.rpc("release_machine", { p_machine: row.machine_id, p_reason: reason });
      if (error) { const refused = runRefusal(error); toast.error(refused ? refused.message : friendlyError(error)); return; }
      toast.success(`${row.machine_name} released (was ${row.job_no}).`);
      await loadLive();
    });
  }
  /** Assign a job to an operator (admin and office anyone; workshop themselves). */
  function assignJob(job: WorkshopJob, userId: string | null) {
    if (!supabase) return;
    const client = supabase;
    void run(async () => {
      const { error } = await client.rpc("assign_job", { p_job: job.id, p_user: userId });
      if (error) {
        const refused = runRefusal(error);
        toast.error(refused ? refused.message : friendlyError(error));
        return;
      }
      setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, assigned_to: userId ?? undefined } : item)));
      toast.success(userId ? `${job.job_no} assigned to ${personName(people, userId)}` : `${job.job_no} unassigned`);
    });
  }
  // A single job's Pause or Finish asks first ("Are you sure?"); nothing is sent or queued until Confirm. Bulk has its own confirm below.
  const [confirmOne, setConfirmOne] = useState<{ kind: "pause" | "finish"; id: string } | null>(null);
  const confirmOneJob = confirmOne ? jobs.find((item) => item.id === confirmOne.id) ?? null : null;
  function askPause(job: WorkshopJob) {
    if (!canAct) { toast.error("Only admin, office or workshop staff can pause a job."); return; }
    if (saving || startingId) { toast.info("Wait for the last change to finish."); return; }
    setConfirmOne({ kind: "pause", id: job.id });
  }
  function askFinish(id: string) {
    if (saving) return; // a change is in flight: a second tap does not open a second question
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job) { toast.error("That job is no longer on the board. Reload the board."); return; }
    if (!finishPatch(job, nowIso())) { toast.info(`${job.job_no}: ${finishCheck(job, actionContext).reason.toLowerCase() || "can't be finished"}. Its finish time is unchanged.`); return; }
    setConfirmOne({ kind: "finish", id });
  }
  function confirmOneAction() {
    if (!confirmOne || saving) return;
    const { kind, id } = confirmOne;
    setConfirmOne(null);
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job) { toast.error("That job is no longer on the board. Reload the board."); return; }
    if (kind === "pause") pauseJob(job); else finishOne(id);
  }
  function finishOne(id: string) {
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job) { toast.error("That job is no longer on the board. Reload the board."); return; }
    const patch = finishPatch(job, nowIso());
    if (!patch) { toast.info(`${job.job_no}: ${finishCheck(job, actionContext).reason.toLowerCase() || "can't be finished"}. Its finish time is unchanged.`); return; }
    applyUpdate([id], patch, finishedMessage);
  }

  // Bulk Finish only (bulk Start was removed: a start is recorded per job, with Play and its machine pick): asks first, naming the jobs it will really change (lib/job-actions.planBulk).
  const [bulkKind, setBulkKind] = useState<BulkKind | null>(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedJobs = useMemo(() => jobs.filter((job) => selectedSet.has(job.id)), [jobs, selectedSet]);
  const visibleIds = useMemo(() => new Set(visible.map((job) => job.id)), [visible]);
  // A selected job that a filter, tab or stage change now hides is dropped, so Start / Finish / print / export act on visible jobs only.
  useEffect(() => { setSelectedIds((current) => keepVisibleSelected(current, visibleIds)); }, [visibleIds]);
  const hiddenSelected = selectedJobs.filter((job) => !visibleIds.has(job.id)).length;
  const finishBlocked = bulkDisabledReason("finish", selectedJobs, actionContext);
  // CSV / Excel / Word / PDF: the selected jobs if any, otherwise every job in the current filter. CSV / Excel use the import column spec, not the display columns.
  const exportScope = exportScopeRows(selectedJobs, visible);
  const scopeTitle = exportScopeTitle("job", selectedJobs.length, visible.length);
  const bulkPlan = bulkKind ? planBulk(bulkKind, selectedJobs, "", actionContext) : null;
  const allFilteredSelected = visible.length > 0 && visible.every((job) => selectedSet.has(job.id));

  function confirmBulk() {
    if (!bulkKind) return;
    const kind = bulkKind;
    setBulkKind(null);
    const plan = planBulk(kind, jobsRef.current.filter((job) => selectedSet.has(job.id)), nowIso(), actionContext);
    if (!plan.targets.length) { toast.error("None of the selected jobs can be finished."); return; }
    const total = plan.targets.length;
    const message = `${total} job(s) finished${show === "active" ? ": Waiting for inspection" : ""}`;
    void run(async () => {
      let updated = 0;
      let missed = 0;
      const reasons: string[] = [];
      let queued = false;
      let failure: unknown = null;
      let failedJobs = 0;
      for (const group of groupByPatch(plan.targets)) {
        try {
          const result = await updateJobs(group.ids, group.patch);
          if (result === "queued") queued = true;
          else { updated += result.updated; missed += result.missed; if (result.reason) reasons.push(result.reason); }
        } catch (e) {
          failure ??= e;
          failedJobs += group.ids.length;
        }
      }
      if (failure) {
        const reason = failure instanceof ValidationError ? failure.message : friendlyError(failure);
        toast.error(updated || queued ? `${failedJobs} of ${total} jobs weren't updated. ${reason}` : reason);
      } else if (queued) toast.success(`${message} on this device. It will sync when you're back online.`);
      else if (missed) toast.warning(`${message}: ${updated} of ${updated + missed} jobs. ${missed} couldn't be updated (${reasons.join("; ")}). Reload the board.`);
      else toast.success(message);
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function printWorkshopPack() {
    if (!selectedIds.length) {
      toast.error(`No jobs selected. Tick the jobs to print${visible.length ? ` (or use "Select all ${visible.length} filtered")` : ""}, then press Print Workshop Pack again.`);
      return;
    }
    const selected = jobs.filter((job) => selectedIds.includes(job.id));
    // The pack prints one worksheet sheet (the single worksheet's form) with every selected job on it.
    const opened = window.open(`/jobs/print?ids=${selected.map((job) => encodeURIComponent(job.id)).join(",")}`, "_blank");
    if (!opened) {
      toast.error("Your browser blocked the workshop pack window. Allow pop-ups for this site, then press Print Workshop Pack again.");
      return;
    }
    void auditEvent({ action: "PRINT_PACK", entityTable: "jobs", metadata: { title: "Workshop Job Pack", section_count: selected.length } });
    toast.success(`Workshop pack for ${selected.length} job${selected.length === 1 ? "" : "s"} opened in a new tab.`);
  }

  function selectedJobRows() {
    return exportScope.map((job) => ({
      "Job No": job.job_no,
      Customer: job.customer,
      Description: job.description,
      Specification: job.specification,
      Drawings: jobBoardFiles(job, filesByJob).drawings.join(", "),
      Stage: stageLabel(job.stage),
      Due: showDate(job.due_date) || DUE_LABEL.no_due_date,
      Started: job.started_at ? fmtDateTime(job.started_at) : "Not started",
      Finished: job.finished_at ? fmtDateTime(job.finished_at) : "Not finished",
      // The same words as the board: the status, then the Rework tag and the due-date light when the job has them.
      Status: [flowBadge(job, { paused: isPaused(job) }).label, reworkTag(job, failedUndecided(job))?.label, dueLightOf(job) ? DUE_LABEL[dueLightOf(job)!] : null].filter(Boolean).join(", "),
    }));
  }

  async function sendToWorkshop(job: WorkshopJob, formData: FormData) {
    const email = String(formData.get("email") || "").trim();
    if (!email) {
      toast.error("Enter the workshop email address.");
      return;
    }
    const keyFor = `${job.id}|${email.toLowerCase()}`;
    const idempotencyKey = sendKeys.current.get(keyFor) ?? crypto.randomUUID();
    sendKeys.current.set(keyFor, idempotencyKey);
    await run(async () => {
      try {
        const response = await fetch("/api/send-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: job.id,
            recipient_email: email,
            subject: String(formData.get("subject")),
            body: String(formData.get("body")),
            idempotency_key: idempotencyKey,
          }),
        });
        const result = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
        if (result.status === "unknown") {
          // Not a failure we can retry: it may have been sent. The same key is kept, so pressing Send again can't send twice.
          toast.warning(result.error ?? "We couldn't confirm whether this email was sent. Don't send it again yet.", { duration: 12000 });
          setSendJob(null);
          return;
        }
        if (!response.ok || result.status === "failed") throw new Error("send failed");
        void auditEvent({ action: "SEND_TO_WORKSHOP", entityTable: "jobs", entityId: job.id, metadata: { recipient: email, status: result.status } });
        if (result.status === "sent") toast.success("Email sent");
        else if (result.status === "drafted") toast.success("Saved as draft \u2014 email isn't set up yet");
        else toast.success("Request accepted");
        setSendJob(null);
      } catch (error) {
        toast.error(friendlyError(error, "Couldn't send the job email. Try again."));
      }
    });
  }

  // Touch sizes (coarse pointer): the workshop works with gloves, so Start / Finish are at least 64px high and every
  // other control at least 48px; everyone else keeps the standard 44px that Button gives on a coarse pointer.
  // A job's row, card and the selection bar go further: every control in them is at least 48px tall on any pointer (taller rows,
  // easy to scan and to tap on a tablet), so primaryTouch, boxTouch and rowTouch carry min-h-12 too.
  const workshop = activeRole === "workshop";
  const primaryTouch = cn("min-h-12", workshop ? "pointer-coarse:h-16 pointer-coarse:min-w-16" : "");
  const boxTouch = cn("min-h-12", workshop ? "pointer-coarse:size-12" : "");
  const secondaryTouch = workshop ? "pointer-coarse:h-12 pointer-coarse:min-w-12" : "";
  const rowTouch = cn("min-h-12", secondaryTouch);

  /** Stacked card for one job: phones always, and the Cards view on larger screens. */
  const jobCard = (job: WorkshopJob, sheet = false) => {
    const finish = finishCheck(job, actionContext);
    return (
    <Card key={job.id} data-testid="job-card" data-job-no={job.job_no} data-job-id={job.id} data-highlighted={highlightId === job.id ? "true" : undefined} className={highlight(job)}>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1"><SelectBox boxClassName={boxTouch} aria-label={`Select ${job.job_no}`} checked={selectedSet.has(job.id)} onChange={() => toggleSelected(job.id)} /><p className="min-w-0 font-mono font-semibold break-all">{job.job_no}</p></div>
                <JobStatusBadges job={job} progress={statusOf(job)} failedUndecided={failedUndecided(job)} paused={isPaused(job)} />
              </div>
              {/* Captions: a stacked card has no table header to say which value is which. */}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                {fieldOn("customer") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Customer</dt><dd className="flex flex-wrap items-center gap-2 break-words">{job.customer}{job.is_internal ? <InternalBadge /> : null}</dd></div> : null}
                {fieldOn("description") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Description</dt><dd className="break-words text-slate-600">{boardDescription(job.description, job.specification)}</dd></div> : null}
                {fieldOn("specification") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Specification</dt><dd className="break-words text-xs text-slate-600">{job.specification || "None recorded"}</dd></div> : null}
                {fieldOn("drawings") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Drawings</dt><dd className="break-words text-xs text-brand"><FileNames names={jobBoardFiles(job, filesByJob).drawings} empty="None" testId="job-drawings" /></dd></div> : null}
                {fieldOn("attachments") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Attachments</dt><dd className="break-words text-xs text-slate-600"><FileNames names={jobBoardFiles(job, filesByJob).attachments} empty="None" testId="job-attachments" /></dd></div> : null}
                {fieldOn("stage") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Stage</dt><dd className="break-words">{stageLabel(job.stage)}</dd></div> : null}
                {fieldOn("machine") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Machine</dt><dd className="break-words">{machineCell(job, sheet)}</dd></div> : null}
                {fieldOn("operator") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Operator</dt><dd className="break-words">{operatorCell(job)}</dd></div> : null}
                {fieldOn("due") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Due</dt><dd className="break-words">{showDate(job.due_date) || DUE_LABEL.no_due_date}</dd></div> : null}
                {fieldOn("started") ? <div className="min-w-0"><dt className="label-mono field-caption">Started</dt><dd className="break-words text-xs">{job.started_at ? fmtDateTime(job.started_at) : "Not started"}</dd></div> : null}
                {fieldOn("finished") ? <div className="min-w-0"><dt className="label-mono field-caption">Finished</dt><dd className="break-words text-xs">{job.finished_at ? fmtDateTime(job.finished_at) : "Not finished"}</dd></div> : null}
                {fieldOn("inspection") ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Inspection</dt><dd className="break-words text-xs">{job.finished_at ? inspectionNote(job) : "Not finished"}</dd></div> : null}
                {reworkNote(job) ? <div className="col-span-2 min-w-0"><dt className="label-mono field-caption">Rework</dt><dd className="break-words text-xs">{reworkNote(job)}</dd></div> : null}
              </dl>
              {relatedLinks(job)}
              <div className="flex flex-wrap gap-2">
                {playButton(job, "default")}
                {finish.shown ? <Button variant="finish" className={cn(primaryTouch, saving || !finish.enabled ? "opacity-50" : "")} aria-disabled={saving || !finish.enabled || undefined} title={finish.reason || "Finish"} onClick={() => (!finish.enabled ? toast.info(`${job.job_no}: ${finish.reason}`) : askFinish(job.id))}>{job.finished_at ? "Finished" : "Finish"}</Button> : null}
                {isViewer || !inspectOffered || !job.finished_at || job.inspected_at || (inRework(job) && activeRole !== "admin") ? null : <Button variant="outline" className={rowTouch} disabled={saving} onClick={() => setInspectJob(job)}><ShieldCheck className="size-4 text-orange-600 dark:text-orange-400" /> Inspected</Button>}
                {reopenOf(job).allowed ? <Button variant="outline" className={rowTouch} disabled={saving} onClick={() => setReopenFor(job)}><RotateCcw className="size-4" /> Reopen</Button> : null}
                {releaseButton(job, true)}
                {hasRework(job) ? <Button variant="outline" className={rowTouch} onClick={() => setReworkJob(job)}><Wrench className="size-4" /> Rework</Button> : null}
                <Button variant="outline" className={rowTouch} onClick={() => setWorksheetJob(job)}>Worksheet</Button>
                {isViewer ? null : <Button variant="outline" className={rowTouch} aria-label={`Machines for ${job.job_no}`} onClick={() => setMachineJob(job)}><Cog className="size-4" /> Machines</Button>}
                <Button asChild variant="outline" className={rowTouch}><Link href={`/jobs/${job.id}/print`}>Print</Link></Button>
                {canOfferJobDeliveryNote(activeRole, job) ? <Button variant="outline" className={rowTouch} onClick={() => setDeliveryNoteJob(job)}><Truck className="size-4" /> Delivery note</Button> : null}
                {canSend ? <Button onClick={() => openSend(job)} disabled={saving} className={cn("bg-brand text-brand-ink", rowTouch)}>Send</Button> : null}
                {archive.canManage && job.inspected_at ? archiveButton(job) : null}
              </div>
            </CardContent>
    </Card>
    );
  };

  /** A row action: icon plus its word on every screen, so no action is named only by a hover tooltip (the name is there for screen readers too). */
  // A disabled tap (or Enter on it) says why: aria-disabled + a toast with the reason, not the hover title alone.
  const rowAction = ({ label: text, title, icon, variant = "outline", className, disabled, onClick, primary }: { label: string; title: string; icon: React.ReactNode; variant?: "start" | "finish" | "outline" | "default"; className?: string; disabled?: boolean; onClick: () => void; primary?: boolean }) => (
    <Button size="sm" variant={variant} className={cn("px-3", disabled ? "opacity-50" : "", className, primary ? primaryTouch : rowTouch)} title={title} aria-label={text} aria-disabled={disabled || undefined} onClick={() => (disabled ? toast.info(title) : onClick())}>{icon}<span aria-hidden>{text}</span></Button>
  );
  /** Play (green outline) or Pause (solid amber) for one job (plan 2.1). Words always shown; "Starting..." while the server answers. */
  const playButton = (job: WorkshopJob, size: "sm" | "default" = "sm") => {
    const state = playOf(job);
    if (!state.button) return null;
    const starting = startingId === job.id;
    const pick = pickOf(job);
    const needPick = state.button === "play" && !pick.bench && !pick.machines.length;
    const label = starting ? "Starting…" : needPick && allPlannedBusy(job) ? "Pick a machine" : state.label;
    return (
      <Button size={size} variant={state.button === "pause" ? "pause" : "start"} data-testid="play-pause" data-state={state.kind} className={cn("px-3", saving || needPick ? "opacity-60" : "", primaryTouch)}
        aria-label={state.aria} aria-busy={starting || undefined} aria-disabled={needPick || undefined} title={needPick ? "Pick a machine (or No machine (bench)) in the Machine column" : state.aria}
        onClick={() => (state.button === "pause" ? askPause(job) : play(job))}>
        {starting ? <Loader2 className="size-4 animate-spin" /> : state.button === "pause" ? <PauseCircle className="size-4" /> : <Play className="size-4" />}<span aria-hidden>{label}</span>
      </Button>
    );
  };

  const highlight = (job: WorkshopJob) => (highlightId === job.id ? "ring-2 ring-brand ring-inset bg-amber-50 dark:bg-amber-900/30" : "");
  /** The related job (forward) and the jobs related to this one (back), each a link that finds the row on the board. */
  const relatedLinks = (job: WorkshopJob) => {
    const to = job.related_job_id ? jobById.get(job.related_job_id) : undefined;
    const from = relatedFrom.get(job.id) ?? [];
    if (!to && !from.length) return null;
    const link = (target: WorkshopJob) => (
      <button key={target.id} type="button" className="min-h-12 font-mono font-semibold text-brand underline underline-offset-2 pointer-coarse:px-2" onClick={() => goToJob(target.id)}>{target.job_no}</button>
    );
    return (
      <span data-testid="related-links" className="flex flex-wrap items-center gap-x-1 font-sans text-xs font-normal text-slate-600 dark:text-slate-300">
        {to ? <span data-testid="related-to">Related to {link(to)}</span> : null}
        {from.length ? <span data-testid="related-from">Related: {from.map((item, i) => <Fragment key={item.id}>{i ? ", " : ""}{link(item)}</Fragment>)}</span> : null}
      </span>
    );
  };

  /** "Planned: Mill 6 h, Lathe 2.5 h (booked)": the job's plan in one grey line, the same in the list, the table and the cards. */
  const machineChips = (job: WorkshopJob) => {
    const chips = machinesByJob.get(job.id);
    if (!chips?.length) return null;
    return (
      <span className="block font-sans text-xs font-normal text-slate-500 dark:text-slate-400">Planned: <span data-testid="job-machines">
        {chips.map((chip, i) => <span key={chip.machine_id}>{i ? ", " : ""}{chip.name} {formatHours(chip.hours)}{chipBookingSuffix(chip, Boolean(job.finished_at))}</span>)}
      </span></span>
    );
  };

  /**
   * The Machine column (plan 2.2): while running, every machine the job holds ("Mill, since 09:12"), an admin's Release on each, and Add;
   * on the bench "N/A (bench)"; otherwise the picker Play starts on (prefilled per R2.4). A viewer, or a finished job: text only.
   */
  const machineCell = (job: WorkshopJob, sheet = false) => {
    // Machines are added on the Machine Schedule (admin or office), unless that page is hidden from this person or the company.
    const canAddMachine = (activeRole === "admin" || activeRole === "office") && canOpenDestination("/schedule", { activeRole, hiddenSections, hiddenNav: orgSettings.hiddenNav });
    const view = viewOf(job);
    const state = playOf(job);
    const rows = live.byJob.get(job.id) ?? [];
    const canPick = Boolean(state.button) && (activeRole === "admin" || activeRole === "office" || activeRole === "workshop");
    const waiting = runViewLabel(view, machineName);
    const picker = (running: boolean) => (
      <MachinePicker jobNo={job.job_no} jobId={job.id} machines={pickerMachines(job)} inUse={live.byMachine} paused={pausedByMachine} pick={pickOf(job)} role={activeRole} disabled={saving} loadFailed={machinesLoadError} loading={!machinesLoaded} canAddMachine={canAddMachine}
        running={running} sheet={sheet} active={sheet === isPhone} open={pickerFor === job.id} onOpenChange={(open) => setPickerFor(open ? job.id : null)}
        onChange={(pick) => setPick(job, pick)} onAdd={(ids) => play(job, { machines: ids, bench: false })} onStart={(chosen) => play(job, chosen)} touch="min-h-12"
        stage={stageAfterStart(job.stage, "machining") ? { value: stages.get(job.id) ?? DEFAULT_START_STAGE, fromSetup: job.stage === "setup", onChange: (next) => setStages((current) => new Map(current).set(job.id, next)) } : null} />
    );
    return (
      <div data-testid="machine-cell" className="min-w-0 max-w-full space-y-1 font-sans text-xs font-normal [overflow-wrap:anywhere]">
        {rows.length ? (
          <span data-testid="job-in-use" className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-red-700 dark:text-red-400">
            {rows.map((row) => (
              <span key={row.run_id} className="inline-flex flex-wrap items-center gap-1" data-stale={isStale(row) ? "true" : undefined}>
                <span className="rounded-none bg-red-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-red-800 dark:bg-red-900/40 dark:text-red-200">In use</span>
                <span className="font-normal text-slate-700 dark:text-slate-200">{row.machine_name}, since {fmtDateTime(row.started_at)}{isStale(row) ? " (no Finish or Pause for 12 h+)" : ""}</span>
                {activeRole === "admin" ? <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", rowTouch)} aria-label={`Release ${row.machine_name}`} title="Free this machine (the run ends now; recorded)" disabled={saving} onClick={() => { setReleaseReason(""); setReleaseRow(row); }}><Unlock className="size-3.5" /> Release</Button> : null}
              </span>
            ))}
          </span>
        ) : null}
        {rows.length ? (
          <span className="block space-y-0.5 font-medium text-slate-700 dark:text-slate-200">
            {rows.map((row) => {
              const clock = runClock(row.started_at, row.booking_id ? runBookings?.get(row.booking_id) : planBooking(runPlan?.get(runPlanKey(row.job_id, row.machine_id))), now);
              return clock ? <span key={row.run_id} data-testid="run-timer" className="block">{row.machine_name}: {runTimerText(clock)}</span> : null;
            })}
          </span>
        ) : null}
        {view.running && view.bench ? <span data-testid="machine-na" className="block font-semibold text-slate-700 dark:text-slate-200">N/A (bench)</span> : null}
        {view.running && view.bench && !rows.length && benchByJob.get(job.id)?.is_open ? (() => {
          const clock = runClock(benchByJob.get(job.id)!.started_at, null, now);
          return clock ? <span data-testid="run-timer" className="block font-medium text-slate-700 dark:text-slate-200">Bench: {runTimerText(clock)}</span> : null;
        })() : null}
        {!view.running && benchPaused(job) && !job.finished_at ? <span data-testid="machine-na" className="block text-slate-600 dark:text-slate-300">N/A (bench)</span> : null}
        {waiting ? <span data-testid="run-waiting" className="block font-medium text-amber-800 dark:text-amber-300">{waiting}</span> : null}
        {canPick ? picker(view.running) : null}
        {machineChips(job)}
        {!rows.length && !canPick && !machinesByJob.get(job.id)?.length && !benchPaused(job) ? <span className="text-slate-400">—</span> : null}
      </div>
    );
  };
  /**
   * The Operator column (plan 2.4): "You", the assignee's name or "Unassigned"; "On it now: Dave" when the person running it is someone
   * else; "Paused by Dave 12:05" while paused. Admin and office assign from a select; workshop takes or hands back their own job.
   */
  const operatorCell = (job: WorkshopJob) => {
    const me = profile?.id;
    // Someone with no display name is still shown as assigned, never as a bare "—" (they are prompted to add a name).
    const named = job.assigned_to && job.assigned_to !== me ? personName(people, job.assigned_to) : null;
    const name = job.assigned_to ? (job.assigned_to === me ? "You" : named === UNKNOWN ? NAME_NOT_SET : named) : null;
    const canPick = (activeRole === "admin" || activeRole === "office") && !job.inspected_at;
    const runners = [...new Set((live.byJob.get(job.id) ?? []).filter((row) => row.operator_id && row.operator_id !== job.assigned_to).map((row) => row.operator_name ?? "someone"))];
    const benchRow = benchByJob.get(job.id);
    if (benchRow?.is_open && benchRow.operator_id && benchRow.operator_id !== job.assigned_to) runners.push(benchRow.operator_name ?? "someone");
    const state = playOf(job);
    const pausedRow = paused.find((row) => row.job_id === job.id);
    const pausedBy = state.kind === "paused" && !viewOf(job).waiting
      ? pausedRow ? `Paused by ${pausedRow.paused_by_name ?? pausedRow.operator_name ?? "someone"} ${new Date(pausedRow.paused_at).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })}`
        : benchRow && !benchRow.is_open && benchRow.ended_at && benchRow.end_reason === "paused" ? `Paused ${new Date(benchRow.ended_at).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })}` : null
      : null;
    return (
      <span data-testid="job-assignee" className="flex flex-wrap items-center gap-1 font-sans text-xs font-normal text-slate-600 dark:text-slate-300">
        {name ? <>Assigned to <span className="font-semibold text-ink" data-testid="job-operator">{name}</span></> : <span className="text-slate-400" data-testid="job-operator">Unassigned</span>}
        {canPick ? (
          <select aria-label={`Assign ${job.job_no}`} className="ml-1 min-h-12 max-w-full rounded-none border border-slate-300 bg-white px-1 py-0.5 text-xs dark:bg-slate-900" value={job.assigned_to ?? ""} disabled={saving} onChange={(event) => assignJob(job, event.target.value || null)}>
            <option value="">Unassigned</option>
            {assignable.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}
          </select>
        ) : null}
        {activeRole === "workshop" && me && !job.inspected_at ? (
          job.assigned_to === me
            ? <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", rowTouch)} disabled={saving} onClick={() => assignJob(job, null)}>Hand back</Button>
            : <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", rowTouch)} disabled={saving} onClick={() => assignJob(job, me)}>Take this job</Button>
        ) : null}
        {runners.length ? <span data-testid="on-it-now" className="block w-full">On it now: {runners.join(", ")}</span> : null}
        {pausedBy ? <span data-testid="paused-by" className="block w-full">{pausedBy}</span> : null}
      </span>
    );
  };
  /** The board grouped by machine when asked: a job under each machine it is planned for or running on; "No machine" for the rest. */
  const sections = useMemo(() => {
    if (groupBy !== "machine") return [{ key: "all", title: "", jobs: visible }];
    return groupJobsByMachine(visible, (job) => [
      ...(machinesByJob.get(job.id) ?? []).map((chip) => ({ machine_id: chip.machine_id, name: chip.name })),
      ...(live.byJob.get(job.id) ?? []).map((row) => ({ machine_id: row.machine_id, name: row.machine_name })),
    ]);
  }, [groupBy, visible, machinesByJob, live]);
  const groupHeading = (title: string, count: number) => <BoardHeading data-testid="machine-group">{title} <span className="font-normal text-muted-foreground">({count})</span></BoardHeading>;

  // The headline counts. Open = Not started + Running + Waiting for inspection (Complete is not open; an unfinished job is never
  // archived). Complete counts the Complete jobs not archived, as the Complete tab does. The due-date chips count Not started and
  // Running jobs only (the jobs a due-date light is shown on), and say so.
  const statusCount = (status: JobStatusKey) => jobs.filter((job) => jobStatusOf(job) === status && showOf(job) !== "archived").length;
  const openCount = jobs.filter((job) => showOf(job) === "active").length;
  const dueScopeJobs = jobs.filter((job) => inDueScope(job));
  const dueCount = (status: string) => dueScopeJobs.filter((job) => jobMatchesStatus(job, status)).length;
  const reworkCount = jobs.filter((job) => reworkTag(job) !== null).length;
  /** A status tile: only that status, on its tab (Open, or Complete). The Open jobs tile and the Show tabs go back to every status. */
  const pickStatus = (status: JobStatusKey) => {
    setStatusTile(status);
    setShow(status === "complete" ? "done" : "active");
    // Rework is a tag on Running jobs: kept only with the Running tile.
    if (status !== "running") setReworkOnly(false);
  };
  /** The Rework chip: only the Running jobs tagged Rework (on the Open tab when Complete or Archived was showing). */
  const toggleRework = () => {
    if (reworkOnly) { setReworkOnly(false); return; }
    setReworkOnly(true);
    if (statusTile !== "running") setStatusTile(null);
    if (show === "done" || show === "archived") setShow("active");
  };
  const avgDays = averageJobDays(jobs);
  const stat = (n: number) => (loading || loadError ? "\u2014" : String(n));
  const tileCompact = "max-xl:px-4 max-xl:py-3";
  const tileValueCompact = "max-xl:mt-2 max-xl:text-2xl";

  // Table and List cells keyed by the shared column list (lib/job-board-files), so a row renders exactly the headers shown:
  // a column the picker hides goes from the header and every row together.
  const tableCellsFor = (job: WorkshopJob): Record<string, React.ReactNode> => ({
    ref: (
      <TableCell className="font-mono font-semibold whitespace-normal"><span className="flex flex-wrap items-center gap-1">{job.job_no}{job.is_internal ? <InternalBadge /> : null}</span>{relatedLinks(job)}</TableCell>
    ),
    customer: (
      <TableCell className="whitespace-normal"><span className="block break-words">{job.customer}</span></TableCell>
    ),
    description: (
      <TableCell className="whitespace-normal"><span data-testid="job-description" className="block break-words">{boardDescription(job.description, job.specification)}</span></TableCell>
    ),
    specification: (
      <TableCell className="whitespace-normal break-words text-xs text-slate-600 dark:text-slate-300">{job.specification || "None recorded"}</TableCell>
    ),
    drawings: (
      <TableCell className="whitespace-normal break-words text-xs text-brand"><FileNames names={jobBoardFiles(job, filesByJob).drawings} empty="None" testId="job-drawings" /></TableCell>
    ),
    attachments: (
      <TableCell className="whitespace-normal break-words text-xs text-slate-600 dark:text-slate-300"><FileNames names={jobBoardFiles(job, filesByJob).attachments} empty="None" testId="job-attachments" /></TableCell>
    ),
    stage: (
      <TableCell className="min-w-0 whitespace-normal break-words">{stageLabel(job.stage)}</TableCell>
    ),
    machine: (
      <TableCell className="whitespace-normal">{machineCell(job)}</TableCell>
    ),
    operator: (
      <TableCell className="whitespace-normal">{operatorCell(job)}</TableCell>
    ),
    due: (
      <TableCell className="min-w-0 whitespace-normal break-words"><span className="block"><CalendarDays className="mr-1 inline size-4" />{showDate(job.due_date) || DUE_LABEL.no_due_date}</span><JobStatusBadges job={job} progress={statusOf(job)} failedUndecided={failedUndecided(job)} paused={isPaused(job)} wrap /></TableCell>
    ),
    started: (
      <TableCell className="min-w-0 whitespace-normal break-words">{job.started_at ? fmtDateTime(job.started_at) : "Not started"}</TableCell>
    ),
    finished: (
      <TableCell className="min-w-0 whitespace-normal break-words">{job.finished_at ? fmtDateTime(job.finished_at) : "Not finished"}</TableCell>
    ),
    inspection: (
      <TableCell className="min-w-0 whitespace-normal break-words text-xs text-slate-600 dark:text-slate-300">{job.finished_at ? inspectionNote(job) : "Not finished"}
        {reworkNote(job) ? <span className="mt-1 block">Rework: {reworkNote(job)}</span> : null}</TableCell>
    ),
    actions: (
      <TableCell className="whitespace-normal"><div className="flex flex-wrap items-center gap-2">
        {playButton(job)}
        {finishCheck(job, actionContext).shown ? <Button size="sm" variant="finish" className={cn(primaryTouch, saving || !finishCheck(job, actionContext).enabled ? "opacity-50" : "")} aria-disabled={saving || !finishCheck(job, actionContext).enabled || undefined} title={finishCheck(job, actionContext).reason || "Finish"} onClick={() => (!finishCheck(job, actionContext).enabled ? toast.info(`${job.job_no}: ${finishCheck(job, actionContext).reason}`) : askFinish(job.id))}>{job.finished_at ? "Finished" : "Finish"}</Button> : null}
                {isViewer || !inspectOffered || !job.finished_at || job.inspected_at || (inRework(job) && activeRole !== "admin") ? null : <Button size="sm" variant="outline" className={rowTouch} disabled={saving} onClick={() => setInspectJob(job)}><ShieldCheck className="size-4 text-orange-600 dark:text-orange-400" /> Inspected</Button>}
                {reopenOf(job).allowed ? <Button size="sm" variant="outline" className={rowTouch} disabled={saving} onClick={() => setReopenFor(job)}><RotateCcw className="size-4" /> Reopen</Button> : null}
        {releaseButton(job)}
        {hasRework(job) ? <Button size="sm" variant="outline" className={rowTouch} onClick={() => setReworkJob(job)}><Wrench className="size-4" /> Rework</Button> : null}
        <Button size="sm" variant="outline" className={rowTouch} onClick={() => setWorksheetJob(job)}><ClipboardList className="size-4" /> Worksheet</Button>
        {isViewer ? null : <Button size="sm" variant="outline" className={rowTouch} aria-label={`Machines for ${job.job_no}`} onClick={() => setMachineJob(job)}><Cog className="size-4" /> Machines</Button>}
        <Button asChild size="sm" variant="outline" className={rowTouch}><Link href={`/jobs/${job.id}/print`}><Printer className="size-4" /> Print</Link></Button>
        {canOfferJobDeliveryNote(activeRole, job) ? <Button size="sm" variant="outline" className={rowTouch} onClick={() => setDeliveryNoteJob(job)}><Truck className="size-4" /> Delivery note</Button> : null}
        {canSend ? <Button size="sm" className={cn("bg-brand text-brand-ink", rowTouch)} disabled={saving} onClick={() => openSend(job)}><Mail className="size-4" /> Send</Button> : null}
        {archive.canManage && job.inspected_at ? archiveButton(job) : null}
      </div></TableCell>
    ),
  });
  const listCellsFor = (job: WorkshopJob): Record<string, React.ReactNode> => ({
    ref: (
      <TableCell className="font-mono font-semibold whitespace-normal"><span data-testid="job-no-cell" className="flex min-w-0 flex-wrap items-center gap-x-1"><span className="min-w-0 [overflow-wrap:anywhere]" title={job.job_no}>{job.job_no}</span>{job.is_internal ? <InternalBadge /> : null}</span>{relatedLinks(job)}</TableCell>
    ),
    customer: (
      <TableCell className="whitespace-normal"><span className="block break-words">{job.customer}</span></TableCell>
    ),
    description: (
      <TableCell className="whitespace-normal"><span className="block break-words text-slate-600 dark:text-slate-300">{boardDescription(job.description, job.specification)}</span></TableCell>
    ),
    specification: (
      <TableCell className="whitespace-normal break-words text-xs text-slate-600 dark:text-slate-300">{job.specification || "None recorded"}</TableCell>
    ),
    drawings: (
      <TableCell className="whitespace-normal break-words text-xs text-brand"><FileNames names={jobBoardFiles(job, filesByJob).drawings} empty="None" testId="job-drawings" /></TableCell>
    ),
    attachments: (
      <TableCell className="whitespace-normal break-words text-xs text-slate-600 dark:text-slate-300"><FileNames names={jobBoardFiles(job, filesByJob).attachments} empty="None" testId="job-attachments" /></TableCell>
    ),
    stage: (
      <TableCell className="whitespace-normal"><span className="block min-w-0 truncate break-words">{stageLabel(job.stage)}</span><span data-testid="job-progress" className="block min-w-0 [overflow-wrap:anywhere] text-xs text-slate-500 dark:text-slate-400">{statusOf(job)}</span></TableCell>
    ),
    machine: (
      <TableCell className="whitespace-normal">{machineCell(job)}</TableCell>
    ),
    operator: (
      <TableCell className="whitespace-normal">{operatorCell(job)}</TableCell>
    ),
    due: (
      <TableCell data-testid="due-status-cell" className="whitespace-normal"><span className="flex min-w-0 flex-col items-start gap-0.5">{job.due_date ? <span className="block whitespace-nowrap font-medium">{showDate(job.due_date)}</span> : null}<JobStatusBadges job={job} failedUndecided={failedUndecided(job)} compact paused={isPaused(job)} /></span></TableCell>
    ),
    started: (
      <TableCell className="min-w-0 whitespace-normal break-words">{job.started_at ? fmtDateTime(job.started_at) : "Not started"}</TableCell>
    ),
    finished: (
      <TableCell className="min-w-0 whitespace-normal break-words">{job.finished_at ? fmtDateTime(job.finished_at) : "Not finished"}</TableCell>
    ),
    inspection: (
      <TableCell className="min-w-0 whitespace-normal break-words text-xs text-slate-600 dark:text-slate-300">{job.finished_at ? inspectionNote(job) : "Not finished"}
        {reworkNote(job) ? <span className="mt-1 block">Rework: {reworkNote(job)}</span> : null}</TableCell>
    ),
    actions: (
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1 pointer-coarse:gap-2">
          {playButton(job)}
          {finishCheck(job, actionContext).shown ? rowAction({ label: job.finished_at ? "Finished" : "Finish", variant: "finish", primary: true, title: job.finished_at ? `Finished ${fmtDateTime(job.finished_at)}` : finishCheck(job, actionContext).reason || "Finish", icon: <CheckCheck className="size-4" />, disabled: saving || !finishCheck(job, actionContext).enabled, onClick: () => askFinish(job.id) }) : null}
          {isViewer || (!inspectOffered && !job.inspected_at) ? null : rowAction({ label: "Inspected", title: job.inspected_at ? `Inspected ${fmtDateTime(job.inspected_at)}${job.inspected_by ? ` by ${cleanName(job.inspected_by) ?? UNKNOWN}` : ""}` : inRework(job) ? (activeRole === "admin" ? "In rework: an admin can record a concession" : "In rework: finish the rework first") : job.finished_at ? "Record inspection" : "Finish the job first", icon: <ShieldCheck className="size-4 text-orange-600 dark:text-orange-400" />, disabled: saving || !job.finished_at || Boolean(job.inspected_at) || (inRework(job) && activeRole !== "admin"), onClick: () => setInspectJob(job) })}
          {reopenOf(job).allowed ? rowAction({ label: "Reopen", title: "Reopen: back to Running, with a reason", icon: <RotateCcw className="size-4" />, disabled: saving, onClick: () => setReopenFor(job) }) : null}
          {hasRework(job) ? rowAction({ label: "Rework", title: inRework(job) ? "Rework: open the failed inspection's rework" : "Rework history", icon: <Wrench className="size-4" />, onClick: () => setReworkJob(job) }) : null}
          {rowAction({ label: "Worksheet", title: "Worksheet", icon: <ClipboardList className="size-4" />, onClick: () => setWorksheetJob(job) })}
          {isViewer ? null : rowAction({ label: "Machines", title: "Machines and hours", icon: <Cog className="size-4" />, onClick: () => setMachineJob(job) })}
          <Button asChild size="sm" variant="outline" className={cn("px-3", rowTouch)}><Link href={`/jobs/${job.id}/print`} aria-label="Print"><Printer className="size-4" /><span aria-hidden>Print</span></Link></Button>
          {canOfferJobDeliveryNote(activeRole, job) ? rowAction({ label: "Delivery note", title: "Make a delivery note from this job", icon: <Truck className="size-4" />, onClick: () => setDeliveryNoteJob(job) }) : null}
          {canSend ? rowAction({ label: "Send", title: "Send to workshop", icon: <Mail className="size-4" />, variant: "default", className: "bg-brand text-brand-ink", disabled: saving, onClick: () => openSend(job) }) : null}
        </div>
      </TableCell>
    ),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Job Board</h1>
          <p className="mt-2 text-sm text-slate-500">Jobs are the work in the workshop. Follow each one from start to finish.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ColumnToggle tableKey="jobs" />
          <ViewSwitcher value={view} onChange={setView} buttonClassName={workshop ? "pointer-coarse:min-h-12 pointer-coarse:min-w-12" : ""} />
          {isViewer ? null : <Button className={cn("min-h-11 bg-brand text-brand-ink", secondaryTouch)} onClick={() => setNewJobOpen(true)}><Plus className="size-4" /> New job</Button>}
        </div>
      </div>

      {loadError ? (
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{loadError}</p><Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></CardContent></Card>
      ) : null}

      {/* Below desktop width (tablets) the tiles are shorter and three to a row, so the list starts higher up the screen. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 xl:gap-4">
        <StatTile label="Open jobs" value={stat(openCount)} tone="neutral" className={tileCompact} valueClassName={tileValueCompact} labelClassName={BOARD_KPI_LABEL} sub="Not started, running or waiting" hint="Not started + Running + Waiting for inspection. Complete jobs are not counted." active={show === "active" && !statusTile} onClick={() => { setStatusTile(null); setShow("active"); }} />
        {([
          ["not_started", "neutral", "No work yet", "Open: no work started yet"],
          // Each sub says on screen what the tile's hover hint says (rework included, not archived), so the hint adds nothing hidden.
          ["running", "info", "In progress, rework included", "Open: started, not finished (rework included)"],
          ["waiting_for_inspection", "warn", "Finished, not passed", "Open: finished, not yet passed"],
          ["complete", "good", "Passed, not archived", "Passed inspection; not archived"],
        ] as const).map(([status, tone, sub, hint]) => (
          <StatTile key={status} label={JOB_STATUS_LABELS[status]} value={stat(statusCount(status))} tone={tone} className={tileCompact} valueClassName={tileValueCompact} labelClassName={BOARD_KPI_LABEL} sub={sub} hint={hint} active={statusTile === status} onClick={() => pickStatus(status)} />
        ))}
        <StatTile
          className={tileCompact}
          valueClassName={tileValueCompact}
          labelClassName={BOARD_KPI_LABEL}
          label="Average job time"
          value={formatAverageJobTime(avgDays, timeUnit)}
          sub={<span className="flex flex-wrap items-center gap-1">Start to finish.{" "}
            {(["hours", "days"] as const).map((unit) => (
              <button key={unit} type="button" aria-pressed={timeUnit === unit} onClick={() => chooseTimeUnit(unit)} className={`rounded-none px-1.5 py-0.5 text-xs font-semibold ${workshop ? "pointer-coarse:min-h-12 pointer-coarse:min-w-12" : "pointer-coarse:min-h-11 pointer-coarse:min-w-11"} ${timeUnit === unit ? "bg-brand text-brand-ink" : "border border-slate-300 text-slate-600 dark:text-slate-300"}`}>{unit === "hours" ? "Hours" : "Days"}</button>
            ))}</span>}
        />
      </div>

      {/* Every filter row has the same fixed label column (components/board-heading), so the labels line up at every width. */}
      <div className="space-y-3">
      <BoardFilterRow label="Show">
          {([["active", `Open (${openCount})`], ["done", `Complete (${jobs.filter((job) => showOf(job) === "done").length})`], ["archived", `Archived (${jobs.filter((job) => showOf(job) === "archived").length})`], ["all", "All"]] as const).map(([value, text]) => (
            <Button key={value} size="sm" variant={show === value ? "default" : "outline"} aria-pressed={show === value} className={cn(show === value ? "bg-brand text-brand-ink" : "", secondaryTouch)} onClick={() => { setStatusTile(null); setShow(value); }}>{text}</Button>
          ))}
      </BoardFilterRow>
      <BoardFilterRow label="Type" groupLabel="Job type">
          {([["all", "All"], ["customer", "Customer"], ["internal", `Internal (${jobs.filter((job) => job.is_internal).length})`]] as const).map(([value, text]) => (
            <Button key={value} size="sm" variant={jobType === value ? "default" : "outline"} aria-pressed={jobType === value} className={cn(jobType === value ? "bg-brand text-brand-ink" : "", secondaryTouch)} onClick={() => setJobType(value)}>{text}</Button>
          ))}
      </BoardFilterRow>
      <BoardFilterRow label="Group" groupLabel="Group by">
          {([["none", "None"], ["machine", "Machine"]] as const).map(([value, text]) => (
            <Button key={value} size="sm" variant={groupBy === value ? "default" : "outline"} aria-pressed={groupBy === value} className={cn(groupBy === value ? "bg-brand text-brand-ink" : "", secondaryTouch)} onClick={() => setGroupBy(value)}>{text}</Button>
          ))}
      </BoardFilterRow>
      {listFilter ? <ListFilterNotice label={JOB_FILTER_LABELS[listFilter] ?? listFilter} onClear={clearListFilter} /> : null}
      <FilterBar variant="board" label="Due" groupLabel="Due (Not started and Running jobs)" note="Not started and Running jobs only" activeValues={[...statusFilters]} options={[{ label: "All", value: "all" }, ...DUE_CHIPS.map((chip) => ({ label: `${chip.label} (${stat(dueCount(chip.value))})`, value: chip.value }))]} onChange={setStatusFilters} />
      {/* What the tag means is written beside the chip (note), not left to a hover title. */}
      <BoardFilterRow label="Tag" note="Running jobs put back after a failed inspection (or for replacements)">
        <button type="button" aria-pressed={reworkOnly} onClick={toggleRework}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-none border px-3.5 text-[0.82rem] transition pointer-coarse:min-h-11", reworkOnly ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink/70 hover:border-ink/25 hover:text-ink")}>
          <span aria-hidden className={cn("size-2 rounded-none", COLOUR_CLASSES.purple.dot)} />{`Rework (${stat(reworkCount)})`}
        </button>
      </BoardFilterRow>
      <FilterBar variant="board" label="Stage" activeValues={[...stageFilters]} defaultActive={[]} options={JOB_STAGES.map((stage) => ({ label: STAGE_LABELS[stage], value: stage }))} onChange={setStageFilters} />
      </div>

      {/* With a job ticked, the selection bar sticks just below the app's top bar (components/topbar: sticky top-0, h-16) while the
          board scrolls, in the brand navy with light text. Its padding is there unticked too, so ticking a job moves nothing.
          On a phone (below sm) the toolbar is three columns, ticked or not, so the bar is two rows of 48px controls instead of
          four wrapped lines: the same buttons in the same order, their words wrapping inside them. */}
      <div data-testid="selection-bar" data-selected={selectedIds.length ? "true" : undefined} className={cn("-mx-2 p-2", SELECTION_BAR_PHONE, selectedIds.length ? "sticky top-16 z-20 bg-brand text-brand-ink [&_[role=status]]:text-brand-ink" : "")}>
      <ListToolbar
        visibleCount={visible.length}
        selectedCount={selectedIds.length}
        disableEmptyButtons
        buttonClassName={rowTouch}
        statusText={<span data-testid="selection-summary"><strong className={cn("font-semibold", selectedIds.length ? "" : "text-ink")}>{selectedIds.length} selected</strong>{` of ${visible.length} filtered job${visible.length === 1 ? "" : "s"}.`}</span>}
        onSelectAll={() => setSelectedIds(visible.map((job) => job.id))}
        onClear={() => setSelectedIds([])}
        onPrint={printWorkshopPack}
        printLabel="Print Workshop Pack"
        exports={[
          { label: "CSV", title: scopeTitle, onSelect: () => void exportSpreadsheet("csv", "Jobs", JOB_COLUMNS, exportScope, "jobs") },
          { label: "Excel", title: scopeTitle, onSelect: () => void exportSpreadsheet("xlsx", "Jobs", JOB_COLUMNS, exportScope, "jobs") },
          { label: "Word", title: scopeTitle, onSelect: () => void exportRows("word", EXPORT_TITLES.jobs, selectedJobRows(), "jobs") },
          { label: "PDF", title: scopeTitle, onSelect: () => void exportRows("pdf", EXPORT_TITLES.jobs, selectedJobRows(), "jobs") },
        ]}
        actions={isViewer ? null : (
          <>
            <Button disabled={saving || !selectedIds.length || Boolean(finishBlocked)} className={cn(primaryTouch, workshop ? "pointer-coarse:min-h-16" : "")} title={selectedIds.length ? finishBlocked ?? undefined : "Select at least one job first"} variant="finish" onClick={() => setBulkKind("finish")}>{`Finish Selected (${selectedIds.length})`}</Button>
            {/* A disabled button shows no title on a tap: why Finish Selected can't be used is written beside it. */}
            {selectedIds.length && finishBlocked ? <span data-testid="finish-blocked" className="text-sm">{`${finishBlocked}.`}</span> : null}
          </>
        )}
      />
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {hiddenSelected ? `${hiddenSelected} selected job${hiddenSelected === 1 ? " isn't" : "s aren't"} shown by the current filters. Print, export, Start and Finish apply to everything selected.` : "Print, export, Start and Finish apply to the selected jobs only."}
        {/* The Export menu's scope, on screen as well as in its items' hover titles. */}
        {` ${scopeTitle}.`}
      </p>

      {!loading && !loadError && !jobs.length ? (
        <Card><CardContent className="p-8 text-center text-sm text-slate-500" data-testid="empty-hint">{jobsEmptyHint(activeRole)}</CardContent></Card>
      ) : null}

      {view === "table" ? (
      <Card className="hidden md:block">
        <CardContent className="p-0">
          <Table className="table-fixed board-sticky">
            <TableHeader className={BOARD_TABLE_HEADINGS}>
              <TableRow>
                <TableHead className="w-10 pointer-coarse:w-14"><SelectBox boxClassName={boxTouch} aria-label={`Select all ${visible.length} filtered jobs`} checked={allFilteredSelected} onChange={(event) => setSelectedIds(event.target.checked ? visible.map((job) => job.id) : selectedIds.filter((id) => !visibleIds.has(id)))} /></TableHead>
                {jobColumns.map((column) => <TableHead key={column.key} className={column.width}>{column.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sections.flatMap((section) => [
                ...(section.title ? [<TableRow key={`group-${section.key}`} data-group-row="" className="bg-slate-100/80 dark:bg-white/5"><TableCell colSpan={jobColumns.length + 1}>{groupHeading(section.title, section.jobs.length)}</TableCell></TableRow>] : []),
                ...section.jobs.map((job) => (
                <TableRow key={`${section.key}-${job.id}`} data-job-id={job.id} data-highlighted={highlightId === job.id ? "true" : undefined} className={highlight(job)}>
                  <TableCell><SelectBox boxClassName={boxTouch} aria-label={`Select ${job.job_no}`} checked={selectedSet.has(job.id)} onChange={() => toggleSelected(job.id)} /></TableCell>
                  {((cells) => jobColumns.map((column) => <Fragment key={column.key}>{cells[column.key]}</Fragment>))(tableCellsFor(job))}
                </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      ) : null}

      {view === "list" ? (
        <Card className="hidden md:block">
          <CardContent className="p-0">
            {/* Compact rows; the same columns as the Table (the card scrolls sideways when they do not fit); progress, release and archive on expand. */}
            <Table className="table-fixed board-sticky-list" aria-label="Jobs">
              <TableHeader className={BOARD_TABLE_HEADINGS}>
                <TableRow>
                  <TableHead className="w-9 pointer-coarse:w-14"><SelectBox boxClassName={boxTouch} aria-label={`Select all ${visible.length} filtered jobs`} checked={allFilteredSelected} onChange={(event) => setSelectedIds(event.target.checked ? visible.map((job) => job.id) : selectedIds.filter((id) => !visibleIds.has(id)))} /></TableHead>
                  <TableHead className="w-8 pointer-coarse:w-14"><span className="sr-only">Details</span></TableHead>
                  {/* The same fields in the same order as the Table and the Cards (columns parity), from the one shared list. */}
                  {jobColumns.map((column) => column.key === "actions"
                    ? <TableHead key={column.key} className={isViewer ? "w-40" : "w-[22rem]"}><span className="sr-only">Actions</span></TableHead>
                    : <TableHead key={column.key} className={column.listWidth}>{column.label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sections.flatMap((section) => [
                  ...(section.title ? [<TableRow key={`group-${section.key}`} data-group-row="" className="bg-slate-100/80 dark:bg-white/5"><TableCell colSpan={jobColumns.length + 2}>{groupHeading(section.title, section.jobs.length)}</TableCell></TableRow>] : []),
                  ...section.jobs.map((job) => {
                  const open = expandedIds.includes(job.id);
                  const listCells = listCellsFor(job);
                  return (
                    <Fragment key={`${section.key}-${job.id}`}>
                      <TableRow data-job-id={job.id} data-highlighted={highlightId === job.id ? "true" : undefined} className={highlight(job)}>
                        <TableCell><SelectBox boxClassName={boxTouch} aria-label={`Select ${job.job_no}`} checked={selectedSet.has(job.id)} onChange={() => toggleSelected(job.id)} /></TableCell>
                        <TableCell className="px-0"><Button size="icon-sm" variant="ghost" className={cn("min-h-12", workshop ? "pointer-coarse:size-12" : "")} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} details for ${job.job_no}`} onClick={() => setExpandedIds((current) => (open ? current.filter((id) => id !== job.id) : [...current, job.id]))}><ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} /></Button></TableCell>
                        {jobColumns.map((column) => <Fragment key={column.key}>{listCells[column.key]}</Fragment>)}
                      </TableRow>
                      {open ? (
                        <TableRow className="bg-slate-50/70 dark:bg-white/5">
                          <TableCell />
                          <TableCell colSpan={jobColumns.length + 1} className="whitespace-normal text-xs text-slate-600 dark:text-slate-300">
                            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                              <div><dt className="field-label inline">Progress: </dt><dd className="inline">{statusOf(job)}</dd></div>
                              {releaseOffered(job) ? <div>{releaseButton(job)}</div> : null}
                              {archive.canManage && job.inspected_at ? <div>{archiveButton(job)}</div> : null}
                            </dl>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                  }),
                ])}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {view === "cards" ? (
        <div className="hidden space-y-4 md:block">
          {sections.map((section) => (
            <div key={section.key} className="space-y-2">
              {section.title ? <h2 className="px-1">{groupHeading(section.title, section.jobs.length)}</h2> : null}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{section.jobs.map((job) => jobCard(job))}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-3 md:hidden">
        {sections.map((section) => (
          <div key={section.key} className="space-y-3">
            {section.title ? <h2 className="px-1">{groupHeading(section.title, section.jobs.length)}</h2> : null}
            {section.jobs.map((job) => jobCard(job, true))}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(confirmOne && confirmOneJob)}
        title={confirmOne && confirmOneJob ? `${confirmOne.kind === "pause" ? "Pause" : "Finish"} ${confirmOneJob.job_no}?` : "Confirm"}
        description={confirmOne ? `Are you sure you want to ${confirmOne.kind === "pause" ? "pause" : "finish"} this job?` : ""}
        confirmLabel={confirmOne?.kind === "pause" ? "Pause job" : "Finish job"}
        busy={saving}
        onCancel={() => setConfirmOne(null)}
        onConfirm={confirmOneAction}
      />

      <ConfirmDialog
        open={Boolean(bulkKind && bulkPlan)}
        title={bulkPlan && bulkKind ? (bulkPlan.targets.length ? `Finish ${bulkPlan.targets.length} selected job${bulkPlan.targets.length === 1 ? "" : "s"}?` : "No selected job can be finished") : "Bulk action"}
        description={bulkPlan && bulkKind ? (
          <div className="space-y-3 text-sm" data-testid="bulk-confirm">
            {bulkPlan.targets.length ? (
              <p data-testid="bulk-targets"><span className="font-semibold">Will be finished ({bulkPlan.targets.length}):</span> <span className="font-mono">{summariseJobNumbers(bulkPlan.targets.map(({ job }) => job.job_no))}</span></p>
            ) : <p>Every selected job is already finished, or is in rework.</p>}
            {bulkPlan.skipped.length ? (
              <p data-testid="bulk-skipped"><span className="font-semibold">Left as they are ({bulkPlan.skipped.length}):</span> <span className="font-mono">{summariseJobNumbers(bulkPlan.skipped.map(({ job }) => job.job_no))}</span>. Recorded start and finish times are never replaced.</p>
            ) : null}
            {bulkPlan.targets.some(({ job }) => !visibleIds.has(job.id)) ? <p>{bulkPlan.targets.filter(({ job }) => !visibleIds.has(job.id)).length} of these are selected but not shown by the current filters.</p> : null}
            <p className="text-slate-500">Only the {selectedIds.length} selected job{selectedIds.length === 1 ? "" : "s"} are affected, not every filtered job.</p>
          </div>
        ) : ""}
        confirmLabel={bulkPlan && bulkKind ? `Finish ${bulkPlan.targets.length} job${bulkPlan.targets.length === 1 ? "" : "s"}` : "Confirm"}
        confirmDisabled={!bulkPlan?.targets.length}
        busy={saving}
        onCancel={() => setBulkKind(null)}
        onConfirm={confirmBulk}
      />

      <Dialog open={Boolean(deliveryNoteJob)} onOpenChange={(open) => !open && setDeliveryNoteJob(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delivery note - {deliveryNoteJob?.job_no}</DialogTitle><DialogDescription>Made from this job&apos;s sales order for {deliveryNoteJob?.customer}, with the quantity despatched on each line.</DialogDescription></DialogHeader>
          {deliveryNoteJob ? <DespatchFromOrder key={deliveryNoteJob.id} source="job" presetId={deliveryNoteJob.id} onCreated={() => setDeliveryNoteJob(null)} /> : null}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(worksheetJob)} onOpenChange={(open) => !open && closeWorksheet()}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Worksheet - {worksheetJob?.job_no}</DialogTitle><DialogDescription>Single part worksheet. Fill in the shop-floor fields and save.</DialogDescription></DialogHeader>
          {worksheetJob && !worksheetJob.finished_at && (benchPaused(worksheetJob) || benchRunning(worksheetJob)) ? (
            <p data-testid="worksheet-bench" className="text-sm"><span className={cn("rounded-none px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide", benchPaused(worksheetJob) ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100")}>{benchPaused(worksheetJob) ? "Paused" : "Running"}</span> <span className="text-slate-600 dark:text-slate-300">{benchPaused(worksheetJob) ? "Start on the board resumes it." : "On the bench (no machine)."}</span></p>
          ) : null}
          {worksheetJob ? <JobWorksheetForm key={worksheetJob.id} job={{ id: worksheetJob.id, job_no: worksheetJob.job_no, customer: worksheetJob.customer, description: worksheetJob.description, due_date: worksheetJob.due_date, drawings: worksheetJob.drawings, customer_po: worksheetJob.customer_po, date_received: worksheetJob.date_received, date_required: worksheetJob.date_required, quote_ref: worksheetJob.quote_ref, quantity_required: worksheetJob.quantity_required, drawing_no: worksheetJob.drawing_no }} onDirtyChange={setWorksheetDirty} onSaved={(ws, row) => setJobs((current) => current.map((item) => (item.id === worksheetJob.id ? (row ? rowToJob(row) : { ...item, description: ws.description }) : item)))} /> : null}
        {worksheetJob ? <JobDrawingRevision key={`drawing-${worksheetJob.id}`} jobId={worksheetJob.id} role={activeRole} /> : null}
        {worksheetJob ? <JobPhotos key={`photos-${worksheetJob.id}`} jobId={worksheetJob.id} jobNo={worksheetJob.job_no} /> : null}
        <ActivityPanel table="jobs" recordId={worksheetJob?.id} className="mt-4" /></DialogContent>
      </Dialog>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved worksheet changes?</DialogTitle>
            <DialogDescription>You have changed this worksheet since it was last saved. Closing now loses those changes.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button variant="destructive" onClick={() => { setConfirmDiscard(false); setWorksheetDirty(false); setWorksheetJob(null); }}>Discard changes</Button>
          </div>
        </DialogContent>
      </Dialog>

      <NewJobDialog
        open={newJobOpen}
        role={activeRole}
        jobs={jobs.map((job) => ({ id: job.id, job_no: job.job_no, description: job.description }))}
        onClose={() => setNewJobOpen(false)}
        onCreated={(created) => {
          setNewJobOpen(false);
          toast.success(`${created.job_no} created`);
          setAttempt((n) => n + 1);
          goToJob(created.job_id);
        }}
      />

      <PausedMachineDialog
        key={prompt ? `${prompt.job.id}-${prompt.rows.map((r) => r.paused_run_id).join(",")}` : "none"}
        open={Boolean(prompt)}
        title={prompt ? (prompt.rows.length ? `Check before using ${prompt.rows.map((r) => machineName(r.machine_id)).join(", ")}` : `Take over for ${prompt.job.job_no}?`) : ""}
        rows={prompt?.rows ?? []}
        machineName={machineName}
        takeover={prompt?.takeover}
        busy={saving}
        onCancel={() => setPrompt(null)}
        onConfirm={(reason) => {
          if (!prompt) return;
          const { job, pick, rows, takeover } = prompt;
          setPrompt(null);
          startRun(job, pick, pausedAckPayload(rows), takeover.length > 0, reason);
        }}
      />

      <ConfirmDialog
        open={Boolean(releaseRow)}
        title={releaseRow ? `Release ${releaseRow.machine_name}?` : "Release machine"}
        description={releaseRow ? (
          <div className="space-y-2 text-sm">
            <p>{releaseRow.job_no} is recorded as using it{releaseRow.operator_name ? ` (${releaseRow.operator_name})` : ""} since {fmtDateTime(releaseRow.started_at)}. Releasing ends that run now; the time until now counts as run time. Say why (recorded).</p>
            <Textarea aria-label="Why?" placeholder="Why? (3 to 500 characters, recorded)" maxLength={500} value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} />
          </div>
        ) : ""}
        confirmLabel="Release machine"
        confirmDisabled={releaseReason.trim().length < 3}
        destructive
        busy={saving}
        onCancel={() => setReleaseRow(null)}
        onConfirm={() => releaseRow && releaseMachine(releaseRow, releaseReason.trim())}
      />

      <JobMachinesDialog job={machineJob ? { id: machineJob.id, job_no: machineJob.job_no } : null} role={activeRole} onClose={() => setMachineJob(null)} onSaved={() => { void loadJobMachines().then((map) => { if (map) setMachinesByJob(map); }); }} />

      <ReworkDialog job={reworkJob} role={activeRole} onClose={() => setReworkJob(null)} onChanged={() => setAttempt((n) => n + 1)} />

      <ReopenJobDialog job={reopenFor} onClose={() => setReopenFor(null)} onReopened={(job) => onReopened(job as WorkshopJob)} />
      <ReleaseEarlyDialog job={releaseFor} onClose={() => setReleaseFor(null)} onReleased={(message) => { setReleaseFor(null); toast.success(message); }} />
      <InspectionDialog job={inspectJob} isAdmin={activeRole === "admin"} onClose={() => setInspectJob(null)} onRecorded={(done) => inspectJob && onInspected(inspectJob, done)} />

      <Dialog open={Boolean(sendJob)} onOpenChange={(open) => !open && setSendJob(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Send {sendJob?.job_no} to Workshop</DialogTitle><DialogDescription>Email the job sheet to the workshop team.</DialogDescription></DialogHeader>
          {sendJob ? <form action={(formData) => sendToWorkshop(sendJob, formData)} className="space-y-3"><Input name="email" type="email" required placeholder="Workshop email" defaultValue={profile?.workshop_email ?? ""} /><Input name="subject" defaultValue={`JOB SHEET - ${sendJob.job_no} - ${sendJob.customer}`} /><Textarea name="body" defaultValue={`${sendJob.job_no}\n${sendJob.customer}\n${sendJob.description}\nDue: ${showDate(sendJob.due_date)}`} /><Button className="bg-brand text-brand-ink" disabled={saving}>{saving ? "Sending..." : "Send"}</Button></form> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
