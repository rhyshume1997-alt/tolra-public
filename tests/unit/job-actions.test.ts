import { describe, expect, it } from "vitest";

import { bulkDisabledReason, finishCheck, finishPatch, groupByPatch, keepVisibleSelected, missedReason, planBulk, startCheck, startPatch, summariseJobNumbers } from "@/lib/job-actions";

const AT = "2026-10-13T09:00:00.000Z";
const EARLIER = "2026-10-01T08:00:00.000Z";
const user = { viewer: false };
const viewer = { viewer: true };

const fresh = { started_at: "", finished_at: "", inspected_at: "", stage: "material" };
const started = { started_at: EARLIER, finished_at: "", inspected_at: "", stage: "machining" };
const finished = { started_at: EARLIER, finished_at: "2026-10-02T08:00:00.000Z", inspected_at: "", stage: "inspection" };
const inspected = { ...finished, inspected_at: "2026-10-03T08:00:00.000Z", stage: "complete" };
const rework = { ...finished, stage: "rework" };

describe("Start / Finish eligibility (shared by cards, list, table and bulk)", () => {
  it("a fresh job can be started and finished", () => {
    expect(startCheck(fresh, user)).toMatchObject({ shown: true, enabled: true });
    expect(finishCheck(fresh, user)).toMatchObject({ shown: true, enabled: true });
  });

  it("Start is disabled once the job has started, finished or been inspected", () => {
    for (const job of [started, finished, inspected]) expect(startCheck(job, user)).toMatchObject({ shown: true, enabled: false });
    expect(startCheck(started, user).reason).toBe("Already started");
  });

  it("Finish is disabled once the job has finished or been inspected, but still open after Start", () => {
    expect(finishCheck(started, user).enabled).toBe(true);
    for (const job of [finished, inspected]) expect(finishCheck(job, user)).toMatchObject({ shown: true, enabled: false });
    expect(finishCheck(finished, user).reason).toBe("Already finished");
  });

  it("a viewer sees neither action", () => {
    expect(startCheck(fresh, viewer)).toMatchObject({ shown: false, enabled: false });
    expect(finishCheck(fresh, viewer)).toMatchObject({ shown: false, enabled: false });
  });

  it("a job in rework hides both (the rework dialog drives it), until it is inspected again", () => {
    expect(startCheck(rework, user).shown).toBe(false);
    expect(finishCheck(rework, user).shown).toBe(false);
    // Inspected clears the rework state: shown again, but disabled because it is done.
    const released = { ...rework, inspected_at: "2026-10-04T08:00:00.000Z" };
    expect(startCheck(released, user)).toMatchObject({ shown: true, enabled: false });
  });
});

describe("a recorded timestamp is never replaced", () => {
  it("start: a new time only for a job that has not started", () => {
    expect(startPatch(fresh, AT)).toEqual({ started_at: AT });
    expect(startPatch(started, AT)).toBeNull();
    expect(startPatch(finished, AT)).toBeNull();
  });

  it("finish: keeps an existing start, and records one (same moment) only when there was none", () => {
    expect(finishPatch(started, AT)).toEqual({ finished_at: AT, stage: "inspection" });
    expect(finishPatch(fresh, AT)).toEqual({ started_at: AT, finished_at: AT, stage: "inspection" });
    expect(finishPatch(finished, AT)).toBeNull();
    expect(finishPatch(inspected, AT)).toBeNull();
  });

  it("repeat taps: applying the patch then asking again sends nothing", () => {
    const once = finishPatch(started, AT)!;
    const after = { ...started, ...once };
    expect(finishPatch(after, "2026-10-13T09:00:05.000Z")).toBeNull();
    expect(startPatch(after, "2026-10-13T09:00:05.000Z")).toBeNull();
    expect(after.started_at).toBe(EARLIER);
    expect(after.finished_at).toBe(AT);
  });

  it("never puts a timestamp in a patch for a job that already has it", () => {
    for (const job of [fresh, started, finished, inspected, rework]) {
      const s = startPatch(job, AT);
      const f = finishPatch(job, AT);
      if (job.started_at) { expect(s).toBeNull(); expect(f && "started_at" in f).toBeFalsy(); }
      if (job.finished_at) expect(f).toBeNull();
    }
  });
});

