-- =====================================================================================================
-- p160 (post-144 release 160, after 159 in supabase/release-plan.json): the older reopen function can no longer be called from the
-- browser. Defect J1 (P0): a signed-in user (confirmed for office) could reopen a Complete job by calling public.reopen_job directly,
-- skipping the reopen request and sign-off workflow of migration 113. PM ruling: "Revoke browser EXECUTE, preserve approved request
-- and sign off workflow." service_role's grant is left unchanged.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/160_legacy_reopen_revoke.release.sql, which adds the guard, a before/after fingerprint and the self-check.
-- Verify: supabase/verify/legacy_reopen_revoke_160.sql (every row true).
-- Rollback: supabase/release/160_legacy_reopen_revoke.rollback.sql.
--
-- INPUTS: none (one privilege statement). OUTPUTS: public.reopen_job(uuid, text) is no longer executable by PUBLIC, anon or authenticated.
-- WHY THE WORKFLOW KEEPS WORKING: reopen_job is called only by 113's SECURITY DEFINER functions (reopen_preview, reopen_record,
--   decide_reopen_request) and, through reopen_record and decide_reopen_request, by the internal _reopen_job_signed_off. A definer
--   function checks EXECUTE against its owner, which keeps it. Their own grants (authenticated) are not touched.
-- MUST NOT CHANGE: the reopen_job BODY (113_reopen_requests.sql, supabase/verify/release_preflight.sql row 47 and
--   supabase/verify/reopen_requests_113.sql pin its whitespace-free md5 2fca7e7164a55f9f9e0744f8a0c6b50e); any other grant, function,
--   policy or trigger; service_role's grant; every rule inside reopen_job (who may reopen what, despatched, invoiced, rework).
-- ONE STATEMENT, NOTHING ELSE. Run again, it changes nothing.
-- =====================================================================================================
BEGIN;

REVOKE EXECUTE ON FUNCTION public.reopen_job(uuid, text) FROM PUBLIC, anon, authenticated;

COMMIT;
