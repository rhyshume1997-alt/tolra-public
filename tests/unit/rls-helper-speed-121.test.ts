/** 121 (S11): _session_membership keeps 119's query word for word and only changes the language that runs it (plan kept). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { releaseSql } from "../../scripts/release-sql.mjs";
import { injectCandidates, injectPoint } from "../rehearsal/inject-point";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
const FILE = "121_rls_helper_speed.sql";
const HEAD = "CREATE OR REPLACE FUNCTION public._session_membership()";
const END = "REVOKE ALL ON FUNCTION public._session_membership() FROM PUBLIC, anon, authenticated;";
const definition = (sql: string) => {
  const start = sql.indexOf(HEAD);
  return sql.slice(start, sql.indexOf(END, start) + END.length);
};
const body = (def: string) => {
  const start = def.indexOf("AS $$") + "AS $$".length;
  return def.slice(start, def.indexOf("$$;", start));
};
const M036 = "a15c6833cefc4b752ceafce0a10730b2";
const M119 = "dd70574344856582b9819431b45e6c5c";
const M121 = "4fa415c7b3222def6c37e93353e804c2";
const m119 = () => definition(read("supabase/migrations/119_ban_ends_session.sql"));
const m121 = () => read(path.join("supabase/migrations", FILE));

describe("121 rls helper speed (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    expect(read("supabase/release/121_rls_helper_speed.release.sql")).toBe(releaseSql(m121(), FILE));
  });

  it("runs 119's query unchanged, through PL/pgSQL RETURN QUERY, with 119's signature, security, search_path and grants", () => {
    const def = definition(m121());
    const b = body(def);
    expect(b.startsWith("\n#variable_conflict use_column\nBEGIN\n  RETURN QUERY\n")).toBe(true);
    expect(b.endsWith("\n  ;\nEND\n")).toBe(true);
    const query = b.slice(b.indexOf("RETURN QUERY\n") + "RETURN QUERY\n".length, b.lastIndexOf("\n  ;\nEND"));
    expect(query).toBe(body(m119()).replace(/^\n/, "").replace(/\n$/, ""));
    expect(query).toContain("AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id AND u.banned_until > now())");
    expect(md5(body(m119()))).toBe(M119);
    expect(md5(query)).toBe(M119);
    expect(md5(b)).toBe(M121);
    expect(def.slice(0, def.indexOf("AS $$")).replace("LANGUAGE plpgsql", "LANGUAGE sql")).toBe(m119().slice(0, m119().indexOf("AS $$")));
  });

  it("replaces only _session_membership: no table, row, index, policy, trigger or other grant", () => {
    const sql = m121();
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((m) => m[1])).toEqual(["public._session_membership"]);
    const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(outside).not.toMatch(/^\s*(CREATE|ALTER|DROP|UPDATE|INSERT|DELETE|GRANT|TRUNCATE)\b(?! OR REPLACE FUNCTION public\._session_membership\(\))/m);
    expect(outside.match(/^REVOKE .*$/gm)).toEqual([END]);
  });

  it("guard requires 119's body (or 121's); self-check, verify and preflight name them; the rollback puts back 119's text exactly", () => {
    expect(m121()).toContain(`v_member NOT IN ('${M119}', '${M121}')`);
    expect(m121()).not.toContain(`'${M036}'`);
    // 119 can be re-run after 121 (the run sheet and the rehearsal re-run every file in order): its guard accepts 121's body too.
    expect(read("supabase/migrations/119_ban_ends_session.sql")).toContain(`v_member NOT IN ('${M036}', '${M119}', '${M121}')`);
    expect(read("supabase/verify/rls_helper_speed_121.sql")).toContain(`body = '${M121}'`);
    const preflight = read("supabase/verify/release_preflight.sql");
    expect(preflight).toContain(`('121 rls helper speed',              EXISTS (SELECT 1 FROM fn WHERE nspname = 'public' AND proname = '_session_membership' AND md5(regexp_replace(prosrc, '\\s', '', 'g')) = '${M121}'))`);
    // 119's marker still reads "applied" once 121 has replaced the body.
    expect(preflight).toContain(`proname = '_session_membership' AND md5(regexp_replace(prosrc, '\\s', '', 'g')) IN ('${M119}', '${M121}'))),`);
    const rollback = read("supabase/release/121_rls_helper_speed.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback).toContain(m119());
    for (const h of [M119, M121]) expect(rollback).toContain(`'${h}'`);
  });

  it("upgrade rehearsal: middle and late points fall after the function; the probe is its new body (by md5 of the stored text)", () => {
    const ls = m121().split("\n");
    const prosrc = body(definition(m121()));
    for (const where of ["middle", "late"] as const) {
      const at = injectPoint(ls, where)!;
      const above = ls.slice(0, at).join("\n");
      expect(above, where).toContain(HEAD);
      // The function itself already exists before 121 runs, so the rehearsal skips that candidate and probes the new body.
      expect(injectCandidates(above).map((c) => c.what), where).toEqual(["function public._session_membership", "body of public._session_membership"]);
      expect(injectCandidates(above)[1].exists).toContain(`md5(p.prosrc) = '${createHash("md5").update(prosrc, "utf8").digest("hex")}'`);
    }
    expect(injectPoint(ls, "late")).toBeGreaterThan(injectPoint(ls, "middle")!);
  });
});
