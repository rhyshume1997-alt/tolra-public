import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Static guard: nothing in lib/reports (top level) writes to the database. Comments are stripped first so prose cannot trip or hide a match.
const DIR = join(process.cwd(), "lib/reports");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const code = (file: string) => readFileSync(join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("reports are read-only", () => {
  it("finds the report files", () => {
    expect(files).toEqual(expect.arrayContaining(["load-reports.ts", "reports-switch.ts", "on-time-completion.ts", "wip-ageing.ts"]));
  });
  it.each(files)("%s uses no insert, update, delete, upsert or rpc", (file) => {
    expect(code(file)).not.toMatch(/\.\s*(insert|update|delete|upsert|rpc)\s*\(/);
  });
  it("the loader only selects", () => {
    expect(code("load-reports.ts")).toMatch(/\.select\(/);
  });
});
