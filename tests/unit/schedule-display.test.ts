/**
 * Machine Schedule display preferences (Rhys, Fri 23 Oct: on every screen people can select or deselect what they see). The schedule is a
 * timeline, so COLUMN_TABLES holds a "schedule" entry (kind "elements") listing the parts of the screen. That entry is the single source:
 * the picker, Settings and the page all read it, and every isVisible("...") on the schedule names an element in it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { COLUMN_TABLES } from "@/lib/org-settings";

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const def = COLUMN_TABLES.find((table) => table.key === "schedule")!;
const keysIn = (source: string) => [...source.matchAll(/isVisible\("([a-z-]+)"\)/g)].map((match) => match[1]);
const SOURCES = ["app/(dashboard)/schedule/page.tsx", "components/machine-gantt.tsx", "components/machine-status-cards.tsx"].map(read);

describe("schedule display definition", () => {
  it("is one 'elements' entry in COLUMN_TABLES, all on by default, machine name, time axis and the two tables with actions locked on", () => {
    expect(def.kind).toBe("elements");
    expect(def.columns.filter((column) => column.locked).map((column) => column.key)).toEqual(["machine", "days", "jobs-table", "machines-table"]);
    expect(new Set(def.columns.map((column) => column.key)).size).toBe(def.columns.length);
    expect(COLUMN_TABLES.filter((table) => table.key !== "schedule").every((table) => !table.kind)).toBe(true);
    // Replaces the old "no other table has a locked column": every table's locked keys are real, unique keys of its own list.
    for (const table of COLUMN_TABLES) {
      const keys = table.columns.map((column) => column.key);
      const lockedKeys = table.columns.filter((column) => column.locked).map((column) => column.key);
      expect(new Set(lockedKeys).size, `${table.key} locked keys are unique`).toBe(lockedKeys.length);
      for (const key of lockedKeys) expect(keys, `${table.key}.${key} is in its own column list`).toContain(key);
    }
  });

  it("the Jobs on machines table (Book it / Update) and the Machines list (Add machine) are locked, so hiding cannot lose an action", () => {
    for (const key of ["jobs-table", "machines-table"]) expect(def.columns.find((column) => column.key === key)?.locked, key).toBe(true);
    const page = SOURCES[0];
    expect(page.slice(page.indexOf('isVisible("jobs-table")'))).toContain("Book it");
    expect(page.slice(page.indexOf('isVisible("machines-table")'))).toContain("Add machine");
  });

  it("the page, timeline and cards use only elements the picker lists, and every element is used", () => {
    const used = new Set(SOURCES.flatMap(keysIn));
    const listed = def.columns.map((column) => column.key);
    for (const key of used) expect(listed, `isVisible("${key}") is in the schedule definition`).toContain(key);
    // machine and days are locked and drawn without isVisible; every other element must be honoured.
    for (const key of listed.filter((k) => k !== "machine" && k !== "days")) expect([...used], `"${key}" is honoured on the page`).toContain(key);
  });

  it("the page mounts the picker for the schedule definition, and Settings lists every table in COLUMN_TABLES", () => {
    expect(SOURCES[0]).toContain('<ColumnToggle tableKey="schedule"');
    // Settings lists every COLUMN_TABLES entry in order (directly, or through screensByGroup once the Display frame is in).
    expect(read("app/(dashboard)/settings/page.tsx")).toMatch(/COLUMN_TABLES\.map\(|screensByGroup\(\)\.map\(/);
    expect(read("components/column-toggle.tsx")).toContain("COLUMN_TABLES.find");
  });

  it("bar buttons keep an accessible name from the tooltip text when their labels are hidden", () => {
    const gantt = read("components/machine-gantt.tsx");
    expect(gantt).toContain("title={bookingTitle(seg, machine)}");
    expect(gantt).toContain('isVisible("bar-labels") ? undefined : bookingTitle(seg, machine)');
  });
});
