/**
 * Marker 107 in release_preflight.sql must stay "applied" after release 151. Release 151 drops 107's token function
 * integration_invite_redeem and leaves integration_invite_store_connection; a marker that insisted on the dropped function read
 * "not applied" on a fully released database, so the readiness gate (check 1a) could never say GO. The behaviour against a
 * database is in tests/db/preflight-marker-107.test.ts; this file guards the text and the reason, with no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const preflight = read("supabase/verify/release_preflight.sql");
const release151 = read("supabase/release/151_xero_invite_hardening.release.sql");

function marker107(): string {
  const m = /\('107 integrations connect',([\s\S]*?)\),\s*\n\s*\('108 /.exec(preflight);
  if (!m) throw new Error("marker 107 not found in release_preflight.sql");
  return m[1];
}

describe("preflight marker 107 across release 151", () => {
  it("finds the marker row and it still needs both 107 tables", () => {
    const text = marker107();
    expect(text).toContain("public.integration_app_credentials");
    expect(text).toContain("public.integration_connect_invites");
  });
  it("accepts the 107 function (before 151) or the function 151 leaves (after 151)", () => {
    const text = marker107();
    expect(text).toMatch(/proname IN \('integration_invite_redeem', 'integration_invite_store_connection'\)/);
  });
  it("is still true that 151 drops the 107 redeem function and creates the function the marker now accepts", () => {
    expect(release151).toContain("DROP FUNCTION IF EXISTS public.integration_invite_redeem(TEXT, TEXT, TEXT)");
    expect(release151).toMatch(/CREATE (?:OR REPLACE )?FUNCTION public\.integration_invite_store_connection\(/);
  });
  it("does not accept a marker that names only the dropped function", () => {
    expect(marker107()).not.toMatch(/proname = 'integration_invite_redeem'\)/);
  });
});
