/**
 * The four ordered release catalogues must agree: supabase/release-plan.json, tests/support/post-144-release-fixture.ts, the install loop in
 * .github/workflows/ci.yml and scripts/ci-schema-markers.sh. Everything is read as text and parsed by regex; nothing is executed.
 * The mutation self-checks (in memory) prove the comparison can fail.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const text = (file: string) => readFileSync(path.join(root, file), "utf8");

type Entry = { number: number; marker: string; verify: string; release: string | null };
type Catalogues = { plan: Entry[]; planPost: Entry[]; fixture: Entry[]; ci: Entry[]; script: Entry[] };

const verifyName = (file: string) => path.basename(file, ".sql");
const numberOf = (name: string) => Number(/_(\d+)$/.exec(name)?.[1] ?? NaN);

type PlanRow = { number: number; release: string; rollback: string; verify: string; marker: string; migration?: string };
const planJson = JSON.parse(text("supabase/release-plan.json")) as { jnr_cutover_numbered_order: PlanRow[]; phases: PlanRow[] };
const toEntry = (r: PlanRow): Entry => ({ number: r.number, marker: r.marker, verify: verifyName(r.verify), release: r.release });

function parseFixture(src: string): Entry[] {
  return [...src.matchAll(/\{ number: (\d+), marker: "([^"]+)", file: "([^"]+)", verifyFile: "([^"]+)" \}/g)]
    .map(m => ({ number: Number(m[1]), marker: m[2], verify: verifyName(m[4]), release: m[3] }));
}
function parseCi(src: string): Entry[] {
  const line = src.split("\n").find(l => /for phase in "\d+_[a-z_0-9]+\|/.test(l));
  if (!line) throw new Error("ci.yml install loop not found");
  return [...line.matchAll(/"(\d+_[^"|]+)\|([^"|]+)\|([^"|]+)"/g)]
    .map(m => ({ number: numberOf(m[2]), marker: m[3], verify: m[2], release: `supabase/release/${m[1]}.release.sql` }));
}
/** Script rows are "marker <n> <name>|<verify>|<n> <name> applied"; the label must match the marker. */
function parseScript(src: string): Entry[] {
  return [...src.matchAll(/"([^"|]+)\|([a-z_0-9]+)\|([^"|]+ applied)"/g)].map(m => {
    const marker = m[1].replace(/^marker (?=\d)/, "");
    const label = m[3].replace(/ applied$/, "");
    const verify = m[2];
    // Release files are not named in the script; a label that disagrees with its marker is carried in the marker so it fails the comparison.
    const bareMarker = marker.replace(/^post-144 marker /, "");
    return { number: numberOf(verify), marker: label === bareMarker ? marker : `${marker} (label "${label}")`, verify, release: null };
  });
}

function load(): Catalogues {
  const planPost = planJson.phases.map(toEntry);
  return {
    planPost,
    plan: [...planJson.jnr_cutover_numbered_order.map(toEntry), ...planPost],
    fixture: parseFixture(text("tests/support/post-144-release-fixture.ts")),
    ci: parseCi(text(".github/workflows/ci.yml")),
    script: parseScript(text("scripts/ci-schema-markers.sh")),
  };
}

/** Returns a list of human-readable mismatches; empty means the catalogues agree. */
function compare(c: Catalogues): string[] {
  const out: string[] = [];
  const check = (label: string, expected: Entry[], actual: Entry[]) => {
    if (expected.map(e => e.number).join() !== actual.map(e => e.number).join())
      out.push(`${label}: phase numbers/order [${actual.map(e => e.number)}] != [${expected.map(e => e.number)}]`);
    expected.forEach((e, i) => {
      const a = actual[i];
      if (!a) return;
      if (a.marker !== e.marker) out.push(`${label}[${i}]: marker "${a.marker}" != "${e.marker}"`);
      if (a.verify !== e.verify) out.push(`${label}[${i}]: verify "${a.verify}" != "${e.verify}"`);
      if (a.release !== null && e.release !== null && a.release !== e.release) out.push(`${label}[${i}]: release "${a.release}" != "${e.release}"`);
    });
  };
  check("fixture", c.planPost, c.fixture);
  check("ci.yml", c.planPost, c.ci);
  check("ci-schema-markers.sh", c.plan, c.script);
  // The verify name must agree across fixture, ci.yml and the script for each post-144 phase.
  c.planPost.forEach((e, i) => {
    const names = [c.fixture[i]?.verify, c.ci[i]?.verify, c.script[c.plan.length - c.planPost.length + i]?.verify];
    if (new Set(names).size !== 1) out.push(`phase ${e.number}: verify names differ across fixture/ci/script: ${names.join(" | ")}`);
  });
  return out;
}

describe("release catalogue consistency", () => {
  const real = load();

  it("parses every catalogue (guards against a regex silently matching nothing)", () => {
    expect(real.planPost.map(p => p.number)).toEqual([145, 146, 147, 148, 149, 150, 151, 152]);
    expect(real.plan.length).toBeGreaterThan(real.planPost.length);
    for (const key of ["fixture", "ci", "script"] as const) expect(real[key].length, key).toBeGreaterThanOrEqual(real.planPost.length);
  });

  it("plan, fixture, ci.yml and ci-schema-markers.sh agree on numbers, order, markers and verify names", () => {
    expect(compare(real)).toEqual([]);
  });

  it("every release, rollback, verify and migration file named in the plan exists on disk", () => {
    const missing: string[] = [];
    for (const row of [...planJson.jnr_cutover_numbered_order, ...planJson.phases]) {
      for (const f of [row.release, row.rollback, row.verify, row.migration]) if (f && !existsSync(path.join(root, f))) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it("the fixture and ci.yml release/verify paths exist on disk", () => {
    const missing: string[] = [];
    for (const e of [...real.fixture, ...real.ci]) {
      if (e.release && !existsSync(path.join(root, e.release))) missing.push(e.release);
      if (!existsSync(path.join(root, "supabase/verify", `${e.verify}.sql`))) missing.push(`supabase/verify/${e.verify}.sql`);
    }
    for (const e of real.script) if (!existsSync(path.join(root, "supabase/verify", `${e.verify}.sql`))) missing.push(`supabase/verify/${e.verify}.sql`);
    expect(missing).toEqual([]);
  });

  describe("mutation self-checks (in memory)", () => {
    const clone = (): Catalogues => structuredClone(real);

    it("reports a mismatch when two phases are swapped", () => {
      const c = clone();
      [c.ci[0], c.ci[1]] = [c.ci[1], c.ci[0]];
      expect(compare(c).length).toBeGreaterThan(0);
      const s = clone();
      const n = s.script.length;
      [s.script[n - 1], s.script[n - 2]] = [s.script[n - 2], s.script[n - 1]];
      expect(compare(s).length).toBeGreaterThan(0);
    });

    it("reports a mismatch when one marker is renamed", () => {
      for (const key of ["fixture", "ci", "script"] as const) {
        const c = clone();
        c[key][c[key].length - 1].marker += "_renamed";
        expect(compare(c).length, key).toBeGreaterThan(0);
      }
    });

    it("reports a mismatch when one verify name disagrees", () => {
      const c = clone();
      c.fixture[2].verify += "_x";
      expect(compare(c).some(m => m.includes("verify"))).toBe(true);
    });

    it("reports a mismatch when one phase is dropped", () => {
      for (const key of ["fixture", "ci", "script"] as const) {
        const c = clone();
        c[key].splice(3, 1);
        expect(compare(c).length, key).toBeGreaterThan(0);
      }
    });
  });
});
