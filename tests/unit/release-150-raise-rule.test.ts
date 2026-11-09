/**
 * Release 150 raise rule, read as text from supabase/release/150_ai_cap_key_off.release.sql (no database).
 * Raise set  = cap exactly 500 AND no ai_helper_settings_updated audit row carrying monthly_cap_pence AND an audit row with source ai_helper.
 * Flag set   = the complement among 500 rows (explicit save OR no AI audit row at all).
 * The UPDATE sets 1000 only for the raise set. In-memory mutations of the SQL must each be rejected by the matcher.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(path.resolve(__dirname, "../../supabase/release/150_ai_cap_key_off.release.sql"), "utf8");

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const setConfig = (text: string, key: string): string => {
  const m = new RegExp(`SELECT set_config\\('${key}', ([\\s\\S]*?), TRUE\\);`).exec(text);
  if (!m) throw new Error(`no set_config for ${key}`);
  return norm(m[1]);
};

const EXPLICIT = "EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = s.organization_id AND a.action = 'ai_helper_settings_updated' AND a.entity_table = 'ai_helper_settings' AND a.metadata ? 'monthly_cap_pence')";
const AI_AUDIT = "EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = s.organization_id AND a.metadata ->> 'source' = 'ai_helper')";
const FROM = "FROM public.ai_helper_settings s WHERE s.monthly_cap_pence = 500 AND";
const AGG = "string_agg(s.organization_id::TEXT, ',' ORDER BY s.organization_id)";

const RAISE = `coalesce((SELECT ${AGG} ${FROM} NOT ${EXPLICIT} AND ${AI_AUDIT}), '')`;
const FLAG = `coalesce((SELECT ${AGG} ${FROM} (${EXPLICIT} OR NOT ${AI_AUDIT})), '')`;

function raiseRuleOk(text: string): boolean {
  try { return setConfig(text, "a150.raise_ids") === norm(RAISE) && updateOk(text); } catch { return false; }
}
function flagRuleOk(text: string): boolean {
  try { return setConfig(text, "a150.flag_ids") === norm(FLAG); } catch { return false; }
}
function updateOk(text: string): boolean {
  const m = /WITH raised AS \(\s*UPDATE public\.ai_helper_settings s SET monthly_cap_pence = (\d+)\s+WHERE ([\s\S]*?) RETURNING/.exec(text);
  if (!m) return false;
  return m[1] === "1000" && norm(m[2]) === "s.organization_id::TEXT = ANY (coalesce(string_to_array(nullif(current_setting('a150.raise_ids'), ''), ','), ARRAY[]::TEXT[]))";
}

/** Reference model of the rule over in-memory rows, to show raise and flag are a partition of the 500 rows and zero is never selected. */
type Row = { id: string; cap: number; explicitSave: boolean; aiAudit: boolean };
const raise = (rows: Row[]) => rows.filter(r => r.cap === 500 && !r.explicitSave && r.aiAudit).map(r => r.id);
const flag = (rows: Row[]) => rows.filter(r => r.cap === 500 && (r.explicitSave || !r.aiAudit)).map(r => r.id);

