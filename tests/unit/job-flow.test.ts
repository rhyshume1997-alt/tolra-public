/**
 * The job flow in the app (migration 081): In progress -> Finished -> Complete with no "Done", the colour badge for each state, who may
 * reopen, the draft invoice's words, what a delivery note may say about the inspection, the inspection call's arguments, and an
 * inspection kept offline replayed through inspect_job (a pass by the person who finished the job refused unless an admin's reason is in
 * it; a replay of the key answers the first record).
 */
import { describe, expect, it, vi } from "vitest";

import { friendlyError } from "@/lib/friendly-error";
import { deliveryNoteInspectionLine, inspectArgs } from "@/lib/inspection";
import { JOB_STATUS_LABELS, OPEN_JOBS_FILTER, REASON_MIN, RUNNING_JOBS_FILTER, confirmedFinishers, earlyReleaseOffered, finishesLeftQueue, flowBadge, flowStatusOf, isOpenJob, isPutBack, jobDraftStage, jobStatusOf, openJobsDueFilter, reopenCheck, reworkTag, sendEarlyRelease, stageLabel, stageOf } from "@/lib/job-flow";
import type { InspectOp } from "@/lib/offline/outbox";
import { executeInspectOp, INSPECTION_OTHER_USER_REASON, INSPECTION_UPGRADE_REASON } from "@/lib/offline/sync";
import { STATUS_MAP } from "@/lib/status-colours";

const at = "2026-10-20T10:00:00Z";

describe("flowStatusOf (the same rule as 081's public.flow_status)", () => {
  it("maps every job from its own row: In progress, Finished, Complete; rework is In progress, put back", () => {
    expect(flowStatusOf({})).toBe("in_progress");
    expect(flowStatusOf({ stage: "machining" })).toBe("in_progress");
    expect(flowStatusOf({ finished_at: at, stage: "inspection" })).toBe("finished");
    expect(flowStatusOf({ finished_at: at, inspected_at: at, stage: "complete" })).toBe("complete");
    // An imported job inspected without a finish time is Complete, as the board's "Done" was.
    expect(flowStatusOf({ inspected_at: at, stage: "complete" })).toBe("complete");
    expect(flowStatusOf({ finished_at: at, stage: "rework" })).toBe("in_progress");
    expect(isPutBack({ finished_at: at, stage: "rework" })).toBe(true);
    expect(isPutBack({ finished_at: at, stage: "inspection" })).toBe(false);
  });

  it("has no Done anywhere: the four statuses shown are Not started, Running, Waiting for inspection, Complete", () => {
    expect(Object.values(JOB_STATUS_LABELS)).toEqual(["Not started", "Running", "Waiting for inspection", "Complete"]);
    expect(Object.values(JOB_STATUS_LABELS).join(" ")).not.toMatch(/\bDone\b/);
    expect(Object.values(JOB_STATUS_LABELS).join(" ")).not.toMatch(/Rework|In progress/);
  });
});

