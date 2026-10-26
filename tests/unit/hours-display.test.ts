/**
 * Weekly hours display drift guard: COLUMN_TABLES "hours" (lib/org-settings, the Columns picker and Settings > Table Columns list) is the single
 * definition of which columns the Weekly hours screen can show or hide. The This week table's header cells and body cells, and the Today tab's
 * totals, must walk it in order (header count == cell count). The person and Paid (the daily and week total) are always shown, so they are
 * not in the list and are never behind isVisible. Display only: neither screen computes a figure from the picker.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { COLUMN_TABLES, isColumnLocked as isLockedColumn } from "@/lib/org-settings";

const read = (file: string) => readFileSync(path.resolve(__dirname, `../../components/time/${file}`), "utf8");
const keysIn = (source: string) => [...source.matchAll(/isVisible\("([a-z-]+)"\)/g)].map((match) => match[1]);
const unique = (keys: string[]) => keys.filter((key, i) => keys.indexOf(key) === i);
const picker = COLUMN_TABLES.find((def) => def.key === "hours")!.columns.map((column) => column.key);

describe("weekly hours display: one column list for both tabs", () => {
  it("is defined once, in rendered order, with the person and Paid left out because they are locked on", () => {
    expect(picker).toEqual(["days", "clocked", "breaks", "jobs", "unallocated", "ticks", "check", "approval"]);
    expect(COLUMN_TABLES.filter((def) => def.key === "hours")).toHaveLength(1);
    expect(picker).not.toContain("paid");
    expect(picker).not.toContain("person");
  });

  it("locks Clocked (context beside Person), Check and Approval on; everything else can be hidden", () => {
    const def = COLUMN_TABLES.find((d) => d.key === "hours")!;
    expect(def.columns.filter((c) => c.locked).map((c) => c.key)).toEqual(["clocked", "check", "approval"]);
    for (const key of ["clocked", "check", "approval"]) expect(isLockedColumn("hours", key)).toBe(true);
    for (const key of ["days", "breaks", "jobs", "unallocated", "ticks"]) expect(isLockedColumn("hours", key)).toBe(false);
    // The core locks every table's reference column; hours locks only its own three.
    expect(isLockedColumn("quotes", "ref")).toBe(true);
    expect(isLockedColumn("quotes", "date")).toBe(false);
  });

  it("This week: header cells and body cells both walk the picker's list in order (Today-only 'unallocated' aside)", () => {
    const source = read("week-review.tsx");
    const start = source.indexOf('data-testid="week-table"');
    const headEnd = source.indexOf("</thead>", start);
    const bodyEnd = source.indexOf("</tbody>", headEnd);
    const expected = picker.filter((key) => key !== "unallocated");
    expect(unique(keysIn(source.slice(start, headEnd)))).toEqual(expected);
    expect(unique(keysIn(source.slice(headEnd, bodyEnd)))).toEqual(expected);
    // Each gated header has exactly one gated cell: same count either side.
    expect(keysIn(source.slice(start, headEnd)).length).toBe(keysIn(source.slice(headEnd, bodyEnd)).length);
    expect(source).toContain('<ColumnToggle tableKey="hours"');
    // Paid is never gated, and the empty-state row spans exactly the shown columns.
    expect(source.slice(start, bodyEnd)).not.toMatch(/isVisible\("paid"\)/);
    expect(source).toContain("colSpan={shownColumns}");
  });

  it("Today: the totals walk the picker's list in order (Paid always shown)", () => {
    const source = read("day-sheet.tsx");
    const start = source.indexOf('data-testid="day-totals"');
    const end = source.indexOf("</div>", start);
    const block = source.slice(start, end);
    expect(keysIn(block)).toEqual(["clocked", "breaks", "jobs", "unallocated"]);
    expect(block).toContain('<StatTile label="Paid"');
    expect(block).not.toMatch(/isVisible\("paid"\)/);
    expect(source).toContain('<ColumnToggle tableKey="hours"');
  });

  it("only changes what is displayed: neither screen takes a figure from the picker", () => {
    for (const file of ["week-review.tsx", "day-sheet.tsx"]) {
      const source = read(file);
      // isVisible only ever appears in JSX conditions or the column count, never inside a calculation or a lib/time-* call.
      const uses = source.split("\n").filter((line) => line.includes("isVisible"));
      for (const line of uses) expect(line, line).toMatch(/\{isVisible\("[a-z]+"\) \?|showFlags && isVisible|\.filter\(isVisible\)|useColumnVisibility/);
    }
  });

  it("keeps Save suggested ticks in the always-shown actions cell, so hiding Day ticks does not lose it", () => {
    const source = read("week-review.tsx");
    const button = source.indexOf('data-testid="save-suggested-ticks"');
    const cellStart = source.lastIndexOf("<td", button);
    expect(source.slice(cellStart, button)).not.toContain("week-day-flags");
    expect(source.slice(cellStart, button)).not.toContain("isVisible");
    // Not behind isVisible("ticks"): the only line mentioning it is the header/cell/count, none of which contain the button.
    const line = source.split("\n").find((l) => l.includes("save-suggested-ticks"))!;
    expect(line).not.toContain('isVisible("ticks")');
  });
});
