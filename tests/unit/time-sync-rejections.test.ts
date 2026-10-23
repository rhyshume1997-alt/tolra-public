/**
 * Refused late time actions reported to the office (migration 075, G18; lib/time-sync-rejections.ts and the lib/offline/sync.ts calls):
 * only week_approved and time_too_old refusals of clock and labour actions are reported, once per key per page load (the server is
 * idempotent per key too: tests/db/time-sync-rejections.test.ts); the report never changes the sync outcome, and a server without 075
 * (or no connection) is ignored. The office's notice text per person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockOp, HeldEntry, LabourOp } from "@/lib/offline/outbox";
import { executeClockOp, executeLabourOp } from "@/lib/offline/sync";
import { REPORT_TIMEOUT_MS, type TimeSyncRejection, rejectionNotices, rejectionReportArgs, reportHeldTimeRejections, reportTimeSyncRejection, resetReportedThisLoad } from "@/lib/time-sync-rejections";

const clockOp = (over: Partial<ClockOp> = {}): ClockOp => ({ kind: "clock", v: 1, action: "in", at: "2026-10-13T07:02:00.000Z", clientOpId: "k-clock", device: "Phone", jobNo: "Daily job sheet", ...over });
const labourOp = (over: Partial<LabourOp> = {}): LabourOp => ({ kind: "labour", v: 1, action: "start", jobRef: "job-1", jobNo: "J-1042", at: "2026-10-13T08:00:00.000Z", clientOpId: "k-labour", ...over });

/** A fake server: the time RPC answers `refusal`; the report RPC answers `report` (or throws). Records every call. */
function server(refusal: { hint: string; code?: string; message?: string } | null, report: "ok" | "missing" | "throw" | "capped" | "hang" = "ok") {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "report_time_sync_rejection") {
        if (report === "throw") throw new TypeError("Failed to fetch");
        if (report === "hang") return new Promise<never>(() => {});
        if (report === "capped") return { data: null, error: { code: "54000", hint: "too_many_rejections", message: "Too many." } };
        return report === "missing" ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } } : { data: { id: "r1" }, error: null };
      }
      return refusal ? { data: null, error: { code: refusal.code ?? "42501", hint: refusal.hint, message: refusal.message ?? "Refused." } } : { data: { event_id: "e1" }, error: null };
    },
  };
}
const reports = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.fn === "report_time_sync_rejection");

beforeEach(() => resetReportedThisLoad());

describe("what is reported", () => {
  it("a clock action refused for an approved week: the person's own action, its key, time, code, device and the reason", async () => {
    const s = server({ hint: "week_approved", message: "That time is in a week that has already been approved. Ask an admin to add it." });
    const outcome = await executeClockOp(clockOp(), s, "company-1");
    expect(outcome).toMatchObject({ status: "rejected", code: "week_approved" });
    expect(reports(s)).toEqual([{ fn: "report_time_sync_rejection", args: {
      p_client_op_id: "k-clock", p_kind: "clock", p_action: "in", p_at: "2026-10-13T07:02:00.000Z", p_code: "week_approved",
      p_reason: "That time is in a week that has already been approved. Ask an admin to add it.", p_job: null, p_device: "Phone",
    } }]);
  });

  it("a job Start over 14 days old: kind labour, the job number, no device", async () => {
    const s = server({ hint: "time_too_old", code: "22023" });
    const outcome = await executeLabourOp(labourOp(), s);
    expect(outcome).toMatchObject({ status: "rejected", code: "time_too_old" });
    expect(reports(s)[0].args).toMatchObject({ p_kind: "labour", p_action: "start", p_code: "time_too_old", p_job: "J-1042", p_device: null });
  });

  it("nothing for an applied action or any other refusal", async () => {
    for (const refusal of [null, { hint: "client_op_reused", code: "22023" }, { hint: "not_allowed" }, { hint: "bad_action", code: "22023" }]) {
      resetReportedThisLoad();
      const s = server(refusal);
      await executeClockOp(clockOp(), s, "company-1");
      expect(reports(s), JSON.stringify(refusal)).toEqual([]);
    }
    expect(rejectionReportArgs({ kind: "finish", jobId: "j", jobNo: "J-1", at: "2026-10-13T08:00:00Z" } as never, "time_too_old", "x")).toBeNull();
  });
});

