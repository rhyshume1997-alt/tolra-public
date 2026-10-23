/**
 * Job time Start/Stop through the offline outbox (migration 051) and what the daily job sheet shows while they wait on the device
 * (lib/time-data.ts overlayPending): one lane per job, duplicate taps kept once, replays applied once, refusals held with a code, a
 * server without 051 blocked; pending clock actions and job time shown at once, marked "saved on this device".
 */
import { beforeEach, describe, expect, it } from "vitest";

import { type LabourOp, type OutboxEntry, enqueue, jobOfOp, pendingEntries, rejectedEntries, replayOutbox } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { executeLabourOp } from "@/lib/offline/sync";
import { deviceLabel, overlayPending, pendingForPersonWeek } from "@/lib/time-data";
import { DEFAULT_TIME_SETTINGS, dayTotals, hm } from "@/lib/time-sheet";

const scope = { userId: "u1", orgId: "o1" };
let n = 0;
const op = (action: LabourOp["action"], job: string, at: string): LabourOp => ({ kind: "labour", v: 1, action, jobRef: job, jobNo: `J-${job}`, at, clientOpId: `k${(n += 1)}` });
const entry = (o: OutboxEntry["op"], queuedAt = "2026-10-19T10:00:00Z"): OutboxEntry => ({ id: `e${(n += 1)}`, queuedAt, op: o });

beforeEach(() => setOfflineBackend(memoryBackend()));

describe("labour Start/Stop in the outbox", () => {
  it("belong to their job's lane, are kept once per key, and are applied once", async () => {
    const start = op("start", "A", "2026-10-19T07:00:00Z");
    expect(jobOfOp(start)).toBe("A");
    await enqueue(scope, start);
    await enqueue(scope, start);
    await enqueue(scope, op("stop", "A", "2026-10-19T09:00:00Z"));
    const seen: string[] = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { seen.push(`${fn}:${args.p_action}:${args.p_job}`); return { data: { state: "started" }, error: null }; } };
    expect(await replayOutbox(scope, (o) => executeLabourOp(o as LabourOp, client))).toMatchObject({ applied: 2, remaining: 0 });
    expect(seen).toEqual(["record_labour_event:start:A", "record_labour_event:stop:A"]);
  });

  it("a job gone is held with a code; a server without 051 is blocked and kept unchanged", async () => {
    await enqueue(scope, op("start", "gone", "2026-10-19T07:00:00Z"));
    const gone = { rpc: async () => ({ data: null, error: { code: "P0002", message: "Job not found" } }) };
    await replayOutbox(scope, (o) => executeLabourOp(o as LabourOp, gone));
    expect((await rejectedEntries(scope))[0]).toMatchObject({ code: "job_gone" });
    const queued = op("stop", "B", "2026-10-19T09:00:00Z");
    await enqueue(scope, queued);
    const old = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "not found" } }) };
    expect(await replayOutbox(scope, (o) => executeLabourOp(o as LabourOp, old))).toMatchObject({ blocked: 1, remaining: 1 });
    expect((await pendingEntries(scope))[0].op).toEqual(queued);
  });
});

describe("the sheet shows what is still on the device", () => {
  it("pending clock actions and job time count straight away, flagged; a pending Stop closes the server's open session", () => {
    const server = {
      events: [{ id: "s1", user_id: "u1", action: "in" as const, at: "2026-10-19T07:00:00Z", received_at: "2026-10-19T07:00:01Z" }],
      labour: [{ id: "L1", user_id: "u1", job_id: "A", started_at: "2026-10-19T07:00:00Z", ended_at: null }],
    };
    const pending = [
      entry(op("stop", "A", "2026-10-19T09:00:00Z")),
      entry(op("start", "B", "2026-10-19T09:00:00Z")),
      entry(op("stop", "B", "2026-10-19T11:00:00Z")),
      entry({ kind: "clock", v: 1, action: "out", at: "2026-10-19T15:00:00Z", clientOpId: "c1", device: "iPad", jobNo: "Daily job sheet" }),
    ];
    const merged = overlayPending(server, pending, "u1");
    expect(server.labour[0].ended_at).toBeNull(); // the server copy is not changed
    const day = dayTotals({ date: "2026-10-19", ...merged, settings: DEFAULT_TIME_SETTINGS, bankHolidays: new Map(), now: Date.parse("2026-10-19T16:00:00Z") });
    expect([hm(day.attendance), hm(day.labour), day.jobs.map((j) => [j.jobId, hm(j.minutes)])]).toEqual(["8:00", "4:00", [["A", "2:00"], ["B", "2:00"]]]);
    expect(day.flags).toContain("saved_on_device");
  });

  it("names the device without keeping the browser string", () => {
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("iPad");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; SM-X200) Safari")).toBe("Android tablet");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari")).toBe("Android phone");
    expect(deviceLabel("")).toBeNull();
  });
});

describe("pendingForPersonWeek (approval dialog: what this device still holds for a person and week)", () => {
  const week = "2026-10-12";
  const clock = (at: string): OutboxEntry => entry({ kind: "clock", v: 1, action: "in", at, clientOpId: `c${(n += 1)}`, device: null, jobNo: "" });
  const labour = (at: string) => entry(op("start", "j1", at));
  const photo = entry({ kind: "photo", photoId: "p1", jobId: "j1", jobNo: "J-1", note: null, capturedAt: null, byteSize: 1, blobKey: "k" });

  it("counts clock and labour items inside the week for the signed-in person only", () => {
    const items = [clock("2026-10-12T08:00:00Z"), labour("2026-10-18T12:00:00Z"), photo];
    expect(pendingForPersonWeek(items, "u1", "u1", week)).toHaveLength(2);
  });

  it("ignores items outside the week (Monday to Sunday)", () => {
    const items = [clock("2026-10-11T12:00:00Z"), clock("2026-10-19T12:00:00Z")];
    expect(pendingForPersonWeek(items, "u1", "u1", week)).toHaveLength(0);
  });

  it("is empty for another person's week, or when nobody is signed in", () => {
    const items = [clock("2026-10-13T08:00:00Z")];
    expect(pendingForPersonWeek(items, "u1", "u2", week)).toHaveLength(0);
    expect(pendingForPersonWeek(items, null, "u1", week)).toHaveLength(0);
  });
});