describe("jobStatusOf (the four statuses shown, from the flow; nothing stored changes)", () => {
  it("Not started, Running, Waiting for inspection, Complete; a job in rework is Running, never a status of its own", () => {
    expect(jobStatusOf({})).toBe("not_started");
    expect(jobStatusOf({ stage: "material" })).toBe("not_started");
    expect(jobStatusOf({ stage: "machining", started_at: at })).toBe("running");
    expect(jobStatusOf({ finished_at: at, started_at: at, stage: "inspection" })).toBe("waiting_for_inspection");
    expect(jobStatusOf({ finished_at: at, inspected_at: at, stage: "complete" })).toBe("complete");
    expect(jobStatusOf({ inspected_at: at, stage: "complete" })).toBe("complete");
    expect(jobStatusOf({ finished_at: at, started_at: at, stage: "rework" })).toBe("running");
    expect(jobStatusOf({ finished_at: at, stage: "rework" })).toBe("running");
  });

  it("Open is everything not Complete, Waiting for inspection included", () => {
    expect(isOpenJob({})).toBe(true);
    expect(isOpenJob({ started_at: at })).toBe(true);
    expect(isOpenJob({ finished_at: at, stage: "inspection" })).toBe(true);
    expect(isOpenJob({ finished_at: at, stage: "rework" })).toBe(true);
    expect(isOpenJob({ finished_at: at, inspected_at: at, stage: "complete" })).toBe(false);
  });

  it("Rework is a purple tag on a Running job (red Failed inspection while its fail has no disposition); none on any other job", () => {
    expect(reworkTag({ finished_at: at, stage: "rework" })).toEqual({ status: "rework", label: "Rework" });
    expect(STATUS_MAP[reworkTag({ finished_at: at, stage: "rework" })!.status].colour).toBe("purple");
    expect(reworkTag({ finished_at: at, stage: "rework" }, true)).toEqual({ status: "failed_inspection", label: "Failed inspection" });
    expect(reworkTag({ finished_at: at, stage: "inspection" })).toBeNull();
    expect(reworkTag({ started_at: at, stage: "machining" })).toBeNull();
  });

  it("stages are Material, Setup, Machining, Inspection; rework and complete are not stages", () => {
    expect(["material", "setup", "machining", "inspection"].map(stageLabel)).toEqual(["Material", "Setup", "Machining", "Inspection"]);
    expect(stageLabel(null)).toBe("Material");
    expect(stageOf("rework")).toBeNull();
    expect(stageOf("complete")).toBeNull();
    expect(stageLabel("rework")).toBe("\u2014");
  });

  it("the dashboard's database filters say the same: Open is not Complete, Running is started or in rework, due dates within Open", () => {
    expect(OPEN_JOBS_FILTER).toBe("stage.eq.rework,inspected_at.is.null");
    expect(RUNNING_JOBS_FILTER).toBe("stage.eq.rework,and(finished_at.is.null,inspected_at.is.null,started_at.not.is.null)");
    expect(openJobsDueFilter("2026-10-21", "2026-10-28")).toBe([
      "and(stage.eq.rework,date_required.gte.2026-10-21,date_required.lte.2026-10-28)", "and(stage.eq.rework,due_date.gte.2026-10-21,due_date.lte.2026-10-28)",
      "and(inspected_at.is.null,date_required.gte.2026-10-21,date_required.lte.2026-10-28)", "and(inspected_at.is.null,due_date.gte.2026-10-21,due_date.lte.2026-10-28)",
    ].join(","));
  });
});

describe("flowBadge (PR 4's colour map, the four statuses)", () => {
  it("Complete green, Waiting for inspection yellow, Running blue, Not started grey; a failed inspection red and rework purple are tags", () => {
    const colour = (badge: { status: keyof typeof STATUS_MAP } | null) => (badge ? STATUS_MAP[badge.status].colour : null);
    expect(flowBadge({ finished_at: at, inspected_at: at, stage: "complete" })).toEqual({ status: "complete", label: "Complete" });
    expect(colour(flowBadge({ finished_at: at, inspected_at: at, stage: "complete" }))).toBe("green");
    expect(flowBadge({ finished_at: at, stage: "inspection" })).toEqual({ status: "awaiting_inspection", label: "Waiting for inspection" });
    expect(colour(flowBadge({ finished_at: at, stage: "inspection" }))).toBe("yellow");
    expect(colour(reworkTag({ finished_at: at, stage: "rework" }, true))).toBe("red");
    expect(colour(reworkTag({ finished_at: at, stage: "rework" }, false))).toBe("purple");
    expect(flowBadge({ finished_at: at, stage: "rework" })).toEqual({ status: "in_progress", label: "Running" });
    expect(colour(flowBadge({ stage: "machining", started_at: at }))).toBe("blue");
    expect(flowBadge({ stage: "machining" })).toEqual({ status: "not_started", label: "Not started" });
    expect(colour(flowBadge({ stage: "machining" }))).toBe("grey");
  });
});

describe("flowBadge for a paused job (display only)", () => {
  it("a started job whose Play state is Paused shows a yellow Paused chip, not Running; the status model is unchanged", () => {
    const running = { stage: "machining", started_at: at };
    expect(flowBadge(running)).toEqual({ status: "in_progress", label: "Running" });
    expect(flowBadge(running, { paused: true })).toEqual({ status: "waiting_on_supplier", label: "Paused" });
    expect(STATUS_MAP[flowBadge(running, { paused: true }).status].colour).toBe("yellow");
    expect(jobStatusOf(running)).toBe("running"); // tiles, filters and counts still treat it as Running
    expect(flowBadge(running, { paused: false })).toEqual(flowBadge(running));
  });

  it("paused changes nothing for a job that is not Running", () => {
    expect(flowBadge({ stage: "material" }, { paused: true })).toEqual({ status: "not_started", label: "Not started" });
    expect(flowBadge({ finished_at: at, stage: "inspection" }, { paused: true }).label).toBe("Waiting for inspection");
    expect(flowBadge({ finished_at: at, inspected_at: at, stage: "complete" }, { paused: true }).label).toBe("Complete");
  });
});

