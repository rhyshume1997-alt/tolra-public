import { describe, expect, it } from "vitest";

import { COLUMN_TABLES, DISPLAY_GROUPS, resetHiddenColumns, screensByGroup, screensForSettings, setItemShown, shownCount } from "@/lib/org-settings";

const locked = { key: "t", label: "T", columns: [{ key: "a", label: "A", locked: true }, { key: "b", label: "B" }, { key: "c", label: "C" }] };

describe("Settings > Display registry", () => {
  it("lists every COLUMN_TABLES screen in order, each with a known group and a description", () => {
    const screens = screensForSettings();
    expect(screens.map((s) => s.key)).toEqual(COLUMN_TABLES.map((t) => t.key));
    for (const s of screens) {
      expect(DISPLAY_GROUPS).toContain(s.group);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.columns).toEqual(COLUMN_TABLES.find((t) => t.key === s.key)?.columns);
    }
    expect(screens.find((s) => s.key === "customers")?.group).toBe("Tables");
  });

  it("groups in DISPLAY_GROUPS order and drops empty groups; an entry's own group wins", () => {
    const grouped = screensByGroup([
      { ...locked, key: "x", group: "Dashboard", description: "d" },
      { ...locked, key: "y", group: "Tables", description: "d" },
    ]);
    expect(grouped.map((g) => g.group)).toEqual(["Tables", "Dashboard"]);
  });

  it("counts n of m shown, locked items always shown", () => {
    expect(shownCount(locked, [])).toEqual({ shown: 3, total: 3 });
    expect(shownCount(locked, ["b", "a"])).toEqual({ shown: 2, total: 3 });
  });

  it("ticks and unticks, and never hides a locked item", () => {
    expect(setItemShown(locked, [], "b", false)).toEqual(["b"]);
    expect(setItemShown(locked, ["b"], "b", false)).toEqual(["b"]);
    expect(setItemShown(locked, ["b", "c"], "b", true)).toEqual(["c"]);
    expect(setItemShown(locked, ["a"], "a", false)).toEqual([]);
  });

  it("resets one screen, or all registered screens, and keeps unrelated keys", () => {
    const hidden = { customers: ["phone"], quotes: ["date"], other: ["z"] };
    expect(resetHiddenColumns(hidden, ["customers"])).toEqual({ quotes: ["date"], other: ["z"] });
    expect(resetHiddenColumns(hidden)).toEqual({ other: ["z"] });
    expect(hidden.customers).toEqual(["phone"]);
  });
});
