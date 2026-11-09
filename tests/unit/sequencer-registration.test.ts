import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { post144ExtraProofFiles, post144ProofFiles, releaseRank } from "../support/db-release-sequencer";

// A DB test that installs the post-144 releases (preparePost144Fixture / preparePost144Backend, or an import of the
// fixture) must be in post144ExtraProofFiles or post144ProofFiles. Unlisted files rank 0 (baseline) and would install
// 145..151 in the middle of the frozen baseline checks. No test file is legitimately baseline while using the fixture.
const dbDir = join(__dirname, "..", "db");
const FIXTURE_USE = /preparePost144(?:Fixture|Backend)|post-144-release-fixture/;
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function scanDbTests(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".test.ts")) out.set(`${prefix}${entry.name}`, FIXTURE_USE.test(stripComments(readFileSync(join(dir, entry.name), "utf8"))));
    }
  };
  walk(dbDir, "");
  return out;
}

/** scanned: relative path under tests/db -> uses the post-144 fixture. */
export function compare(scanned: Map<string, boolean>, registered: readonly string[]) {
  const reg = new Set(registered);
  return {
    unregistered: [...scanned].filter(([name, uses]) => uses && !reg.has(name)).map(([name]) => name).sort(),
    missingOnDisk: registered.filter(name => !scanned.has(name)).sort(),
  };
}

const registered = [...post144ExtraProofFiles, ...post144ProofFiles];

describe("db release sequencer registration", () => {
  const scanned = scanDbTests();

  it("scans a plausible set of DB tests", () => {
    expect(scanned.size).toBeGreaterThan(50);
    expect([...scanned.values()].filter(Boolean).length).toBeGreaterThan(10);
  });

  it("registers every DB test that uses the post-144 fixture, and every registered name exists", () => {
    expect(compare(scanned, registered)).toEqual({ unregistered: [], missingOnDisk: [] });
  });

  it("has no duplicate entries across the two lists", () => {
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("ranks every registered file after baseline and every fixture user is ranked", () => {
    for (const name of registered) expect(releaseRank(`/x/tests/db/${name}`)).toBe(1);
    for (const [name, uses] of scanned) if (uses) expect(releaseRank(`/x/tests/db/${name}`)).toBe(1);
  });

  it("self-check: reports an extra unregistered fixture user", () => {
    const mutated = new Map(scanned).set("zz-new-post-144-proof.test.ts", true);
    expect(compare(mutated, registered).unregistered).toEqual(["zz-new-post-144-proof.test.ts"]);
  });

  it("self-check: does not flag an unregistered file that does not use the fixture", () => {
    const mutated = new Map(scanned).set("zz-baseline.test.ts", false);
    expect(compare(mutated, registered)).toEqual({ unregistered: [], missingOnDisk: [] });
  });

  it("self-check: reports a registered file deleted from disk", () => {
    const mutated = new Map(scanned);
    mutated.delete(post144ProofFiles[0]);
    expect(compare(mutated, registered).missingOnDisk).toEqual([post144ProofFiles[0]]);
  });
});
