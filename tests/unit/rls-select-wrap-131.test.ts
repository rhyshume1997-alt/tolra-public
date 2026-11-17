/**
 * 131: every role / company helper call in a policy is written (SELECT call), so PostgreSQL asks it once per statement. These checks pin
 * that the files change nothing else: the rewrite is main's own policy text with only those calls wrapped (the rollback holds main's
 * text), the same 182 policies everywhere, no other statement, and every md5 tied to the catalogue snapshot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { releaseSql } from "../../scripts/release-sql.mjs";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const FILE = "131_rls_select_wrap.sql";
const m131 = () => read(path.join("supabase/migrations", FILE));
const rollback = () => read("supabase/release/131_rls_select_wrap.rollback.sql");
const verify = () => read("supabase/verify/rls_select_wrap_131.sql");
const COUNT = 182;

type Alter = { key: string; using?: string; check?: string };
/** Every ALTER POLICY in the text (outside DO bodies), with the USING and WITH CHECK text it sets. */
function alters(sql: string): Alter[] {
  const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
  return [...outside.matchAll(/^ALTER POLICY "((?:[^"]|"")+)" ON (\w+\.\w+)((?:\n {2}(?:USING|WITH CHECK) \([^;]*\))+);$/gm)].map((m) => {
    const clauses = m[3].split(/\n {2}(?=USING \(|WITH CHECK \()/).filter(Boolean);
    const inner = (prefix: string) => {
      const c = clauses.find((x) => x.startsWith(prefix));
      return c === undefined ? undefined : c.slice(prefix.length, -1);
    };
    return { key: `${m[2]} :: ${m[1].replace(/""/g, '"')}`, using: inner("USING ("), check: inner("WITH CHECK (") };
  });
}
/** The policies a VALUES list names, as "schema.table :: name", with the md5s that follow the roles. */
function listed(sql: string) {
  return [...sql.matchAll(/^ {4}\('(\w+)', '(\w+)', '((?:[^']|'')+)', '(PERMISSIVE|RESTRICTIVE)', '(\w+)', '(\{[\w,]+\})', '([0-9a-f]{32})'(?:, '([0-9a-f]{32})')?\)/gm)].map((m) => ({
    key: `${m[1]}.${m[2]} :: ${m[3].replace(/''/g, "'")}`,
    prefix: `${m[4]} ${m[5]} ${m[6].slice(1, -1)}`,
    md5s: m[8] ? [m[7], m[8]] : [m[7]],
  }));
}
const HELPER = /\(SELECT ((?:has_org_role|current_user_organization_id|user_organization_id|auth\.uid)\(([^()]*)\))\)/g;
const unwrap = (text: string) => text.replace(HELPER, "$1");

