/**
 * Approval Queue display preferences: COLUMN_TABLES "approvals" is the one definition of the page's fields, in rendered order.
 * The page must test every optional field through isVisible() in that order, never test a locked one, and the picker (Columns
 * button, Settings > Display) must offer exactly the unlocked ones. Permissions and the approve path are not in this list.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { cleanColumns, COLUMN_TABLES, columnVisibility } from "@/lib/org-settings";

const source = (file: string) => readFileSync(path.resolve(__dirname, `../../${file}`), "utf8");
const def = COLUMN_TABLES.find((table) => table.key === "approvals")!;

describe("approvals display definition", () => {
  it("is defined once, with the recipient, Subject line and To address locked on and every other field optional", () => {
    expect(COLUMN_TABLES.filter((table) => table.key === "approvals")).toHaveLength(1);
    expect(def.columns.map((c) => c.key)).toEqual(["type", "customer", "detail", "drafted", "to", "subject", "preview"]);
    expect(def.columns.filter((c) => c.locked).map((c) => c.key)).toEqual(["customer", "detail", "to"]);
  });

  it("the page tests exactly the optional fields, in definition order, and wires the Columns button", () => {
    const page = source("app/(dashboard)/approval/page.tsx");
    const keys = [...page.matchAll(/isVisible\("([a-z]+)"\)/g)].map((m) => m[1]);
    expect(keys).toEqual(def.columns.filter((c) => !c.locked).map((c) => c.key));
    expect(page).toContain('useColumnVisibility("approvals")');
    expect(page).toContain('<ColumnToggle tableKey="approvals" />');
  });

  it("a locked field is forced visible even if a crafted hidden_columns row lists it", () => {
    // Core store: locked keys are stripped from saved hidden sets and forced visible.
    const isVisible = columnVisibility("approvals", ["customer", "detail", "to", "type"]);
    expect(["customer", "detail", "to"].every(isVisible)).toBe(true);
    expect(isVisible("type")).toBe(false);
    expect(cleanColumns({ approvals: ["customer", "detail", "to", "type"] })).toEqual({ approvals: ["type"] });
  });

  it("the picker and Settings show locked fields ticked and disabled; the approve and skip actions are not gated by any field", () => {
    expect(source("components/column-toggle.tsx")).toContain("checked={isLocked(column.key) || isVisible(column.key)}");
    expect(source("components/column-toggle.tsx")).toContain("disabled={isLocked(column.key)}");
    expect(source("app/(dashboard)/settings/page.tsx")).toContain("disabled={column.locked}");
    const page = source("app/(dashboard)/approval/page.tsx");
    for (const action of ["Mark as Sent Manually", "Copy to Clipboard", "Skip", "Edit"]) {
      const at = page.indexOf(`>${action}<`) >= 0 ? page.indexOf(`>${action}<`) : page.indexOf(action);
      expect(page.slice(Math.max(0, at - 160), at)).not.toContain("isVisible(");
    }
  });
});