describe("release 150 cap raise rule (SQL text)", () => {
  it("raise set is exactly: cap 500, no explicit cap save, has an ai_helper audit row", () => {
    expect(raiseRuleOk(SQL)).toBe(true);
  });
  it("flag set is exactly the complement among 500 rows", () => {
    expect(flagRuleOk(SQL)).toBe(true);
  });
  it("raise and flag select the same 500 filter, the same predicates, and the UPDATE writes 1000 for the raise set only", () => {
    expect(updateOk(SQL)).toBe(true);
    const selectors = SQL.split("\n").filter(l => /^SELECT set_config\('a150\.(raise|flag)_ids'/.test(l));
    expect(selectors.length).toBe(2);
    for (const l of selectors) expect(l).toContain("s.monthly_cap_pence = 500");
    expect(SQL).not.toMatch(/monthly_cap_pence\s*=\s*0\b/);
    expect(SQL.match(/SET monthly_cap_pence = /g)!.length).toBe(1);
    expect(SQL).toMatch(/ALTER COLUMN monthly_cap_pence SET DEFAULT 1000/);
    // only the flag set is audited as flagged, only the raise set as raised
    expect(SQL).toMatch(/'ai_cap_review_flagged'[\s\S]*?a150\.flag_ids/);
  });
  it("reference model: raise and flag partition the 500 rows; zero and other caps are never selected", () => {
    const rows: Row[] = [
      { id: "a", cap: 500, explicitSave: false, aiAudit: true },
      { id: "b", cap: 500, explicitSave: true, aiAudit: true },
      { id: "c", cap: 500, explicitSave: false, aiAudit: false },
      { id: "d", cap: 500, explicitSave: true, aiAudit: false },
      { id: "e", cap: 0, explicitSave: false, aiAudit: true },
      { id: "f", cap: 0, explicitSave: false, aiAudit: false },
      { id: "g", cap: 1000, explicitSave: false, aiAudit: true },
    ];
    expect(raise(rows)).toEqual(["a"]);
    expect(flag(rows)).toEqual(["b", "c", "d"]);
    const all500 = rows.filter(r => r.cap === 500).map(r => r.id).sort();
    expect([...raise(rows), ...flag(rows)].sort()).toEqual(all500);
    for (const id of ["e", "f", "g"]) expect([...raise(rows), ...flag(rows)]).not.toContain(id);
  });

  describe("mutated SQL is rejected", () => {
    const rawRaise = /(SELECT set_config\('a150\.raise_ids'[\s\S]*?, TRUE\);)/.exec(SQL)![1];
    const mutate = (fn: (s: string) => string) => SQL.replace(rawRaise, fn(rawRaise));

    it("drops the NOT EXISTS (explicit save) clause", () => {
      const m = mutate(s => s.replace(/NOT EXISTS \(SELECT 1 FROM security_audit\.audit_log a WHERE a\.organization_id = s\.organization_id AND a\.action = 'ai_helper_settings_updated'[\s\S]*?'monthly_cap_pence'\) AND /, ""));
      expect(m).not.toBe(SQL);
      expect(raiseRuleOk(m)).toBe(false);
    });
    it("flips NOT EXISTS to EXISTS", () => {
      const m = mutate(s => s.replace("AND NOT EXISTS", "AND EXISTS"));
      expect(m).not.toBe(SQL);
      expect(raiseRuleOk(m)).toBe(false);
    });
    it("changes 500 to 0", () => {
      const m = mutate(s => s.replace("monthly_cap_pence = 500", "monthly_cap_pence = 0"));
      expect(m).not.toBe(SQL);
      expect(raiseRuleOk(m)).toBe(false);
    });
    it("drops the ai_helper audit requirement", () => {
      const m = mutate(s => s.replace(/ AND EXISTS \(SELECT 1 FROM security_audit\.audit_log a WHERE a\.organization_id = s\.organization_id AND a\.metadata ->> 'source' = 'ai_helper'\)/, ""));
      expect(m).not.toBe(SQL);
      expect(raiseRuleOk(m)).toBe(false);
    });
    it("changes the source required to something else", () => {
      const m = mutate(s => s.replace("'source' = 'ai_helper'", "'source' = 'release_150'"));
      expect(raiseRuleOk(m)).toBe(false);
    });
    it("changes the UPDATE value, or makes the UPDATE ignore the raise set", () => {
      expect(raiseRuleOk(SQL.replace("SET monthly_cap_pence = 1000", "SET monthly_cap_pence = 2000"))).toBe(false);
      const m = SQL.replace(/(WITH raised[\s\S]*?)current_setting\('a150\.raise_ids'\)/, "$1current_setting('a150.flag_ids')");
      expect(m).not.toBe(SQL);
      expect(raiseRuleOk(m)).toBe(false);
    });
    it("flag complement mutated (loses the OR NOT ai audit arm)", () => {
      const rawFlag = /(SELECT set_config\('a150\.flag_ids'[\s\S]*?, TRUE\);)/.exec(SQL)![1];
      const m = SQL.replace(rawFlag, rawFlag.replace(/ OR NOT EXISTS \(SELECT 1 FROM security_audit\.audit_log a WHERE a\.organization_id = s\.organization_id AND a\.metadata ->> 'source' = 'ai_helper'\)/, ""));
      expect(m).not.toBe(SQL);
      expect(flagRuleOk(m)).toBe(false);
    });
  });
});
