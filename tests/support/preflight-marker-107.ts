/**
 * Test-only helper for preflight marker 107 (integrations connect). Release 151 drops 107's token functions (create(text,text),
 * redeem(text,text,text)) and creates new ones, so the marker has two clean states and no others:
 *   - 107 in place and none of the functions only 151 has       -> applied
 *   - 107's token functions gone, all eleven 151 functions there, and marker 151 applied -> applied
 *   - both families, a part of 151, neither, or an unrelated function -> not applied
 * The marker and the final column that adds the 151 requirement are cut out of release_preflight.sql and evaluated with a stand-in for
 * to_regprocedure (a temp function in the caller's session, so nothing shared is created, dropped or changed).
 */
export const OLD_FAMILY = ["public.integration_invite_create(text,text)", "public.integration_invite_redeem(text,text,text)"];
export const ONLY_151 = [
  "public.integration_invite_create(text,text,text)", "public.integration_invite_code_issue(text,text)", "public.integration_invite_code_verify(text,text,text,text)",
  "public.integration_invite_refusal_log(text,text,text,uuid)", "security_audit.integration_invite_refuse(text,text,text,uuid,uuid)",
  "public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer)", "public.integration_xero_picker_claim(text,text,integer,integer)",
];
export const SHARED = [
  "public.integration_invite_peek(text)", "public.integration_invites_open(text)", "public.integration_invite_revoke(uuid)", "public.integration_oauth_consume_invite(text,text)",
];

export function extract(preflight: string): { rowExpr: string; finalCase: string } {
  const row = /\('107 integrations connect',([\s\S]*?)\),\s*\n\s*\('108 /.exec(preflight);
  const fin = /'marker ' \|\| migration,\s*(CASE WHEN present AND[\s\S]*?ELSE 'not applied' END),/.exec(preflight);
  if (!row) throw new Error("marker 107 row not found in release_preflight.sql");
  if (!fin) throw new Error("the marker output column with the 107 / 151 rule was not found in release_preflight.sql");
  return { rowExpr: row[1], finalCase: fin[1] };
}

export const FAKE_FUNCTION =
  "CREATE OR REPLACE FUNCTION pg_temp.fake_regproc(sig text) RETURNS text LANGUAGE sql STABLE AS " +
  "$$ SELECT CASE WHEN sig = ANY(string_to_array(coalesce(current_setting('test.present', true), ''), ';')) THEN sig END $$";

/** One query: the marker's value ('applied' / 'not applied') for the given set of existing functions and marker 151 state. */
export function buildQuery(preflight: string, marker151: boolean): string {
  const { rowExpr, finalCase } = extract(preflight);
  const fake = (text: string) => text.replaceAll("to_regprocedure(", "pg_temp.fake_regproc(");
  return (
    `WITH post_release_markers(label, present) AS (VALUES ('post-144 marker 151 xero_invite_hardening', ${marker151})) ` +
    `SELECT ${fake(finalCase)} AS value FROM (SELECT '107 integrations connect'::text AS migration, (${fake(rowExpr)}) AS present) AS m`
  );
}

type Scenario = { name: string; present: string[]; marker151: boolean; expected: "applied" | "not applied" };
export const SCENARIOS: Scenario[] = [
  { name: "original 107 in place, 151 absent", present: [...OLD_FAMILY, ...SHARED], marker151: false, expected: "applied" },
  { name: "complete 151 (107's token functions gone) with marker 151 applied", present: [...ONLY_151, ...SHARED], marker151: true, expected: "applied" },
  { name: "all 151 functions present but marker 151 not applied (a changed body)", present: [...ONLY_151, ...SHARED], marker151: false, expected: "not applied" },
  { name: "both families complete, marker 151 applied", present: [...OLD_FAMILY, ...ONLY_151, ...SHARED], marker151: true, expected: "not applied" },
  { name: "both families complete, marker 151 not applied", present: [...OLD_FAMILY, ...ONLY_151, ...SHARED], marker151: false, expected: "not applied" },
  { name: "107 in place plus one function only 151 has", present: [...OLD_FAMILY, ...SHARED, ONLY_151[0]], marker151: false, expected: "not applied" },
  { name: "107 token functions gone, only some 151 functions (3 of 7 new)", present: [...ONLY_151.slice(0, 3), ...SHARED], marker151: false, expected: "not applied" },
  { name: "107 token functions gone, six of the seven new 151 functions", present: [...ONLY_151.slice(0, 6), ...SHARED], marker151: true, expected: "not applied" },
  { name: "107 token functions gone, all seven new but a shared one missing", present: [...ONLY_151, ...SHARED.slice(1)], marker151: true, expected: "not applied" },
  { name: "107 half in place (redeem gone), no 151", present: [OLD_FAMILY[0], ...SHARED], marker151: false, expected: "not applied" },
  { name: "107 half in place (create gone, redeem present), no 151", present: [OLD_FAMILY[1], ...SHARED], marker151: false, expected: "not applied" },
  { name: "neither family", present: [], marker151: true, expected: "not applied" },
  { name: "only the functions both releases have", present: [...SHARED], marker151: true, expected: "not applied" },
  { name: "an unrelated function only", present: ["public.integration_invite_unrelated(text)"], marker151: true, expected: "not applied" },
];