describe("reopenCheck (reopen_job's rules, shown before the server checks them again)", () => {
  const finished = { finished_at: at, stage: "inspection", finished_by: "me" };
  it("the person who finished it undoes their own Finish while it awaits inspection", () => {
    expect(reopenCheck(finished, { role: "workshop", me: "me" })).toEqual({ allowed: true, reason: "" });
    expect(reopenCheck({ ...finished, finished_by: "someone" }, { role: "workshop", me: "me" }).allowed).toBe(false);
    expect(reopenCheck({ ...finished, inspected_at: at, stage: "complete" }, { role: "workshop", me: "me" }).allowed).toBe(false);
  });
  it("the office or an admin reopens anyone's, a Complete job too; never a viewer, never a job in rework or not finished", () => {
    for (const role of ["office", "admin"]) {
      expect(reopenCheck({ ...finished, finished_by: "someone" }, { role, me: "me" }).allowed).toBe(true);
      expect(reopenCheck({ ...finished, inspected_at: at, stage: "complete" }, { role, me: "me" }).allowed).toBe(true);
      expect(reopenCheck({ ...finished, stage: "rework" }, { role, me: "me" }).allowed).toBe(false);
      expect(reopenCheck({ stage: "machining" }, { role, me: "me" }).allowed).toBe(false);
    }
    expect(reopenCheck(finished, { role: "viewer", me: "me" }).allowed).toBe(false);
  });
});

describe("jobDraftStage (one draft per job, numbered only when issued)", () => {
  it("Draft, awaiting inspection until the job is Complete, then Ready to issue; nothing for an issued invoice or a draft with no job", () => {
    expect(jobDraftStage({ status: "draft", job_id: "j" }, { finished_at: at, stage: "inspection" })).toBe("Draft, awaiting inspection");
    expect(jobDraftStage({ status: "draft", job_id: "j" }, { finished_at: at, stage: "rework" })).toBe("Draft, awaiting inspection");
    expect(jobDraftStage({ status: "draft", job_id: "j" }, { finished_at: at, inspected_at: at, stage: "complete" })).toBe("Ready to issue");
    expect(jobDraftStage({ status: "issued", job_id: "j" }, { inspected_at: at })).toBeNull();
    expect(jobDraftStage({ status: "draft", job_id: null }, { inspected_at: at })).toBeNull();
  });
});

describe("deliveryNoteInspectionLine", () => {
  it("says only Inspected/checked, the name and the date; never whether it was independent; nothing for a fail", () => {
    const line = deliveryNoteInspectionLine({ inspector_name: "Office Alpha", inspected_at: at, result: "pass", ...{ independent: false, override_reason: "Sole inspector" } } as never, () => "20/10/2026");
    expect(line).toBe("Inspected/checked by Office Alpha, 20/10/2026");
    expect(line).not.toMatch(/independent|Sole inspector/i);
    expect(deliveryNoteInspectionLine({ inspector_name: "x@y.z", inspected_at: at, result: "concession" }, () => "20/10/2026")).toBe("Inspected/checked, 20/10/2026");
    expect(deliveryNoteInspectionLine({ inspector_name: "A", inspected_at: at, result: "fail" }, () => "d")).toBeNull();
    expect(deliveryNoteInspectionLine(undefined, () => "d")).toBeNull();
  });
});

describe("inspectArgs (inspect_job's arguments)", () => {
  it("a pass carries the criteria, the measured result and an admin's reason; a fail its disposition and what failed", () => {
    const pass = inspectArgs({ jobId: "j", result: "pass", notes: "Bore 25.01", concessionReason: "", expectedVersion: 2, criteria: " Drawing rev A ", overrideReason: " Sole inspector on site " }, null, "k");
    expect(pass).toMatchObject({ p_job: "j", p_result: "pass", p_criteria: "Drawing rev A", p_measured: "Bore 25.01", p_expected_version: 2, p_override_reason: "Sole inspector on site", p_disposition: null, p_failure: null, p_client_op_id: "k", p_concession_reason: null });
    const fail = inspectArgs({ jobId: "j", result: "fail", notes: "Bore 25.08", concessionReason: "", expectedVersion: 2, criteria: "Rev A", disposition: "scrap",
      failure: { reason: "Oversize", quantity: 2, instructions: "", lines: null, batch: " H1 " } }, null, null);
    expect(fail).toMatchObject({ p_result: "fail", p_disposition: "scrap", p_failure: { reason: "Oversize", quantity: 2, instructions: "", lines: null, batch: "H1" } });
    const conceded = inspectArgs({ jobId: "j", result: "fail", notes: "x", concessionReason: "Customer agreed", expectedVersion: 0, criteria: "c", disposition: "concession",
      failure: { reason: "r", quantity: null, instructions: "", lines: null } }, null, null);
    expect(conceded.p_concession_reason).toBe("Customer agreed");
  });
});

