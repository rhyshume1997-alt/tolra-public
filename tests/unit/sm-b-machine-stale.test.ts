/**
 * sm-b (3): a machine run left open across cutover. The database marks a run stale after 12 hours (machines_in_use(), migration 044:
 * started_at < now() - 12 h); the app also applies the rule by its own clock. A stale run still occupies its machine (it stays in
 * byMachine, so a Start on it still gets machine_in_use); only the label changes and an admin can release it.
 */
import { describe, expect, it } from "vitest";

import { indexInUse, inUseRows, inUseText, isStale, STALE_AFTER_MS, type InUseRow } from "@/lib/machine-runs";

const base: InUseRow = { run_id: "r1", machine_id: "m1", machine_name: "Mill", job_id: "j1", job_no: "J-1", booking_id: null, operator_id: "u1", operator_name: "Dave", started_at: "2026-10-12T08:00:00Z", stale: false };
const at = (ms: number) => new Date(new Date(base.started_at).getTime() + ms);

describe("sm-b: stale-after-12h rule", () => {
  it("is 12 hours", () => expect(STALE_AFTER_MS).toBe(12 * 3_600_000));
  it("by the clock: stale from exactly 12h, not a millisecond before", () => {
    expect(isStale(base, at(STALE_AFTER_MS - 1))).toBe(false);
    expect(isStale(base, at(STALE_AFTER_MS))).toBe(true);
  });
  it("a run left open across a cutover weekend is stale, and keeps the machine occupied", () => {
    const now = at(60 * 3_600_000);
    expect(isStale(base, now)).toBe(true);
    expect(inUseText(base, now)).toContain("(no Finish or Pause for 12 h+)");
    expect(indexInUse([base]).byMachine.get("m1")?.job_id).toBe("j1");
  });
  it("the server's stale flag wins even when the clock says fresh (the page's clock may be behind)", () => {
    expect(isStale({ ...base, stale: true }, at(1000))).toBe(true);
  });
  it("only a literal true from the server counts as stale", () => {
    const [r] = inUseRows([{ ...base, stale: "true" }]);
    expect(r.stale).toBe(false);
  });
});
