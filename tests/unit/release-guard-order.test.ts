/**
 * Release order guards. The plan (supabase/release-plan.json "after" chain), supabase/verify/release_preflight.sql and the
 * release headers all say 144, 145, 146, 147, 148, 149, 150, 151 in that order. A release applied out of order must be refused
 * by its OWN guard, testing an object its predecessor creates (not by calling the preflight). Static checks; the behavioural
 * proof is tests/db/release-order-guards.test.ts. Also pins the header comments that used to contradict the plan.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseSql } from "../../scripts/release-sql.mjs";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const plan = JSON.parse(read("supabase/release-plan.json"));
const release = (n: number) => plan.phases.find((p: { number: number }) => p.number === n).release as string;
/** The text of the release's DO $post_release_guard$ ... END block. */
function guard(n: number) {
  const sql = read(release(n));
  const start = sql.indexOf("DO $post_release_guard$");
  const end = sql.indexOf("END $post_release_guard$;");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}
/** Each guard must test an object its predecessor creates, and refuse with a message that names the predecessor release. */
const predecessor: Array<[number, number, string, RegExp]> = [
  [149, 148, "to_regclass('public.job_costing_settings') IS NULL", /149: required release 148 \(job costing\) is missing; stop and check release preflight/],
  [150, 149, "to_regclass('public.xero_transfer_hold') IS NULL", /150: required release 149 \(the Xero transfer switch\) is missing; stop and check release preflight/],
  [151, 150, "to_regprocedure('public.ai_helper_tolra_remove_key(uuid,text)') IS NULL", /151: required release 150 \(AI cap and key-off\) is missing; stop and check release preflight/],
];

describe("each release refuses to run before the release the plan says it follows", () => {
  it.each(predecessor)("%i's guard tests an object that %i creates and says so", (n, _prev, test, message) => {
    const g = guard(n);
    expect(g).toContain(test);
    expect(g).toMatch(message);
  });

  it("the objects the new guards test are created by the predecessor release, and not by anything older", () => {
    const created = (n: number, text: string) => expect(read(release(n))).toContain(text);
    created(148, "CREATE TABLE public.job_costing_settings");
    created(149, "CREATE TABLE public.xero_transfer_hold");
    created(150, "CREATE FUNCTION public.ai_helper_tolra_remove_key");
    for (const old of [145, 146, 147]) {
      expect(read(release(old))).not.toContain("job_costing_settings");
      expect(read(release(old))).not.toContain("xero_transfer_hold");
    }
  });

  it("144 refuses when 107 (integrations connect) is missing, in the migration and in its release text", () => {
    const migration = read("supabase/migrations/144_accounting_connections.sql");
    // The guard sits after the first new function (the upgrade rehearsal needs something created before its mid-file failure point) and before anything existing is altered.
    const at = migration.indexOf("DO $guard$ BEGIN");
    expect(at).toBeGreaterThan(-1);
    const g = migration.slice(at, migration.indexOf("END $guard$;"));
    const firstAlteration = migration.search(/^(ALTER|DROP) /m);
    expect(firstAlteration).toBeGreaterThan(-1);
    expect(at).toBeLessThan(firstAlteration);
    expect(migration.indexOf("CREATE OR REPLACE FUNCTION public.accounting_cloud_enqueue()")).toBeLessThan(at);
    expect(g).toContain("to_regclass('public.integration_app_credentials') IS NULL");
    expect(g).toContain("to_regclass('public.integration_connect_invites') IS NULL");
    expect(g).toMatch(/RAISE EXCEPTION '144: release 107 \(integrations connect\) is not in place; stop and check release preflight'/);
    // The release text is exactly the wrapping of the migration (accounting-sql-shape.test.ts says the same).
    expect(read("supabase/release/144_accounting_connections.release.sql")).toBe(releaseSql(migration, "144_accounting_connections.sql"));
  });

  it("the plan chain is 144 then 145 .. 151, each one after the one before", () => {
    expect(plan.phases.map((p: { number: number; after: string }) => [p.number, p.after])).toEqual([[145, "144"], [146, "145"], [147, "146"], [148, "147"], [149, "148"], [150, "149"], [151, "150"]]);
  });
});

describe("headers say what the plan says", () => {
  const line1 = (file: string) => read(file).split("\n")[0];
  it("151's release, verify and proposal say it is registered (after 150), not a proposal outside the plan or CI", () => {
    for (const file of ["supabase/release/151_xero_invite_hardening.release.sql", "supabase/verify/xero_invite_hardening_151.sql", "supabase/proposals/p151_xero_invite_hardening.sql"]) {
      expect(line1(file)).not.toMatch(/PROPOSAL|not registered|not in supabase\/migrations|not in release-plan\.json|not in CI/);
      expect(line1(file)).toMatch(/registered/);
      expect(line1(file)).toMatch(/after 150/);
    }
    // The same sentence is repeated inside the release (the body is the proposal's text), and must not contradict either.
    expect(read("supabase/release/151_xero_invite_hardening.release.sql")).not.toMatch(/PROPOSAL/);
    expect(read("supabase/proposals/p151_xero_invite_hardening.sql")).not.toMatch(/PROPOSAL/);
  });
  it("151 says it follows 107 and 150", () => {
    const head = read(release(151)).split("\n").slice(0, 4).join("\n");
    expect(head).toMatch(/Apply only after 107 and 150/);
    expect(head).not.toMatch(/107 and 149/);
  });
  it("149 says it follows 148", () => {
    const head = read(release(149)).split("\n").slice(0, 6).join("\n");
    expect(head).toMatch(/Apply only after 148/);
    expect(head).not.toMatch(/after 147 \(/);
  });
  it("143's order list names every release in the plan, in order", () => {
    const text = read("supabase/release/143_costing_rates.release.sql").split("\n").slice(0, 12).join("\n");
    expect(text).toMatch(/order 138, 140, 141, 143, 144, 145, 146, 147, 148, 149, 150, 151\)/);
  });
  it("144 says it needs 107 and that the guard enforces it", () => {
    const text = read("supabase/migrations/144_accounting_connections.sql").split("\n").slice(0, 12).join("\n");
    expect(text).toMatch(/Prerequisite: 107 \(checked below/);
  });
  it("ci.yml's comment above the post-144 step no longer says it prepares only 145 and 146", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toContain("prepare/verify 145 and 146");
    expect(ci).not.toContain("Post-144 release plan: 145 N5 then 146 N2/cap; proofs remain mandatory.");
  });
});