describe("an inspection kept offline (InspectOp) replays through inspect_job", () => {
  const op = (over: Partial<InspectOp> = {}): InspectOp => ({
    kind: "inspect", v: 1, jobRef: "job-1", jobNo: "J-0001", clientOpId: "11111111-1111-4111-8111-111111111111", capturedBy: "user-a", capturedAt: at,
    result: "pass", criteria: "Rev A", measured: "25.01", expectedVersion: 0, concessionReason: null, overrideReason: null, disposition: null, failure: null, ...over,
  });
  type Call = Record<string, unknown>;
  /** A stand-in for inspect_job: one record per key, and the finisher's pass refused without an admin's reason. */
  function server(finisher: string) {
    const records = new Map<string, Call>();
    const calls: Call[] = [];
    return {
      records, calls,
      rpc: async (fn: string, args: Call) => {
        expect(fn).toBe("inspect_job");
        calls.push(args);
        const key = String(args.p_client_op_id);
        if (records.has(key)) return { data: { ...records.get(key), replayed: true }, error: null };
        if (args.__who === finisher && !args.p_override_reason) {
          return { data: null, error: { code: "42501", hint: "not_independent", message: "You finished J-0001, so someone else must inspect it: the person who finished a job can't record its pass." } };
        }
        records.set(key, { inspection_id: "insp-1" });
        return { data: { inspection_id: "insp-1" }, error: null };
      },
    };
  }
  const as = (who: string, s: ReturnType<typeof server>) => ({ rpc: (fn: string, args: Call) => s.rpc(fn, { ...args, __who: who }) });

  it("is only sent while the person who recorded it is signed in", async () => {
    const s = server("user-a");
    expect(await executeInspectOp(op(), as("user-b", s), "user-b")).toEqual({ status: "rejected", code: "inspection_other_user", reason: INSPECTION_OTHER_USER_REASON });
    expect(s.calls).toHaveLength(0);
  });

  it("a queued pass by the finisher is refused (held with the server's words); with an admin's reason it is recorded; a replay of the key answers it", async () => {
    const s = server("user-a");
    const refused = await executeInspectOp(op(), as("user-a", s), "user-a");
    expect(refused).toMatchObject({ status: "rejected", code: "not_independent" });
    expect((refused as { reason: string }).reason).toMatch(/^J-0001: You finished J-0001/);
    expect(s.records.size).toBe(0);
    const own = op({ overrideReason: "Sole inspector on site today", clientOpId: "22222222-2222-4222-8222-222222222222" });
    expect(await executeInspectOp(own, as("user-a", s), "user-a")).toEqual({ status: "applied" });
    expect(await executeInspectOp(own, as("user-a", s), "user-a")).toEqual({ status: "applied" });
    expect(s.records.size).toBe(1);
    expect(s.calls.at(-1)).toMatchObject({ p_job: "job-1", p_result: "pass", p_criteria: "Rev A", p_measured: "25.01", p_override_reason: "Sole inspector on site today" });
  });

  it("waits, unchanged, on a database without 081; a network failure stays queued", async () => {
    expect(await executeInspectOp(op(), { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.inspect_job" } }) }, "user-a"))
      .toEqual({ status: "blocked", code: expect.any(String), reason: INSPECTION_UPGRADE_REASON });
    expect(await executeInspectOp(op(), { rpc: async () => ({ data: null, error: { message: "Failed to fetch" } }) }, "user-a")).toEqual({ status: "network" });
  });
});

describe("early release (release_job_early, 081): admin only, with a reason", () => {
  const finished = { finished_at: at, stage: "inspection" };
  it("is offered to an admin only, on a finished customer job that isn't Complete", () => {
    expect(earlyReleaseOffered(finished, "admin")).toBe(true);
    expect(earlyReleaseOffered({ finished_at: at, stage: "rework" }, "admin")).toBe(true);
    for (const role of ["office", "workshop", "viewer", null, undefined]) expect(earlyReleaseOffered(finished, role)).toBe(false);
    expect(earlyReleaseOffered({ stage: "machining" }, "admin")).toBe(false);
    expect(earlyReleaseOffered({ finished_at: at, inspected_at: at, stage: "complete" }, "admin")).toBe(false);
    expect(earlyReleaseOffered({ ...finished, is_internal: true }, "admin")).toBe(false);
  });

  it("asks for a reason of at least 10 characters before calling the server, then calls it once with the reason trimmed", async () => {
    const rpc = vi.fn(async () => ({ data: { released_early: true, already: false }, error: null }));
    const job = { id: "j1", job_no: "JOB-1" };
    const short = await sendEarlyRelease({ rpc }, job, `  ${"x".repeat(REASON_MIN - 1)}  `);
    expect(short.ok).toBe(false);
    expect(short.ok ? "" : short.local).toMatch(/at least 10 characters/);
    expect(rpc).not.toHaveBeenCalled();
    const sent = await sendEarlyRelease({ rpc }, job, "  Customer needs the good parts now  ");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("release_job_early", { p_job: "j1", p_reason: "Customer needs the good parts now" });
    expect(sent).toEqual({ ok: true, message: "JOB-1 released early: it can go out before inspection. Recorded with your reason." });
  });

  it("says when it was already released, and hands back the server's refusal (the dialog words it with friendlyError)", async () => {
    const job = { id: "j1", job_no: "JOB-1" };
    const again = await sendEarlyRelease({ rpc: async () => ({ data: { already: true }, error: null }) }, job, "Customer needs the good parts now");
    expect(again).toEqual({ ok: true, message: "JOB-1 was already released early." });
    const refusal = { code: "42501", hint: "early_release_admin_only", message: "Only an admin can release a job before it passes inspection." };
    const refused = await sendEarlyRelease({ rpc: async () => ({ data: null, error: refusal }) }, job, "Customer needs the good parts now");
    expect(refused).toEqual({ ok: false, error: refusal });
    expect(friendlyError(refusal)).toBe("Only an admin can release a job before it passes inspection.");
  });
});

describe("an offline Finish that syncs (the board takes the finisher, so Reopen shows without a reload)", () => {
  const me = "u-me";
  type Row = { id: string; finished_at?: string | null; finished_by?: string | null; stage?: string | null };
  const queued: Row = { id: "j1", finished_at: at, stage: "inspection" }; // the board's local row after the offline Finish: no finished_by yet
  const reopenFor = (job: Row) => reopenCheck(job, { role: "workshop", me }).allowed;

  it("starts with Reopen hidden from the finisher (the bug), then shows it once the server confirms the Finish as theirs", () => {
    expect(reopenFor(queued)).toBe(false);
    const [after] = confirmedFinishers([queued], [{ id: "j1", finished_at: at, finished_by: me }]);
    expect(after.finished_by).toBe(me);
    expect(reopenFor(after)).toBe(true);
  });

  it("a replay that was refused or discarded (the server has no finish time) changes nothing: the same array, Reopen still hidden", () => {
    const jobs = [queued];
    expect(confirmedFinishers(jobs, [{ id: "j1", finished_at: null, finished_by: null }])).toBe(jobs);
    expect(confirmedFinishers(jobs, [])).toBe(jobs);
    expect(reopenFor(jobs[0])).toBe(false);
  });

  it("a job finished by someone else meanwhile takes their id: Reopen stays hidden from this person; other jobs are untouched", () => {
    const other: Row = { id: "j2", finished_at: at };
    const next = confirmedFinishers([queued, other], [{ id: "j1", finished_at: at, finished_by: "u-other" }]);
    expect(next[0].finished_by).toBe("u-other");
    expect(reopenFor(next[0])).toBe(false);
    expect(next[1]).toBe(other);
  });

  it("a job the board does not show as finished is not stamped", () => {
    const open = { id: "j3", finished_at: "" };
    expect(confirmedFinishers([open], [{ id: "j3", finished_at: at, finished_by: me }])[0]).toBe(open);
  });

  it("finishesLeftQueue: only a Finish gone from the queue counts; one still waiting, in conflict or refused (held) does not", () => {
    const entries = [
      { op: { kind: "finish", jobId: "waiting" } },
      { op: { kind: "finish", jobId: "held" } }, // conflicts / rejected lists are passed in the same array
      { op: { kind: "start", jobId: "synced" } }, // another kind on the same job does not hold the Finish back
    ];
    expect(finishesLeftQueue(["waiting", "held", "synced", "done"], entries)).toEqual(["synced", "done"]);
    expect(finishesLeftQueue([], entries)).toEqual([]);
  });
});
