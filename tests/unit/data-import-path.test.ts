/**
 * Admin > Data import: a file small enough commits in one call, a larger one goes in parts (lib/data-import.ts; migration 076), and the
 * part weight the app uses is the database's default.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { IMPORT_PART_WEIGHT, SINGLE_CALL_MAX_AUDIT_ROWS, importPath } from "@/lib/data-import";

describe("importPath", () => {
  it("one call up to the limit, parts above it", () => {
    expect(importPath({ records: 300, lines: 400, audit_rows: 700 })).toEqual({ mode: "single" });
    expect(importPath({ records: 900, lines: 900, audit_rows: SINGLE_CALL_MAX_AUDIT_ROWS })).toEqual({ mode: "single" });
    // JNR's SliQ file: 5,480 records, 3,400 lines, 8,880 audit rows (13 s in one call: over Supabase's 8 s).
    expect(importPath({ records: 5480, lines: 3400, audit_rows: 8880 })).toEqual({ mode: "parts", partWeight: IMPORT_PART_WEIGHT, estimatedParts: 18 });
  });

  it("the part weight is the one import_validate uses by default (076)", () => {
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_data_import.sql"))!;
    const sql = readFileSync(path.join(dir, file), "utf8");
    expect(sql).toContain(`v_weight  INT := coalesce(p_part_weight, ${IMPORT_PART_WEIGHT});`);
  });
});
