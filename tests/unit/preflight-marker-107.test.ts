/**
 * Marker 107 in release_preflight.sql must stay "applied" after release 151, and only in its two clean states. Release 151 drops 107's
 * token functions (create(text,text), redeem(text,text,text)) and creates new ones; a marker that insisted on the dropped function read
 * "not applied" on a fully released database, so the readiness gate (check 1a) could never say GO. The behaviour against a database is
 * in tests/db/preflight-marker-107.test.ts; this file guards the text, the lists and the reason, with no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ONLY_151, OLD_FAMILY, SCENARIOS, SHARED, buildQuery, extract } from "../support/preflight-marker-107";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const preflight = read("supabase/verify/release_preflight.sql");
const release151 = read("supabase/release/151_xero_invite_hardening.release.sql");
const names = (sigs: string[]) => sigs.map((sig) => sig.replace(/^[a-z_]+\./, "").replace(/\(.*$/, ""));

describe("preflight marker 107 across release 151", () => {
  it("finds the marker row and the output column, and the row still needs both 107 tables", () => {
    const { rowExpr, finalCase } = extract(preflight);
    expect(rowExpr).toContain("public.integration_app_credentials");
    expect(rowExpr).toContain("public.integration_connect_invites");
    expect(finalCase).toContain("post-144 marker 151 xero_invite_hardening");
  });
  it("checks every function by signature: the old pair, the seven only 151 has, and the four both have", () => {
    const { rowExpr } = extract(preflight);
    for (const sig of [...OLD_FAMILY, ...ONLY_151, ...SHARED]) expect(rowExpr).toContain(sig);
    expect(rowExpr).toMatch(/c\.n_new = 0/);
    expect(rowExpr).toMatch(/c\.n_new = 7 AND c\.n_all = 11/);
  });
  it("is still true that 151 drops the old pair and creates the seven new functions (and replaces the four shared)", () => {
    expect(release151).toContain("DROP FUNCTION IF EXISTS public.integration_invite_create(TEXT, TEXT)");
    expect(release151).toContain("DROP FUNCTION IF EXISTS public.integration_invite_redeem(TEXT, TEXT, TEXT)");
    for (const name of names(ONLY_151)) expect(release151).toMatch(new RegExp(`FUNCTION (?:public|security_audit)\\.${name}\\(`));
    for (const name of names(SHARED)) expect(release151).toMatch(new RegExp(`FUNCTION public\\.${name}\\(`));
  });
  it("does not accept a marker that names only the dropped function, or either family alone with an OR", () => {
    const { rowExpr } = extract(preflight);
    expect(rowExpr).not.toMatch(/proname = 'integration_invite_redeem'\)/);
    expect(rowExpr).not.toMatch(/proname IN \(/);
  });
  it("builds a query for every scenario (the database test runs them)", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(12);
    for (const s of SCENARIOS) expect(buildQuery(preflight, s.marker151)).toContain("pg_temp.fake_regproc(");
    expect(SCENARIOS.filter((s) => s.expected === "applied")).toHaveLength(2);
  });
});