describe("bulk plan", () => {
  const jobs = [
    { id: "1", job_no: "J-1", ...fresh },
    { id: "2", job_no: "J-2", ...started },
    { id: "3", job_no: "J-3", ...finished },
    { id: "4", job_no: "J-4", ...rework },
  ];

  it("Start targets only the jobs that have not started; the rest are left with a reason", () => {
    const plan = planBulk("start", jobs, AT);
    expect(plan.targets.map((t) => t.job.job_no)).toEqual(["J-1"]);
    expect(plan.skipped.map((t) => [t.job.job_no, t.reason])).toEqual([["J-2", "Already started"], ["J-3", "Already finished"], ["J-4", "In rework"]]);
  });

  it("Finish targets unfinished jobs, grouped so an existing start is kept and a missing one is recorded", () => {
    const plan = planBulk("finish", jobs, AT);
    expect(plan.targets.map((t) => t.job.job_no)).toEqual(["J-1", "J-2"]);
    const groups = groupByPatch(plan.targets);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.ids.includes("2"))!.patch).toEqual({ finished_at: AT, stage: "inspection" });
    expect(groups.find((g) => g.ids.includes("1"))!.patch).toEqual({ started_at: AT, finished_at: AT, stage: "inspection" });
  });

  it("a viewer's plan has no targets", () => {
    expect(planBulk("start", jobs, AT, viewer).targets).toHaveLength(0);
  });
});

describe("summariseJobNumbers", () => {
  it("lists a short list in full", () => {
    expect(summariseJobNumbers(["A", "B", "C"])).toBe("A, B, C");
  });
  it("cuts a long list and says how many are left out", () => {
    const names = Array.from({ length: 12 }, (_, i) => `J-${i + 1}`);
    expect(summariseJobNumbers(names, 8)).toBe("J-1, J-2, J-3, J-4, J-5, J-6, J-7, J-8 +4 more");
    expect(summariseJobNumbers(names, 12)).toBe(names.join(", "));
  });
});

describe("missedReason", () => {
  it("tells already started/finished apart from removed or not visible", () => {
    expect(missedReason("start", 1, 0)).toBe("1 was already started, so the recorded time is kept");
    expect(missedReason("finish", 2, 1)).toBe("2 were already finished, so the recorded time is kept; 1 was removed, or you no longer have access");
    expect(missedReason("start", 0, 3)).toBe("3 were removed, or you no longer have access");
  });
});

describe("Job Board selection (bulk Start / Finish)", () => {
  const job = (id: string, state: typeof fresh) => ({ id, job_no: `J-${id}`, ...state });

  it("a selected job that is no longer shown is dropped; the others keep their order", () => {
    expect(keepVisibleSelected(["1", "2", "3"], new Set(["1", "3", "9"]))).toEqual(["1", "3"]);
    expect(keepVisibleSelected(["1", "2"], new Set<string>())).toEqual([]);
  });

  it("returns the same array when nothing is hidden, so the selection state does not change", () => {
    const selected = ["1", "2"];
    expect(keepVisibleSelected(selected, new Set(["1", "2", "3"]))).toBe(selected);
  });

  it("Start is unavailable when every selected job is already started, finished or in rework", () => {
    expect(bulkDisabledReason("start", [job("1", started), job("2", finished), job("3", rework)])).toBe("None of the selected jobs can be started");
  });

  it("Start stays available when at least one selected job can start", () => {
    expect(bulkDisabledReason("start", [job("1", started), job("2", fresh)])).toBeNull();
  });

  it("Finish is unavailable when none of the selected jobs can be finished", () => {
    expect(bulkDisabledReason("finish", [job("1", finished), job("2", inspected)])).toBe("None of the selected jobs can be finished");
    expect(bulkDisabledReason("finish", [job("1", started)])).toBeNull();
  });

  it("with nothing selected there is no reason (the button says to select a job first); a viewer can do neither", () => {
    expect(bulkDisabledReason("start", [])).toBeNull();
    expect(bulkDisabledReason("start", [job("1", fresh)], viewer)).toBe("None of the selected jobs can be started");
  });
});