describe("131 rls select wrap (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    expect(read("supabase/release/131_rls_select_wrap.release.sql")).toBe(releaseSql(m131(), FILE));
  });

  it("only ALTER POLICY ... USING / WITH CHECK: no TO, no other DDL, no grant, no data", () => {
    const outside = m131().replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/^--.*$/gm, "");
    const statements = outside.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
    const kinds = statements.map((s) => (s.startsWith("ALTER POLICY ") ? "alter" : s.startsWith("DO $$") ? "do" : s));
    expect(kinds.filter((k) => k !== "alter" && k !== "do")).toEqual(["SELECT pg_catalog.set_config('search_path', 'public, extensions', TRUE)"]);
    // The guard, 2c (public.legacy_audit_log's policy, only where the legacy import made that table) and the self-check.
    expect(kinds.filter((k) => k === "do")).toHaveLength(3);
    expect(alters(m131())).toHaveLength(COUNT);
    expect(outside).not.toMatch(/^\s+TO\s/m);
  });

  it("each rewrite is the rollback's (main's) text with only helper calls wrapped; the rollback sets exactly the same clauses", () => {
    const back = new Map(alters(rollback()).map((a) => [a.key, a]));
    const wrapped: string[] = [];
    for (const a of alters(m131())) {
      const b = back.get(a.key)!;
      expect(b, a.key).toBeDefined();
      expect([a.using === undefined, a.check === undefined], a.key).toEqual([b.using === undefined, b.check === undefined]);
      for (const [mine, main] of [[a.using, b.using], [a.check, b.check]]) {
        if (mine === undefined) continue;
        expect(unwrap(mine), a.key).toBe(main);
        expect(mine, a.key).not.toBe(main);
        expect(main, a.key).not.toMatch(/\(SELECT /);
        for (const m of mine.matchAll(HELPER)) wrapped.push(m[1]);
      }
    }
    expect(back.size).toBe(COUNT);
    expect(wrapped).toHaveLength(440);
    // Only literal arguments: the call means the same for every row of the statement.
    for (const call of wrapped) expect(call).toMatch(/^[\w.]+\((|ARRAY\['[a-z]+'::text(, '[a-z]+'::text)*\]|'\{[a-z,]+\}'::text\[\])\)$/);
  });

  it("guard, self-check, rollback and verify name the same 182 policies once each; their md5s and attributes are the catalogue's", () => {
    const keys = alters(m131()).map((a) => a.key).sort();
    expect(new Set(keys).size).toBe(COUNT);
    // The DO blocks that carry a list (the two that set legacy_audit_log's policy carry none).
    const lists = [...m131().split("DO $$").slice(1), ...rollback().split("DO $$").slice(1)].map(listed).filter((l) => l.length);
    expect(lists).toHaveLength(4);
    for (const l of lists) expect(l.map((x) => x.key).sort()).toEqual(keys);
    const ver = listed(verify());
    expect(ver.map((x) => x.key).sort()).toEqual(keys);
    expect(alters(rollback()).map((a) => a.key).sort()).toEqual(keys);
    // Every list carries the same main / 131 md5 pair; verify carries the 131 one.
    const pair = new Map(lists[0].map((x) => [x.key, x.md5s.join("/")]));
    for (const l of lists) for (const x of l) expect(x.md5s.join("/"), x.key).toBe(pair.get(x.key));
    for (const x of ver) expect(x.md5s[0], x.key).toBe(pair.get(x.key)!.split("/")[1]);
    // The catalogue snapshot (public and storage.objects policies) holds 131's md5 and the same kind, command and roles.
    const snap = new Map((JSON.parse(read("tests/db/catalogue.snapshot.json")) as { kind: string; object: string; detail: string }[])
      .filter((r) => r.kind === "policy").map((r) => [r.object, r.detail]));
    let inSnapshot = 0;
    for (const x of ver) {
      if (x.key.startsWith("security_audit.")) continue;
      inSnapshot += 1;
      expect(snap.get(x.key), x.key).toBe(`${x.prefix} ${x.md5s[0]}`);
    }
    expect(inSnapshot).toBe(COUNT - 1);
  });

  it("public.legacy_audit_log (the legacy import's table, no migration's): rewritten only where it is there, as the import script now writes it", () => {
    const LEG = /DO \$\$\nBEGIN\n {2}IF to_regclass\('public\.legacy_audit_log'\) IS NOT NULL THEN\n {4}-- [^\n]*\n {4}ALTER POLICY "legacy_audit_log admins read" ON public\.legacy_audit_log\n {6}USING \(([^\n]*)\);\n {2}END IF;\nEND\n\$\$;/g;
    const set = [...m131().matchAll(LEG)].map((m) => m[1]);
    const back = [...rollback().matchAll(LEG)].map((m) => m[1]);
    expect(set).toHaveLength(1);
    expect(back).toHaveLength(1);
    // The rollback's text is how pg_policies prints the import script's text before 131 (the same text as the live audit log's admin read).
    expect(back[0]).toBe("((organization_id = current_user_organization_id()) AND has_org_role(ARRAY['admin'::text]))");
    expect(unwrap(set[0])).toBe(back[0]);
    expect([...set[0].matchAll(HELPER)].map((m) => m[1])).toEqual(["current_user_organization_id()", "has_org_role(ARRAY['admin'::text])"]);
    const audit = alters(m131()).find((a) => a.key === "security_audit.audit_log :: audit admins read org")!;
    expect(audit.using).toBe(set[0]);
    // Guard (both md5s), self-check (131's) and the rollback's guard and self-check (main's) check the policy where the table is there.
    const md5s = listed(m131().split("DO $$")[1]).find((x) => x.key === "security_audit.audit_log :: audit admins read org")!.md5s;
    for (const [text, okList] of [[m131(), [md5s.join("', '"), md5s[1]]], [rollback(), [[...md5s].reverse().join("', '"), md5s[0]]]] as const) {
      for (const ok of okList) expect(text).toContain(`WHERE {ATTR} OR md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) NOT IN ('${ok}')`.replace("{ATTR}", "p.policyname IS NULL OR p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT' OR p.roles::TEXT <> '{authenticated}'"));
    }
    // The import script writes 131's form (schema-qualified), and verify's legacy row wants 131's md5.
    const imp = read("supabase/import/import_legacy_tenant.sql");
    expect(imp).toContain(`CREATE POLICY "legacy_audit_log admins read" ON public.legacy_audit_log FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin'])));`);
    expect(verify()).toContain(`AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '${md5s[1]}');`);
    expect(read("supabase/verify/rls_select_wrap_131_precheck.sql")).toContain(`'${md5s[0]}', '${md5s[1]}', (SELECT m FROM leg), (SELECT state FROM leg),`);
  });

  it("the production precheck is one read-only SELECT over the same 182 policies and md5 pairs", () => {
    const pre = read("supabase/verify/rls_select_wrap_131_precheck.sql");
    const code = pre.replace(/^--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
    expect(code.split(";").map((s) => s.trim()).filter(Boolean)).toHaveLength(1);
    expect(code.trim().startsWith("WITH want(")).toBe(true);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE|COPY|DO|BEGIN|COMMIT|SET|set_config)\b/i);
    const pair = new Map(listed(m131().split("DO $$")[1]).map((x) => [x.key, x.md5s.join("/")]));
    const rows = listed(pre);
    expect(rows.map((x) => x.key).sort()).toEqual([...pair.keys()].sort());
    for (const x of rows) expect(x.md5s.join("/"), x.key).toBe(pair.get(x.key));
  });

  it("the rollback is one transaction; the preflight marker names 131's text of invoices rbac select", () => {
    expect(rollback().match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback().trimEnd().endsWith("COMMIT;")).toBe(true);
    const inv = listed(verify()).find((x) => x.key === "public.invoices :: invoices rbac select")!;
    const preflight = read("supabase/verify/release_preflight.sql");
    expect(preflight).toContain("('131 rls select wrap',");
    expect(preflight).toContain(`AND p.policyname = 'invoices rbac select'\n                                                 AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '${inv.md5s[0]}'))`);
    expect(preflight.indexOf("('131 rls select wrap'")).toBeGreaterThan(preflight.indexOf("('126 booking time zero quote guards'"));
  });
});

