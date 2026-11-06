/**
 * Mutation-style guard for tests/db/release-upgrade-populated-145-151.test.ts (read as text, no database).
 * The populated upgrade test fingerprints every pre-existing table over its pre-release columns. Exactly two columns are deliberately
 * excluded because release 150/151 change them on purpose; this proves no third exclusion can slip in unnoticed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FILE = path.resolve(__dirname, "../db/release-upgrade-populated-145-151.test.ts");
const SOURCE = readFileSync(FILE, "utf8");

const EXPECTED = [
  { table: "integration_connect_invites", column: "revoked_at" },
  { table: "ai_helper_settings", column: "monthly_cap_pence" },
];

/** Every statement that narrows a table's fingerprint column list, parsed strictly. Returns null for any statement of another shape. */
function exclusionStatements(text: string): string[] {
  return text.split("\n").map(l => l.trim()).filter(l => /^preCols\[[^\]]+\]\s*=/.test(l) && !/^preCols\[t\.table_name\]\s*=/.test(l));
}
function parseExclusions(text: string): Array<{ table: string; column: string }> {
  return exclusionStatements(text).map(s => {
    const m = /^preCols\["(\w+)"\] = preCols\["\1"\]\.filter\(c => c !== "(\w+)"\);$/.exec(s);
    if (!m) throw new Error(`unrecognised fingerprint exclusion: ${s}`);
    return { table: m[1], column: m[2] };
  });
}
/** Applies the parsed exclusions to a column list the way the DB test does. */
function applyExclusions(table: string, cols: string[], ex: Array<{ table: string; column: string }>): string[] {
  return ex.filter(e => e.table === table).reduce((acc, e) => acc.filter(c => c !== e.column), cols);
}
function matches(text: string): boolean {
  try { return JSON.stringify(parseExclusions(text)) === JSON.stringify(EXPECTED); } catch { return false; }
}

describe("populated 145-151 fingerprint exclusions", () => {
  it("excludes exactly integration_connect_invites.revoked_at and ai_helper_settings.monthly_cap_pence", () => {
    expect(parseExclusions(SOURCE)).toEqual(EXPECTED);
    expect(matches(SOURCE)).toBe(true);
  });

  it("uses no other form of column filtering on the fingerprint column lists", () => {
    // any .filter( applied to a preCols entry, however written, must be one of the two statements
    const filterLines = SOURCE.split("\n").filter(l => /preCols\[[^\]]*\][^\n]*\.filter\(/.test(l));
    expect(filterLines.length).toBe(2);
    expect(SOURCE).not.toMatch(/delete\s+preCols\[/);
    expect(SOURCE).not.toMatch(/preCols\[[^\]]+\]\s*=\s*\[/);
  });

  it("removes only the named column and keeps every other column, so a change in any other column is still fingerprinted", () => {
    const ex = parseExclusions(SOURCE);
    const invites = ["id", "organization_id", "provider", "token_hash", "created_by", "created_at", "expires_at", "used_at", "revoked_at", "revoked_by"];
    expect(applyExclusions("integration_connect_invites", invites, ex)).toEqual(invites.filter(c => c !== "revoked_at"));
    const ai = ["organization_id", "roundup_enabled", "rfq_enabled", "monthly_cap_pence", "api_key_last4"];
    expect(applyExclusions("ai_helper_settings", ai, ex)).toEqual(ai.filter(c => c !== "monthly_cap_pence"));
    // a table with no exclusion is untouched
    expect(applyExclusions("customers", ["id", "name"], ex)).toEqual(["id", "name"]);
  });

  it("rejects mutated sources (extra exclusion, widened column, wrong table, dropped exclusion)", () => {
    const first = exclusionStatements(SOURCE)[0];
    const second = exclusionStatements(SOURCE)[1];
    // extra exclusion added
    expect(matches(SOURCE.replace(second, `${second}\n  preCols["quotes"] = preCols["quotes"].filter(c => c !== "total");`))).toBe(false);
    // revoked_at exclusion widened to used_at
    expect(matches(SOURCE.replace(first, first.replace("revoked_at", "used_at")))).toBe(false);
    // cap exclusion moved to the wrong column
    expect(matches(SOURCE.replace(second, second.replace("monthly_cap_pence", "api_key_last4")))).toBe(false);
    // exclusion applied to the wrong table
    expect(matches(SOURCE.replace(first, first.replace(/integration_connect_invites/g, "customers")))).toBe(false);
    // an exclusion removed
    expect(matches(SOURCE.replace(first, ""))).toBe(false);
    expect(matches(SOURCE.replace(second, ""))).toBe(false);
    // multi-column filter smuggled in
    expect(matches(SOURCE.replace(first, first.replace('c !== "revoked_at"', 'c !== "revoked_at" && c !== "used_at"')))).toBe(false);
  });
});
