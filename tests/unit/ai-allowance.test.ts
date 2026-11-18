import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_REQUESTS_PER_MONTH,
  allowancePeriod,
  canReserve,
  emptyUsage,
  isValidUsage,
  remainingRequests,
  reserve,
  resetIfNewMonth,
  tierAllowance,
} from "../../lib/ai-helper/allowance";

const NOV = new Date("2026-11-18T10:00:00Z");

describe("AI monthly request allowance", () => {
  it("tiers are 100 / 400 / 1500 requests", () => {
    expect(ALLOWANCE_REQUESTS_PER_MONTH).toEqual({ small: 100, medium: 400, large: 1500 });
    expect(tierAllowance("small")).toBe(100);
    expect(tierAllowance("medium")).toBe(400);
    expect(tierAllowance("large")).toBe(1500);
  });

  it("unknown tiers get no allowance", () => {
    for (const t of ["", "huge", "toString", "__proto__", "SMALL"]) {
      expect(tierAllowance(t)).toBeNull();
      expect(remainingRequests(t, emptyUsage(NOV), NOV)).toBe(0);
      expect(canReserve(t, emptyUsage(NOV), NOV)).toBe(false);
    }
  });

  it("period is the UTC month, across year and timezone edges", () => {
    expect(allowancePeriod(NOV)).toBe("2026-11");
    expect(allowancePeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(allowancePeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    expect(allowancePeriod(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01");
  });

  it("remaining counts down and never goes below zero", () => {
    expect(remainingRequests("small", { period: "2026-11", used: 0 }, NOV)).toBe(100);
    expect(remainingRequests("small", { period: "2026-11", used: 40 }, NOV)).toBe(60);
    expect(remainingRequests("small", { period: "2026-11", used: 100 }, NOV)).toBe(0);
    expect(remainingRequests("small", { period: "2026-11", used: 250 }, NOV)).toBe(0);
  });

  it("can-reserve respects the boundary and bad counts", () => {
    const u = { period: "2026-11", used: 99 };
    expect(canReserve("small", u, NOV)).toBe(true);
    expect(canReserve("small", u, NOV, 1)).toBe(true);
    expect(canReserve("small", u, NOV, 2)).toBe(false);
    expect(canReserve("small", { period: "2026-11", used: 100 }, NOV)).toBe(false);
    for (const c of [0, -1, 1.5, Number.NaN, Infinity]) expect(canReserve("large", emptyUsage(NOV), NOV, c)).toBe(false);
  });

  it("monthly reset: a new month starts at zero, the same month is untouched", () => {
    const old = { period: "2026-10", used: 100 };
    expect(resetIfNewMonth(old, NOV)).toEqual({ period: "2026-11", used: 0 });
    expect(remainingRequests("small", old, NOV)).toBe(100);
    expect(canReserve("small", old, NOV)).toBe(true);
    const same = { period: "2026-11", used: 7 };
    expect(resetIfNewMonth(same, NOV)).toBe(same);
  });

  it("reserve returns new usage, rolls the month, and refuses when full without mutating", () => {
    const u = { period: "2026-11", used: 98 };
    expect(reserve("small", u, NOV, 2)).toEqual({ period: "2026-11", used: 100 });
    expect(u).toEqual({ period: "2026-11", used: 98 });
    expect(reserve("small", u, NOV, 3)).toBeNull();
    expect(reserve("small", { period: "2026-10", used: 100 }, NOV)).toEqual({ period: "2026-11", used: 1 });
    expect(reserve("nope", emptyUsage(NOV), NOV)).toBeNull();
  });

  describe("malformed usage is rejected (fails closed)", () => {
    const bad: Array<[string, number]> = [
      ["negative", -1],
      ["large negative", -5],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
    ];
    for (const [label, used] of bad) {
      for (const period of ["2026-11", "2026-10"]) {
        it(`${label} used (${period}): invalid, remaining 0, cannot reserve, reserve null`, () => {
          const u = { period, used };
          expect(isValidUsage(u)).toBe(false);
          expect(remainingRequests("large", u, NOV)).toBe(0);
          expect(canReserve("large", u, NOV)).toBe(false);
          expect(reserve("large", u, NOV)).toBeNull();
        });
      }
    }

    it("non-number / bad period / null record are invalid", () => {
      for (const u of [
        { period: "2026-11", used: "5" },
        { period: "2026-11", used: undefined },
        { period: 202611, used: 0 },
        { used: 0 },
        null,
      ]) {
        expect(isValidUsage(u as never)).toBe(false);
        expect(remainingRequests("small", u as never, NOV)).toBe(0);
        expect(canReserve("small", u as never, NOV)).toBe(false);
        expect(reserve("small", u as never, NOV)).toBeNull();
      }
    });

    it("valid records stay valid: zero and whole numbers", () => {
      expect(isValidUsage({ period: "2026-11", used: 0 })).toBe(true);
      expect(isValidUsage({ period: "2026-11", used: 100 })).toBe(true);
      expect(isValidUsage(emptyUsage(NOV))).toBe(true);
    });
  });
});
