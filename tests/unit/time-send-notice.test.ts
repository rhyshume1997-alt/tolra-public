/**
 * The toast after a clock action or job Start/Stop on the daily job sheet (lib/time-data.ts timeSendNotice): "saved on this device" only
 * while the entry is still on the device; "saved" once the sync pass sent it and the server kept it; refusals and blocks say why.
 */
import { describe, expect, it } from "vitest";

import type { ClockOp, LabourOp } from "@/lib/offline/outbox";
import { syncPassRan, timeSendNotice } from "@/lib/time-data";

const clock: ClockOp = { kind: "clock", v: 1, action: "in", at: "2026-10-25T07:00:00Z", clientOpId: "k1", device: null, jobNo: "Daily job sheet" };
const other: LabourOp = { kind: "labour", v: 1, action: "start", jobRef: "j", jobNo: "J-1", at: "2026-10-25T07:00:00Z", clientOpId: "k2" };
const base = { offline: false, settled: true, pending: [], held: [] };

describe("timeSendNotice", () => {
  it("online and sent (no longer in the queue, not held): saved, not 'on this device'", () => {
    expect(timeSendNotice("Clock in", "k1", { ...base, pending: [{ op: other }] })).toEqual({ tone: "success", message: "Clock in: saved." });
  });
  it("offline when tapped: saved on this device, syncs when back online (wording unchanged)", () => {
    expect(timeSendNotice("Clock in", "k1", { ...base, offline: true, settled: false })).toEqual({ tone: "success", message: "Clock in: saved on this device. It will sync when you're back online." });
  });
  it("still in the queue after the pass, or the pass did not finish in time, or the scope changed: saved on this device", () => {
    const waiting = { tone: "success", message: "Clock in: saved on this device. It will be sent as soon as the connection allows." };
    expect(timeSendNotice("Clock in", "k1", { ...base, pending: [{ op: clock }] })).toEqual(waiting);
    expect(timeSendNotice("Clock in", "k1", { ...base, settled: false })).toEqual(waiting);
  });
  it("blocked in the queue: kept on this device with the reason", () => {
    const n = timeSendNotice("Break start", "k1", { ...base, pending: [{ op: clock, blocked: { code: "server_upgrade", reason: "Waiting: Tolra needs updating.", at: "x" } }] });
    expect(n).toEqual({ tone: "info", message: "Break start: saved on this device, not sent yet. Waiting: Tolra needs updating." });
  });
  it("refused by the server: not recorded, with the reason", () => {
    const n = timeSendNotice("Clock out", "k1", { ...base, held: [{ op: clock, reason: "This week is approved." }] });
    expect(n).toEqual({ tone: "error", message: "Clock out: not recorded. This week is approved." });
  });
  it("refused but the wait ran out (not settled): still not recorded, never 'saved on this device'", () => {
    const n = timeSendNotice("Clock out", "k1", { ...base, settled: false, held: [{ op: clock, reason: "This week is approved." }] });
    expect(n).toEqual({ tone: "error", message: "Clock out: not recorded. This week is approved." });
  });
  it("blocked while the wait ran out (not settled): says not sent yet with the reason, never plain 'saved'", () => {
    const n = timeSendNotice("Clock in", "k1", { ...base, settled: false, pending: [{ op: clock, blocked: { code: "server_upgrade", reason: "Waiting: Tolra needs updating.", at: "x" } }] });
    expect(n).toEqual({ tone: "info", message: "Clock in: saved on this device, not sent yet. Waiting: Tolra needs updating." });
  });
});

describe("syncPassRan (a null sync result is not a send)", () => {
  it("null or undefined (the pass sent nothing): not settled, so the toast says saved on this device", () => {
    expect(syncPassRan(null)).toBe(false);
    expect(syncPassRan(undefined)).toBe(false);
    expect(timeSendNotice("Clock in", "k1", { ...base, settled: syncPassRan(null) })).toEqual({ tone: "success", message: "Clock in: saved on this device. It will be sent as soon as the connection allows." });
  });
  it("a pass that ran: settled; 'saved' only if the entry left the queue", () => {
    expect(syncPassRan({ applied: 1, conflicts: 0, rejected: 0, blocked: 0, remaining: 0 })).toBe(true);
    expect(timeSendNotice("Clock in", "k1", { ...base, settled: syncPassRan({ applied: 0, conflicts: 0, rejected: 0, blocked: 0, remaining: 1 }), pending: [{ op: clock }] })).toEqual({ tone: "success", message: "Clock in: saved on this device. It will be sent as soon as the connection allows." });
  });
});