/**
 * Release 159 changes exactly two of the 182 policies on purpose ("job drawings org update": USING false, WITH CHECK false; "job drawings org
 * delete": USING false). 131's verify accepts exactly two texts for each of those two rows and nothing else: 131's md5 and 159's md5 (no
 * comment or other trace is read: COMMENT ON POLICY needs ownership of storage.objects). The checks below pin that the file accepts exactly
 * those values, that every other row is unchanged, and that the values agree with 159's own files. The behaviour (and the FALSE cases)
 * is proved on a database in tests/db/drawings-update-roles-159.test.ts.
 */
describe("131's verify accepts exactly two texts for each of release 159's two policies and nothing else", () => {
  const KEY = "storage.objects :: job drawings org update";
  const KEY_DEL = "storage.objects :: job drawings org delete";
  const md5 = (text: string) => createHash("md5").update(text).digest("hex");
  const code = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
  const release159 = () => read("supabase/release/159_drawings_update_roles.release.sql");
  const rollback159 = () => read("supabase/release/159_drawings_update_roles.rollback.sql");
  const verify159 = () => read("supabase/verify/drawings_update_roles_159.sql");
  const proposal159 = () => read("supabase/proposals/p159_drawings_update_roles.sql");
  const preflight = () => read("supabase/verify/release_preflight.sql");
  const M131 = () => listed(verify()).find((x) => x.key === KEY)!.md5s[0];
  const M131_DEL = () => listed(verify()).find((x) => x.key === KEY_DEL)!.md5s[0];
  /** pg_policies prints USING (false) as "false" and WITH CHECK (false) as "false": the md5 the database computes is of "false|false". */
  const M159 = md5("false|false");
  /** The delete policy has USING (false) and no WITH CHECK (NULL, which the formula reads as ''): the md5 the database computes is of "false|". */
  const M159_DEL = md5("false|");
  const TWO_TEXT = /AND \(h\.m = w\.md5_131\s+OR \(\(w\.schema_name, w\.table_name, w\.policy_name, h\.m\) IN \(\('storage', 'objects', 'job drawings org update', '([0-9a-f]{32})'\),\s+\('storage', 'objects', 'job drawings org delete', '([0-9a-f]{32})'\)\)\)\)\)/g;

  it("the list rows of the two drawings policies are still 131's md5, the same as the 131 lists, the precheck and the catalogue snapshot; no row carries two values", () => {
    for (const [key, m] of [[KEY, "76e489d7de7f079451629dc75177d894"], [KEY_DEL, "2b7ec566b4506d9dc5918f7b02dd8374"]] as const) {
      const row = listed(verify()).find((x) => x.key === key)!;
      expect(row.md5s, key).toEqual([m]);
      const inLists = listed(m131().split("DO $$")[1]).find((x) => x.key === key)!;
      expect(inLists.md5s[1], key).toBe(row.md5s[0]);
      expect(listed(read("supabase/verify/rls_select_wrap_131_precheck.sql")).find((x) => x.key === key)!.md5s[1], key).toBe(row.md5s[0]);
    }
    expect(listed(verify()).filter((x) => x.md5s.length !== 1)).toEqual([]);
  });

  it("exactly two md5s are accepted for each of the two policies: 131's and 159's; no third value, no other policy is special-cased, and no comment or other state is read", () => {
    const found = [...verify().matchAll(TWO_TEXT)].map((m) => [m[1], m[2]]);
    expect(found).toEqual([[M159, M159_DEL]]);
    expect(M159).toBe("18b6c82111707e214f8aaa30c5b6e717");
    expect(M159_DEL).toBe("a1f94f5b6390b515dc6714c2ca6f51b9");
    // In code (comments stripped) each 159 md5 appears once and so does each 131 md5 for these policies; nothing but the policy text decides.
    const body = code(verify());
    expect(body.split(M159)).toHaveLength(2);
    expect(body.split(M159_DEL)).toHaveLength(2);
    expect(body.split(M131())).toHaveLength(2);
    expect(body.split(M131_DEL())).toHaveLength(2);
    expect(body).not.toMatch(/release_159|pg_description|pg_policy\b|obj_description|installed/);
    expect(body.match(/job drawings org update/g)).toHaveLength(2); // the list row and the one accepted-159 comparison
    expect(body.match(/job drawings org delete/g)).toHaveLength(2);
    // The decision is the one place where md5_131 is compared; every other row stays on 131's text only.
    expect(body.match(/h\.m = /g)).toHaveLength(1);
    expect(body.match(/md5_131/g)).toHaveLength(2); // the column's name in the list, and the comparison
  });

  it("there is no comment trace anywhere: 159's release, rollback, verify, proposal, preflight and 131's verify neither write nor read pg_description for the policies", () => {
    for (const [name, text] of [["release", release159()], ["rollback", rollback159()], ["verify159", verify159()], ["proposal", proposal159()], ["verify131", verify()]] as const) {
      expect(code(text), name).not.toMatch(/COMMENT ON|pg_description|obj_description|description\b/i);
    }
    const marker = preflight().slice(preflight().indexOf("('post-144 marker 159 drawings_update_roles'"), preflight().indexOf("('post-144 marker 151 xero_invite_hardening'"));
    expect(marker).not.toMatch(/pg_description|pg_policy\b|description/);
    const row62 = preflight().slice(preflight().indexOf("UNION ALL SELECT 62,"), preflight().indexOf("UNION ALL SELECT 100 + row_number()"));
    expect(row62).not.toMatch(/pg_description|pg_policy\b|description/);
  });

  it("159's md5s are the md5s of the text PostgreSQL prints for the new policies, and are the same in 159's release, rollback, verify and preflight; the state needs BOTH policies at the same text", () => {
    for (const [name, text] of [["release", release159()], ["rollback", rollback159()], ["verify", verify159()], ["preflight", preflight()]] as const) {
      expect(text, name).toContain(M159);
      expect(text, name).toContain(M159_DEL);
      expect(text, name).toContain(M131());
      expect(text, name).toContain(M131_DEL());
    }
    expect(release159()).toContain(`v_u IS DISTINCT FROM '${M131()}' AND v_u IS DISTINCT FROM '${M159}'`);
    expect(release159()).toContain(`v_d IS DISTINCT FROM '${M131_DEL()}' AND v_d IS DISTINCT FROM '${M159_DEL}'`);
    expect(rollback159()).toContain(`v_u IS DISTINCT FROM '${M159}' AND v_u IS DISTINCT FROM '${M131()}'`);
    expect(rollback159()).toContain(`v_d IS DISTINCT FROM '${M159_DEL}' AND v_d IS DISTINCT FROM '${M131_DEL()}'`);
    // A MIX (one policy at each text) is refused by both guards.
    for (const text of [release159(), rollback159()]) expect(text).toContain(`IF (v_u = '${M131()}') IS DISTINCT FROM (v_d = '${M131_DEL()}') THEN`);
    expect(rollback159()).toContain(`= '${M131()}') THEN\n    RAISE EXCEPTION '159 rollback self-check`);
    expect(rollback159()).toContain(`= '${M131_DEL()}') THEN\n    RAISE EXCEPTION '159 rollback self-check`);
    expect(preflight()).toContain(`WHEN '${M131()}' THEN '131' WHEN '${M159}' THEN '159' ELSE 'other'`);
    expect(preflight()).toContain(`WHEN '${M131_DEL()}' THEN '131' WHEN '${M159_DEL}' THEN '159' ELSE 'other'`);
    // The preflight marker counts exactly two policies at 159's texts, so any mix or third text is not "applied".
    const marker = preflight().slice(preflight().indexOf("('post-144 marker 159 drawings_update_roles'"), preflight().indexOf("('post-144 marker 151 xero_invite_hardening'"));
    expect(marker).toContain("count(*) = 2");
    expect(marker).toContain(`('job drawings org update', 'UPDATE', '${M159}'), ('job drawings org delete', 'DELETE', '${M159_DEL}')`);
  });

  it("159 alters only those two policies: USING (false) WITH CHECK (false) and USING (false) going forward, 131's exact USING and WITH CHECK text coming back", () => {
    const forward = alters(release159());
    expect(forward).toEqual([{ key: KEY, using: "false", check: "false" }, { key: KEY_DEL, using: "false", check: undefined }]);
    expect(alters(proposal159())).toEqual(forward);
    const back = alters(rollback159());
    expect(back).toHaveLength(2);
    const in131 = alters(m131());
    for (const key of [KEY, KEY_DEL]) {
      const want = in131.find((a) => a.key === key)!;
      expect(want, key).toBeDefined();
      expect(back.find((a) => a.key === key), key).toEqual(want);
    }
    // Nothing else is created, dropped or granted, and the policies are altered, never dropped or recreated (the count of 182 stays).
    for (const text of [release159(), rollback159(), proposal159()]) {
      expect(code(text)).not.toMatch(/\b(DROP POLICY|CREATE POLICY|GRANT|REVOKE|DELETE FROM|INSERT INTO|SET ROLE|SET LOCAL ROLE|COMMENT ON)\b/);
      expect(code(text).match(/^ALTER POLICY /gm)).toHaveLength(2);
    }
  });

  it("the release and the rollback fingerprint every role membership before and after (the whole pg_auth_members row), and drop their session-only objects before COMMIT", () => {
    for (const [name, text] of [["release", release159()], ["rollback", rollback159()]] as const) {
      expect(code(text), name).toContain("FROM pg_catalog.pg_auth_members m");
      expect(code(text), name).toContain("to_jsonb(m)::TEXT");
      expect(code(text), name).toMatch(/DROP TABLE pg_temp\.p159_before;\nDROP FUNCTION pg_temp\.p159_fingerprint\(\);\nCOMMIT;\s*$/);
    }
  });
});
