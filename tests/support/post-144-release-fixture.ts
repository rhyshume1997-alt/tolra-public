/**
 * Test-only. All baseline files run first; only these release proofs prepare the reviewed phases.
 * Inputs: a query function on the disposable database. Output: nothing, or the ORIGINAL failure rethrown unchanged.
 * Failure diagnostics are a single read-only SELECT (catalog reads only), run best-effort and only after a failure; a diagnostic
 * or unlock error never replaces the original failure. Must not change: no write, no SET ROLE, no privilege change, no policy change.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const phases = [
  { number: 145, marker: "post-144 marker 145 company_setup", file: "supabase/release/145_company_setup.release.sql", verifyFile: "supabase/verify/company_setup_145.sql" },
  { number: 146, marker: "post-144 marker 146 tolra_provided_ai", file: "supabase/release/146_tolra_provided_ai.release.sql", verifyFile: "supabase/verify/tolra_provided_ai_146.sql" },
  { number: 147, marker: "post-144 marker 147 job_delivery_note", file: "supabase/release/147_job_delivery_note.release.sql", verifyFile: "supabase/verify/job_delivery_note_147.sql" },
  { number: 148, marker: "post-144 marker 148 job_profitability_actuals", file: "supabase/release/148_job_profitability_actuals.release.sql", verifyFile: "supabase/verify/job_profitability_actuals_148.sql" },
  { number: 149, marker: "post-144 marker 149 xero_launch_hold", file: "supabase/release/149_xero_launch_hold.release.sql", verifyFile: "supabase/verify/xero_launch_hold_149.sql" },
  { number: 150, marker: "post-144 marker 150 ai_cap_key_off", file: "supabase/release/150_ai_cap_key_off.release.sql", verifyFile: "supabase/verify/ai_cap_key_off_150.sql" },
  { number: 151, marker: "post-144 marker 151 xero_invite_hardening", file: "supabase/release/151_xero_invite_hardening.release.sql", verifyFile: "supabase/verify/xero_invite_hardening_151.sql" },
  { number: 152, marker: "post-144 marker 152 sliq_import_route", file: "supabase/release/152_sliq_import_route.release.sql", verifyFile: "supabase/verify/sliq_import_route_152.sql" },
  { number: 153, marker: "post-144 marker 153 document_customer_link", file: "supabase/release/153_document_customer_link.release.sql", verifyFile: "supabase/verify/document_customer_link_153.sql" },
  { number: 154, marker: "post-144 marker 154 customer_portal_signin", file: "supabase/release/154_customer_portal_signin.release.sql", verifyFile: "supabase/verify/customer_portal_signin_154.sql" },
  { number: 156, marker: "post-144 marker 156 invoice_ref_case", file: "supabase/release/156_invoice_ref_case.release.sql", verifyFile: "supabase/verify/invoice_ref_case_156.sql" },
  { number: 157, marker: "post-144 marker 157 jobs_integrity_guard", file: "supabase/release/157_jobs_integrity_guard.release.sql", verifyFile: "supabase/verify/jobs_integrity_guard_157.sql" },
  { number: 158, marker: "post-144 marker 158 machine_run_integrity", file: "supabase/release/158_machine_run_integrity.release.sql", verifyFile: "supabase/verify/machine_run_integrity_158.sql" },
  { number: 159, marker: "post-144 marker 159 drawings_update_roles", file: "supabase/release/159_drawings_update_roles.release.sql", verifyFile: "supabase/verify/drawings_update_roles_159.sql" },
  { number: 160, marker: "post-144 marker 160 legacy_reopen_revoke", file: "supabase/release/160_legacy_reopen_revoke.release.sql", verifyFile: "supabase/verify/legacy_reopen_revoke_160.sql" },
  { number: 163, marker: "post-144 marker 163 chase_steps_atomic", file: "supabase/release/163_chase_steps_atomic.release.sql", verifyFile: "supabase/verify/chase_steps_atomic_163.sql" },
  { number: 164, marker: "post-144 marker 164 platform_companies", file: "supabase/release/164_platform_companies.release.sql", verifyFile: "supabase/verify/platform_companies_164.sql" },
  { number: 165, marker: "post-144 marker 165 owner_issues", file: "supabase/release/165_owner_issues.release.sql", verifyFile: "supabase/verify/owner_issues_165.sql" },
  { number: 167, marker: "post-144 marker 167 roadmap_rollouts", file: "supabase/release/167_roadmap_rollouts.release.sql", verifyFile: "supabase/verify/roadmap_rollouts_167.sql" },
  { number: 170, marker: "post-144 marker 170 worksheet_custom", file: "supabase/release/170_worksheet_custom.release.sql", verifyFile: "supabase/verify/worksheet_custom_170.sql" },
];
/** Read-only (SELECT only): who owns storage.objects, who we are, our role membership and our privileges on it (release 159 policy question). */
export const storageObjectsDiagnosticSql = `SELECT 'storage.objects owner' AS check, (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('storage.objects')) AS value
UNION ALL SELECT 'storage.objects acl', (SELECT c.relacl::text FROM pg_class c WHERE c.oid = to_regclass('storage.objects'))
UNION ALL SELECT 'storage.objects row security on', (SELECT c.relrowsecurity::text FROM pg_class c WHERE c.oid = to_regclass('storage.objects'))
UNION ALL SELECT 'current_user', current_user::text
UNION ALL SELECT 'session_user', session_user::text
UNION ALL SELECT 'current role is superuser / bypassrls', (SELECT rolsuper::text || ' / ' || rolbypassrls::text FROM pg_roles WHERE rolname = current_user)
UNION ALL SELECT 'current role is member of', (SELECT string_agg(pg_get_userbyid(m.roleid), ', ' ORDER BY pg_get_userbyid(m.roleid)) FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user))
UNION ALL SELECT 'current role is member of storage.objects owner (inherits / usable)', (SELECT pg_has_role(current_user, c.relowner, 'MEMBER')::text || ' / ' || pg_has_role(current_user, c.relowner, 'USAGE')::text FROM pg_class c WHERE c.oid = to_regclass('storage.objects'))
UNION ALL SELECT 'current role privileges on storage.objects (select/insert/update/delete/trigger)', (SELECT concat_ws(' / ', has_table_privilege(current_user, c.oid, 'SELECT'), has_table_privilege(current_user, c.oid, 'INSERT'), has_table_privilege(current_user, c.oid, 'UPDATE'), has_table_privilege(current_user, c.oid, 'DELETE'), has_table_privilege(current_user, c.oid, 'TRIGGER')) FROM pg_class c WHERE c.oid = to_regclass('storage.objects'))
UNION ALL SELECT 'storage.objects policies', (SELECT string_agg(policyname, ', ' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')`;
/** Best effort and never throws: prints the read-only diagnostics so the original failure stays the visible one. */
export async function reportStorageDiagnostics(query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>) {
  try {
    const rows = (await query(storageObjectsDiagnosticSql)).rows;
    for (const row of rows) console.error(`[release fixture diagnostic] ${String(row.check)}: ${String(row.value)}`);
  } catch (diagnosticError) {
    console.error(`[release fixture diagnostic] unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`);
  }
}
export async function preparePost144Fixture(deps: {
  through?: 145 | 146 | 147 | 148 | 149 | 150 | 151 | 152 | 153 | 154 | 156 | 157 | 158 | 159 | 160 | 163 | 164 | 165 | 167 | 170;
  verify: () => Promise<unknown>;
  query: (sql: string) => Promise<{ rows: Array<{ check?: string; value?: string; ok?: boolean; passed?: boolean }> }>;
}) {
  if (deps.through !== undefined && !phases.some(p => p.number === deps.through)) throw new Error("Invalid release fixture target");
  await deps.verify();
  await deps.query("SELECT pg_advisory_lock(144145146)");
  let failure: { original: unknown } | undefined;
  try {
    for (const phase of phases.filter(p => p.number <= (deps.through ?? 170))) {
      const state = (await deps.query(read("supabase/verify/release_preflight.sql"))).rows.find(row => row.check === phase.marker);
      if (!state) throw new Error(`Missing release preflight marker: ${phase.marker}`);
      if (state.value !== "applied") {
        // The one-time file refuses existing/mismatched objects. Never replace them to make a test pass.
        await deps.query(read(phase.file));
        const after = (await deps.query(read("supabase/verify/release_preflight.sql"))).rows.find(row => row.check === phase.marker);
        if (after?.value !== "applied") throw new Error(`Release fixture did not verify: ${phase.marker}`);
      }
      // Verify every row even when already installed. Missing/false checks are failures.
      const checks = (await deps.query(read(phase.verifyFile))).rows;
      if (!checks.length || checks.some(row => (row.ok ?? row.passed) !== true)) throw new Error(`Release verification failed: ${phase.marker}`);
    }
    await deps.query("NOTIFY pgrst, 'reload schema'");
  } catch (original) {
    // The ORIGINAL failure is what the caller sees; rollback, diagnostics and the unlock below can never replace it.
    // A release file opens its own BEGIN, so a failed release leaves this connection in a failed transaction (25P02):
    // ROLLBACK first (ends that transaction, changes nothing), then the read-only diagnostic, then the unlock.
    try { await deps.query("ROLLBACK"); }
    catch (rollbackError) { console.error(`[release fixture] rollback failed (original failure kept): ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    await reportStorageDiagnostics(deps.query);
    failure = { original };
    throw original;
  } finally {
    try { await deps.query("SELECT pg_advisory_unlock(144145146)"); }
    catch (unlockError) {
      if (!failure) throw unlockError;
      console.error(`[release fixture] unlock also failed (original failure kept): ${unlockError instanceof Error ? unlockError.message : String(unlockError)}`);
    }
  }
}
export async function preparePost144Backend() {
  const { verifyBackendIdentity, withDb, adminClient } = await import("./fixtures");
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await adminClient().from("company_setup_progress").select("organization_id").limit(0);
    if (!result.error) return;
    if (!["PGRST205", "42P01"].includes(result.error.code)) throw result.error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Post-144 schema cache did not reload");
}
