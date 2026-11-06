/**
 * Mutation tests for scripts/check-release-plan.mjs. The checker reads a repo root, so each case builds a temp root in os.tmpdir whose
 * supabase/{proposals,release,verify,migrations} are symlinks to the real directories and whose release-plan.json is an in-memory mutation.
 * The unmutated plan must pass first, so a rejection is attributable to the mutation alone.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkReleasePlan } from "../../scripts/check-release-plan.mjs";

const REPO = path.resolve(__dirname, "../..");
type Phase = { number: number; after: string; source: string; release: string; rollback: string; verify: string; marker: string };
type Plan = { phases: Phase[]; [k: string]: unknown };
const REAL: Plan = JSON.parse(readFileSync(path.join(REPO, "supabase/release-plan.json"), "utf8"));
const roots: string[] = [];

function run(mutate: (plan: Plan) => void): string[] {
  const plan: Plan = structuredClone(REAL);
  mutate(plan);
  const root = mkdtempSync(path.join(os.tmpdir(), "release-plan-"));
  roots.push(root);
  mkdirSync(path.join(root, "supabase"));
  for (const d of ["proposals", "release", "verify", "migrations"]) symlinkSync(path.join(REPO, "supabase", d), path.join(root, "supabase", d), "dir");
  writeFileSync(path.join(root, "supabase/release-plan.json"), JSON.stringify(plan));
  return checkReleasePlan(root);
}

afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe("check-release-plan rejects mutated plans", () => {
  it("accepts the real plan unchanged (baseline)", () => {
    expect(run(() => {})).toEqual([]);
  });
  it("rejects a duplicate phase number", () => {
    const problems = run(p => { p.phases[1].number = p.phases[0].number; });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/number collision|Wrong release order/);
  });
  it("rejects a number that collides with a numbered migration", () => {
    const problems = run(p => { p.phases[0].number = 144; });
    expect(problems.join("\n")).toMatch(/number collision|Wrong release order/);
  });
  it("rejects a missing rollback path", () => {
    const problems = run(p => { p.phases[2].rollback = "supabase/release/does_not_exist.rollback.sql"; });
    expect(problems).toContain("Missing rollback: supabase/release/does_not_exist.rollback.sql");
  });
  it("rejects a phase with its rollback field removed", () => {
    expect(() => run(p => { delete (p.phases[2] as Partial<Phase>).rollback; })).toThrow();
  });
  it("rejects swapped order", () => {
    const problems = run(p => { [p.phases[0], p.phases[1]] = [p.phases[1], p.phases[0]]; });
    expect(problems.join("\n")).toMatch(/Wrong release order/);
  });
  it("rejects an unknown proposal", () => {
    const problems = run(p => { (p.other_proposals as Array<{ source: string; disposition: string }>).push({ source: "supabase/proposals/not_a_real_proposal.sql", disposition: "x" }); });
    expect(problems).toContain("Unknown proposal in release plan: supabase/proposals/not_a_real_proposal.sql");
  });
  it("rejects a real proposal dropped from the plan", () => {
    const problems = run(p => { (p.other_proposals as unknown[]).shift(); });
    expect(problems.join("\n")).toMatch(/Proposal missing from release plan/);
  });
  it("rejects a proposal listed twice", () => {
    const problems = run(p => { p.phases[1].source = p.phases[0].source; });
    expect(problems).toContain("Proposal appears more than once in release plan");
  });
});
