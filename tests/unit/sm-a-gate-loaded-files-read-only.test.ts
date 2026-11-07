/**
 * Every SQL file the production readiness gate loads must be read-only. The gate (scripts/release-readiness-gate.mjs) loads:
 *   supabase/verify/release_readiness_gate.sql, supabase/verify/release_preflight.sql, and the verify file of each release in VERIFY_RELEASES (143..152).
 * It also runs inside BEGIN READ ONLY and always rolls back (so a write would raise 25006), but this test checks the files themselves:
 * no INSERT/UPDATE/DELETE/DDL/privilege/lock/notify keyword in code, no function that writes or has side effects, every query_to_xml() argument is a SELECT.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VERIFY_RELEASES, assertSelectOnly } from "../../scripts/release-readiness-gate.mjs";

const root = path.resolve(__dirname, "../..");
const dir = path.join(root, "supabase/verify");
const all = readdirSync(dir);
const loaded: string[] = [
  "release_readiness_gate.sql",
  "release_preflight.sql",
  ...(VERIFY_RELEASES as string[]).map((n) => all.find((f) => f.endsWith(`_${n}.sql`)) ?? `MISSING_${n}`),
];

/** SQL with comments and ordinary single-quoted strings blanked; dollar-quoted $q$...$q$ bodies are KEPT (they are passed to query_to_xml and so are code). */
function code(sql: string): string {
  const noComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const keepDollar: string[] = [];
  const masked = noComments.replace(/\$([a-z_]*)\$([\s\S]*?)\$\1\$/gi, (_m, _tag, body) => { keepDollar.push(body); return " "; });
  const noStrings = masked.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  return `${noStrings}\n${keepDollar.join("\n")}`;
}

const FORBIDDEN = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do|vacuum|analyze|reindex|cluster|lock|listen|notify|unlisten|prepare|execute|begin|commit|rollback|savepoint|set|reset|discard|refresh|security|import|merge)\b/i;
/** Functions these files call that are not plain reads would be listed here; the allow-list is the complete set found in the 11 files. */
const ALLOWED_FUNCTIONS = new Set([
  "acldefault", "aclexplode", "btrim", "current_setting", "has_column_privilege", "has_function_privilege", "has_table_privilege", "now", "nullif",
  "pg_get_constraintdef", "pg_get_functiondef", "pg_get_indexdef", "pg_get_triggerdef", "pg_has_role", "public.job_cost_round", "query_to_xml", "row_number",
  "split_part", "substring", "xpath",
]);
const SQL_WORDS = new Set(["in", "as", "exists", "and", "or", "not", "from", "where", "values", "on", "select", "with", "over", "filter", "using", "any", "all", "array", "coalesce", "case", "when", "then", "else", "end", "join", "left", "right", "cross", "lateral", "union", "between", "like", "is", "by", "order", "group", "limit", "offset", "having", "distinct", "unnest", "count", "sum", "min", "max", "string_agg", "bool_and", "bool_or", "jsonb_build_object", "jsonb_agg", "jsonb_each", "jsonb_object_keys", "array_agg", "length", "lower", "upper", "substr", "position", "replace", "regexp_replace", "md5", "concat", "format", "to_regclass", "to_regprocedure", "to_regproc", "to_jsonb", "row_to_json", "bit_and", "every"]);

describe("the SQL files the readiness gate loads are read-only", () => {
  it("lists exactly the expected files and all exist", () => {
    expect(loaded).toHaveLength(2 + 10);
    expect(loaded.filter((f) => f.startsWith("MISSING_"))).toEqual([]);
  });

  it.each(loaded)("%s: the gate's own SELECT-only guard accepts it", (file) => {
    expect(() => assertSelectOnly(readFileSync(path.join(dir, file), "utf8"))).not.toThrow();
  });

  it.each(loaded)("%s: no write, DDL, privilege, lock, notify or session-state keyword in code", (file) => {
    const hit = FORBIDDEN.exec(code(readFileSync(path.join(dir, file), "utf8")));
    expect(hit?.[0] ?? null, `${file}: forbidden keyword ${hit?.[0]}`).toBeNull();
  });

  it("calls only catalogue/privilege/read functions (a complete allow-list)", () => {
    const seen = new Map<string, string>();
    for (const file of loaded) {
      for (const m of code(readFileSync(path.join(dir, file), "utf8")).matchAll(/\b([a-z_][a-z0-9_.]*)\s*\(/gi)) {
        const name = m[1].toLowerCase();
        if (!SQL_WORDS.has(name) && !seen.has(name)) seen.set(name, file);
      }
    }
    const unknown = [...seen].filter(([name]) => !ALLOWED_FUNCTIONS.has(name));
    // Names that are not functions but look like it in this dialect (CTE column lists, VALUES aliases) are the only extra tokens; any real function must be in the allow-list.
    const nonCte = unknown.filter(([name]) => !/^(api|checks|expected|helpers|internal|markers|post_release_markers|proposal_files|t|want)$/.test(name));
    expect(nonCte, `unreviewed function call(s): ${JSON.stringify(nonCte)}`).toEqual([]);
  });

  it("every query_to_xml() argument is a SELECT", () => {
    const bad: string[] = [];
    for (const file of loaded) {
      const sql = readFileSync(path.join(dir, file), "utf8").replace(/--[^\n]*/g, " ");
      for (const m of sql.matchAll(/query_to_xml\(\s*(\$([a-z_]*)\$([\s\S]*?)\$\2\$|'((?:[^']|'')*)')/gi)) {
        const body = (m[3] ?? (m[4] ?? "").replace(/''/g, "'")).trim();
        if (!/^select\b/i.test(body)) bad.push(`${file}: ${body.slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the gate runs everything inside a READ ONLY transaction that is rolled back", () => {
    const src = readFileSync(path.join(root, "scripts/release-readiness-gate.mjs"), "utf8");
    expect(src).toMatch(/BEGIN READ ONLY/);
    expect(src).toMatch(/ROLLBACK/);
    expect(src).not.toMatch(/\bCOMMIT\b/);
  });

  it("self-check: the scanners would catch a write, a side-effect function and a non-SELECT query_to_xml", () => {
    expect(FORBIDDEN.test(code("SELECT 1; INSERT INTO t VALUES (1)"))).toBe(true);
    expect(FORBIDDEN.test(code("SELECT 1 /* update */ -- delete\n, 'drop' AS word"))).toBe(false); // comments and strings are ignored
    expect(FORBIDDEN.test(code("SELECT $q$UPDATE t SET a = 1$q$"))).toBe(true); // dollar-quoted bodies are code
    const fnNames = [...code("SELECT pg_advisory_lock(1), nextval('s')").matchAll(/\b([a-z_][a-z0-9_.]*)\s*\(/gi)].map((m) => m[1].toLowerCase());
    expect(fnNames.filter((n) => !ALLOWED_FUNCTIONS.has(n) && !SQL_WORDS.has(n))).toEqual(["pg_advisory_lock", "nextval"]);
    expect(() => assertSelectOnly("DELETE FROM t")).toThrow();
  });
});
