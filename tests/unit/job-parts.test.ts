/**
 * Parts done on a job (lib/job-parts, migration 118): "N of M" in words, who gets the "+1 part" button, fail closed until the database has
 * 118, the retry key, the entry's validation, the failure words, and that logging is online only (it never reaches the offline outbox).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  NEEDS_CONNECTION, NO_PARTS, entrySignature, loadPartsDone, logJobParts, opKeyFor, outcomeUnknown, parseEntry, partsControls, partsFailure, partsText, requiredParts,
  type PartsTotals,
} from "@/lib/job-parts";

const totals = (done: Record<string, number>, available: boolean | null = true): PartsTotals => ({ available, done: new Map(Object.entries(done)) });

describe("requiredParts (M)", () => {
  it("is a whole number of 1 or more, from a number or the text the board holds; anything else is no M", () => {
    expect(requiredParts(50)).toBe(50);
    expect(requiredParts("50")).toBe(50);
    expect(requiredParts(1)).toBe(1);
    for (const bad of [0, -3, 2.5, "", "  ", "abc", null, undefined, NaN]) expect(requiredParts(bad as never), String(bad)).toBeNull();
  });
});

describe("partsText: N of M in words", () => {
  it("says 12 of 50 parts; 0 of 50 when nothing is logged yet; 1 of 1 part in the singular", () => {
    expect(partsText(totals({ j1: 12 }), "j1", 50)).toBe("12 of 50 parts");
    expect(partsText(totals({ j1: 0 }), "j1", 50)).toBe("0 of 50 parts");
    expect(partsText(totals({ j1: 1 }), "j1", 1)).toBe("1 of 1 part");
    expect(partsText(totals({ j1: 7 }), "j1", "20")).toBe("7 of 20 parts");
  });
  it("fail closed: nothing without the database's yes, without a count for the job, or without M", () => {
    expect(partsText(totals({ j1: 12 }, false), "j1", 50)).toBeNull();
    expect(partsText(totals({ j1: 12 }, null), "j1", 50)).toBeNull();
    expect(partsText(NO_PARTS, "j1", 50)).toBeNull();
    expect(partsText(totals({ j1: 12 }), "other", 50)).toBeNull();
    expect(partsText(totals({ j1: 12 }), "j1", null)).toBeNull();
    expect(partsText(totals({ j1: 12 }), "j1", 0)).toBeNull();
  });
});

describe("loadPartsDone", () => {
  const rpcWith = (answer: (fn: string, args: { p_jobs: string[] }) => { data?: unknown; error?: { code?: string; message?: string } | null }) => ({
    rpc: async (fn: string, args: { p_jobs: string[] }) => ({ data: null, error: null, ...answer(fn, args) }),
  }) as never;

  it("a job with no entries is 0 (the database returns no row for it)", async () => {
    const db = rpcWith(() => ({ data: [{ job_id: "a", parts_done: 3 }] }));
    const answer = await loadPartsDone(db, ["a", "b"]);
    expect(answer.available).toBe(true);
    expect([...answer.done]).toEqual([["a", 3], ["b", 0]]);
  });

  it("asks in chunks and joins the answers; a duplicate id is asked once", async () => {
    const asked: string[][] = [];
    const db = rpcWith((_fn, args) => { asked.push(args.p_jobs); return { data: args.p_jobs.map((id) => ({ job_id: id, parts_done: 1 })) }; });
    const ids = Array.from({ length: 250 }, (_, i) => `j${i}`);
    const answer = await loadPartsDone(db, [...ids, "j0"]);
    expect(asked.map((a) => a.length)).toEqual([100, 100, 50]);
    expect(answer.available).toBe(true);
    expect(answer.done.size).toBe(250);
  });

  it("the database without 118 (function missing) is available: false; any other failure, one failed chunk or a throw is available: null with no counts", async () => {
    for (const code of ["PGRST202", "42883"]) expect((await loadPartsDone(rpcWith(() => ({ error: { code, message: "missing" } })), ["a"])).available, code).toBe(false);
    const other = await loadPartsDone(rpcWith(() => ({ error: { code: "500", message: "boom" } })), ["a"]);
    expect(other).toEqual({ available: null, done: new Map() });
    let n = 0;
    const second = await loadPartsDone(rpcWith(() => { n += 1; return n === 2 ? { error: { message: "Failed to fetch" } } : { data: [] }; }), Array.from({ length: 150 }, (_, i) => `j${i}`));
    expect(second).toEqual({ available: null, done: new Map() });
    const thrown = await loadPartsDone({ rpc: async () => { throw new Error("offline"); } } as never, ["a"]);
    expect(thrown).toEqual(NO_PARTS);
  });

  it("no jobs asks nothing", async () => {
    let called = false;
    const answer = await loadPartsDone(rpcWith(() => { called = true; return {}; }), []);
    expect(called).toBe(false);
    expect(answer).toEqual(NO_PARTS);
  });
});

describe("partsControls: who gets +1 part", () => {
  const base = { available: true as boolean | null, role: "workshop", online: true, required: 50, done: 12 };
  it("workshop, office and admin get the buttons once the database has 118; a viewer gets none; a support session (read only) none", () => {
    for (const role of ["workshop", "office", "admin"]) expect(partsControls({ ...base, role }).show, role).toBe(true);
    for (const role of ["viewer", null, undefined, ""]) expect(partsControls({ ...base, role: role as never }).show, String(role)).toBe(false);
    expect(partsControls({ ...base, readOnly: true }).show).toBe(false);
  });
  it("fail closed: hidden until 118 is there (missing, or not known), when the count is unknown, and for a job with no quantity", () => {
    expect(partsControls({ ...base, available: false }).show).toBe(false);
    expect(partsControls({ ...base, available: null }).show).toBe(false);
    expect(partsControls({ ...base, done: undefined }).show).toBe(false);
    expect(partsControls({ ...base, required: null }).show).toBe(false);
  });
  it("+1 part is off at M and 'take off' is off at 0; at M it says all the parts are logged", () => {
    expect(partsControls({ ...base, done: 12 })).toMatchObject({ canAdd: true, canTakeOff: true, note: null });
    expect(partsControls({ ...base, done: 50 })).toMatchObject({ canAdd: false, canTakeOff: true, note: "All the parts are logged." });
    expect(partsControls({ ...base, done: 0 })).toMatchObject({ canAdd: true, canTakeOff: false });
  });
  it("offline the buttons stay and say it needs a connection", () => {
    expect(partsControls({ ...base, online: false })).toMatchObject({ show: true, note: NEEDS_CONNECTION });
  });
});

describe("parseEntry", () => {
  it("adds a whole number; the note is optional", () => {
    expect(parseEntry({ amount: "10", takeOff: false, note: "" })).toEqual({ ok: true, quantity: 10, note: "" });
    expect(parseEntry({ amount: " 3 ", takeOff: false, note: "  Tray 4 " })).toEqual({ ok: true, quantity: 3, note: "Tray 4" });
  });
  it("taking off is a negative entry and must say why (3 to 250 characters)", () => {
    expect(parseEntry({ amount: "2", takeOff: true, note: "Counted the wrong tray" })).toEqual({ ok: true, quantity: -2, note: "Counted the wrong tray" });
    for (const note of ["", "  ", "ok"]) expect(parseEntry({ amount: "2", takeOff: true, note })).toMatchObject({ ok: false });
    expect(parseEntry({ amount: "2", takeOff: false, note: "x".repeat(251) })).toMatchObject({ ok: false });
    expect(parseEntry({ amount: "2", takeOff: true, note: "x".repeat(250) })).toMatchObject({ ok: true });
  });
  it("refuses anything that is not a whole number from 1 to 100,000", () => {
    for (const amount of ["", "0", "-1", "1.5", "1e3", "abc", "100001", "٣"]) expect(parseEntry({ amount, takeOff: false, note: "" }), amount).toMatchObject({ ok: false });
    expect(parseEntry({ amount: "100000", takeOff: false, note: "" })).toMatchObject({ ok: true, quantity: 100000 });
  });
});

describe("the retry key", () => {
  it("the same entry keeps its key until it gets a definite answer; a different entry gets a new one", () => {
    let n = 0;
    const make = () => `k${++n}`;
    const sig = entrySignature("j1", 1, "");
    const first = opKeyFor(null, sig, make);
    expect(opKeyFor(first, sig, make)).toBe(first);
    expect(opKeyFor(first, entrySignature("j1", 2, ""), make).key).toBe("k2");
    expect(opKeyFor(first, entrySignature("j2", 1, ""), make).key).toBe("k3");
    expect(entrySignature("j1", 1, " x ")).toBe(entrySignature("j1", 1, "x"));
  });
  it("only an unknown outcome (the connection dropped) keeps the key; a refusal from the database clears it", () => {
    expect(outcomeUnknown(new Error("Failed to fetch"))).toBe(true);
    expect(outcomeUnknown({ message: "TypeError: NetworkError" })).toBe(true);
    expect(outcomeUnknown({ code: "22003", message: "That would take the total below 0." })).toBe(false);
    expect(outcomeUnknown({ code: "42501", message: "not authorised" })).toBe(false);
  });
});

describe("failure words", () => {
  it("each refusal says what happened and that nothing was saved", () => {
    expect(partsFailure({ code: "22003", message: "That would take the total below 0." })).toBe("That would take the count below 0. Nothing was saved.");
    expect(partsFailure({ code: "22003", message: "That would take the total above the quantity required." })).toBe("That would take the count above the quantity required. Nothing was saved.");
    expect(partsFailure({ code: "42501", message: "That job is not assigned to you." })).toMatch(/assigned to you/);
    expect(partsFailure({ code: "55000", message: "That job is finished." })).toMatch(/finished/);
    expect(partsFailure({ code: "P0002", message: "Job not found" })).toMatch(/couldn't be found/);
    expect(partsFailure({ code: "22023", message: "That job has no quantity to count against." })).toMatch(/no quantity/);
    expect(partsFailure({ code: "PGRST202", message: "Could not find the function public.log_job_parts in the schema cache" })).toMatch(/isn't available yet/);
    expect(partsFailure({ code: "XX000", message: "boom" })).toBe("The parts weren't logged. Try again.");
  });
  it("a connection problem says so", () => {
    expect(partsFailure(new Error("Failed to fetch"))).toBe(NEEDS_CONNECTION);
  });
});

describe("logging parts is online only and never queued", () => {
  it("sends one call to log_job_parts with the job, the signed quantity, the note (or null) and the key", async () => {
    const calls: Array<[string, unknown]> = [];
    const db = { rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data: "log-1", error: null }; } } as never;
    expect(await logJobParts(db, "j1", 1, "", "op-1")).toBe("log-1");
    expect(await logJobParts(db, "j1", -2, "  Wrong tray ", "op-2")).toBe("log-1");
    expect(calls).toEqual([
      ["log_job_parts", { p_job: "j1", p_quantity: 1, p_note: null, p_client_op_id: "op-1" }],
      ["log_job_parts", { p_job: "j1", p_quantity: -2, p_note: "Wrong tray", p_client_op_id: "op-2" }],
    ]);
  });
  it("a refusal from the database is thrown, not swallowed (so it is never shown as saved)", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "22003", message: "That would take the total above the quantity required." } }) } as never;
    await expect(logJobParts(db, "j1", 1, "", "op")).rejects.toMatchObject({ code: "22003" });
  });
  it("offline it throws before calling the server", async () => {
    let called = false;
    const db = { rpc: async () => { called = true; return { data: "x", error: null }; } } as never;
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
    try {
      await expect(logJobParts(db, "j1", 1, "", "op")).rejects.toThrow(NEEDS_CONNECTION);
      expect(called).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
  it("no parts code touches the offline outbox: no new op kind, no import of it", () => {
    const root = path.resolve(__dirname, "../..");
    for (const file of ["lib/job-parts.ts", "components/workshop/my-job-parts.tsx", "lib/floor-attendance.ts"]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/from "@\/lib\/offline\/(outbox|sync)"/);
      expect(text, file).not.toMatch(/enqueue|queueOp|syncNow/);
    }
    const outbox = readFileSync(path.join(root, "lib/offline/outbox.ts"), "utf8");
    expect(outbox).not.toMatch(/log_job_parts|job_part_logs/i);
  });
});