describe("idempotent and harmless", () => {
  it("once per key per page load: a second sync of the same refusal sends nothing more (the server answers a repeat anyway)", async () => {
    const s = server({ hint: "week_approved" });
    await executeClockOp(clockOp(), s, "company-1");
    await executeClockOp(clockOp(), s, "company-1");
    expect(reports(s)).toHaveLength(1);
    const held: HeldEntry = { id: "1", queuedAt: "2026-10-13T07:02:00Z", op: clockOp(), reason: "Refused.", heldAt: "2026-10-19T09:00:00Z", code: "week_approved" };
    expect(await reportHeldTimeRejections(s, [held])).toBe(0);
    expect(reports(s)).toHaveLength(1);
  });

  it("a server without 075, or no connection: the outcome is the same and nothing throws", async () => {
    for (const report of ["missing", "throw", "capped"] as const) {
      resetReportedThisLoad();
      const s = server({ hint: "time_too_old", code: "22023" }, report);
      expect(await executeClockOp(clockOp(), s, "company-1")).toMatchObject({ status: "rejected", code: "time_too_old" });
      expect(reports(s)).toHaveLength(1);
    }
  });

  it("held refusals from before 075 are offered on the next page load; other held codes are not", async () => {
    const s = server(null);
    const held = (code: string, key: string): HeldEntry => ({ id: key, queuedAt: "2026-10-01T07:00:00Z", op: clockOp({ clientOpId: key }), reason: "Refused.", heldAt: "2026-10-19T09:00:00Z", code });
    expect(await reportHeldTimeRejections(s, [held("time_too_old", "a"), held("client_op_reused", "b"), held("week_approved", "c")])).toBe(2);
    expect(reports(s).map((c) => c.args.p_client_op_id)).toEqual(["a", "c"]);
    expect(await reportTimeSyncRejection(null, clockOp(), { status: "rejected", code: "time_too_old" })).toBe(false);
  });
});

describe("a report that never answers", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("doesn't stall the sync: the outcome comes back after the 5 second timeout", async () => {
    vi.useFakeTimers();
    const s = server({ hint: "week_approved" }, "hang");
    let settled: unknown = null;
    const pending = executeClockOp(clockOp(), s, "company-1").then((o) => { settled = o; });
    await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(settled).toMatchObject({ status: "rejected", code: "week_approved" });
    expect(REPORT_TIMEOUT_MS).toBe(5_000);
  });
});

describe("the office's notice", () => {
  const row = (over: Partial<TimeSyncRejection>): TimeSyncRejection => ({
    id: "r", user_id: "u1", client_op_id: "k", op_kind: "clock", action: "in", intended_at: "2026-10-13T07:02:00Z", code: "week_approved",
    device_reason: null, job_label: null, device_label: null, reported_at: "2026-10-19T09:00:00Z", resolved_at: null, ...over,
  });
  it("one per person, unresolved only, counted, with the reasons named", () => {
    const names: Record<string, string> = { u1: "Lee", u2: "Charlie" };
    const notices = rejectionNotices([
      row({ id: "1" }), row({ id: "2", action: "out", code: "time_too_old", intended_at: "2026-10-01T16:00:00Z" }),
      row({ id: "3", user_id: "u2" }), row({ id: "4", user_id: "u2", resolved_at: "2026-10-19T10:00:00Z" }),
    ], (id) => names[id]);
    expect(notices.map((n) => n.text)).toEqual([
      "1 time action from Charlie's device was refused (week approved): add it as a correction",
      "2 time actions from Lee's device were refused (week approved, over 14 days): add them as a correction",
    ]);
    expect(notices[1].rows.map((r) => r.id)).toEqual(["2", "1"]);
    expect(rejectionNotices([row({ resolved_at: "2026-10-19T10:00:00Z" })], () => "x")).toEqual([]);
  });
});
