/**
 * The upgrade rehearsal (tests/rehearsal/upgrade.test.ts, injectionPlan) injects a failing statement part-way through the newest
 * migration and needs something the part above the point creates. CI run 1185 failed because 144 began with a 107 guard, so nothing
 * was created before the middle point. This pins that selection for 144 and for every migration numbered 138 or later, in the fast suite.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { injectCandidates, injectPoint } from "../rehearsal/inject-point";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const WHERES = ["middle", "late"] as const;

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && Number.parseInt(f, 10) >= 138)
  .sort();
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");

/** What the rehearsal computes: the injection line and the candidates for the text above it. */
function plan(text: string, where: (typeof WHERES)[number]) {
  const lines = text.split("\n");
  const at = injectPoint(lines, where);
  const candidates = at === undefined ? [] : injectCandidates(lines.slice(0, at).join("\n"));
  return { at, candidates };
}

describe("rehearsal injection point: every migration numbered 138 or later", () => {
  it("finds the migrations", () => {
    expect(files).toContain("144_accounting_connections.sql");
  });

  for (const file of files) {
    for (const where of WHERES) {
      it(`${file} (${where}): a positive injection line with candidates above it`, () => {
        const { at, candidates } = plan(read(file), where);
        expect(at, "injection point").toBeGreaterThan(0);
        expect(candidates.length, "candidates above the injection point").toBeGreaterThan(0);
      });
    }
  }
});

describe("144_accounting_connections.sql", () => {
  const text = read("144_accounting_connections.sql");

  for (const where of WHERES) {
    it(`${where}: the candidates include the function created before the point`, () => {
      const { at, candidates } = plan(text, where);
      expect(at).toBeGreaterThan(0);
      expect(candidates.length).toBeGreaterThan(0);
      if (where === "middle") expect(candidates.map((c) => c.what)).toContain("function public.accounting_cloud_enqueue");
    });
  }

  it("the 107 guard sits after the first CREATE OR REPLACE FUNCTION and before the first ALTER/DROP", () => {
    const guard = text.indexOf("DO $guard$");
    const fn = text.search(/^CREATE OR REPLACE FUNCTION/m);
    const alterOrDrop = text.search(/^(ALTER|DROP)/m);
    expect(guard).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(-1);
    expect(alterOrDrop).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(fn);
    expect(guard).toBeLessThan(alterOrDrop);
  });

  it("self-check: with the guard moved to the top the middle candidates are empty (run 1185)", () => {
    const block = text.match(/DO \$guard\$ BEGIN[\s\S]*?END \$guard\$;\n/);
    expect(block).not.toBeNull();
    const mutated = block![0] + text.replace(block![0], "");
    expect(mutated.indexOf("DO $guard$")).toBeLessThan(mutated.search(/^CREATE OR REPLACE FUNCTION/m));
    expect(plan(mutated, "middle").candidates).toEqual([]);
  });
});
