-- =====================================================================================================
-- p159 (post-144 release 159, after 156 in supabase/release-plan.json): nobody can replace an object in the job-drawings bucket
-- from the browser. Audit finding ST1 (P0): a signed-in workshop, office or admin user could UPDATE (or upsert over) an object that
-- was uploaded to job-drawings but not yet registered to a job; objects already registered (job_files / job_inspections rows) were
-- protected by 034's RESTRICTIVE "attached job files are not overwritten" policy. The bucket holds drawings, certificates (certs/)
-- and inspection files (inspection/). PM ruling: refuse storage overwrites for all ordinary browser roles; keep new uploads,
-- registered revisions and authorised service operations.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/159_drawings_update_roles.release.sql, which adds the guard, a before/after fingerprint (including role memberships) and the self-check.
-- Verify: supabase/verify/drawings_update_roles_159.sql (every row true). Rollback: supabase/release/159_drawings_update_roles.rollback.sql.
--
-- INPUTS: none (one policy altered). OUTPUTS: the policy "job drawings org update" on storage.objects.
-- WHAT IT CHANGES (ALTER, not DROP; the policy stays PERMISSIVE, FOR UPDATE, TO authenticated, so the policy count is unchanged):
--   1. USING (false) WITH CHECK (false): no row of storage.objects can be updated by a browser role (authenticated). It was 006's text
--      as 131 left it (bucket job-drawings, own company folder, admin / office / workshop). pg_policies prints the new text as
--      "false" for both, so md5(qual || '|' || with_check) is 18b6c82111707e214f8aaa30c5b6e717 (131's was 76e489d7de7f079451629dc75177d894).
--   There is NO comment on the policy and no other trace: whether 159 is installed is decided by the policy's exact text alone
--   (md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) of the PERMISSIVE UPDATE policy for {authenticated}): 131's text
--   76e489d7de7f079451629dc75177d894 = absent, 159's 18b6c82111707e214f8aaa30c5b6e717 = installed, anything else (a third text, a missing
--   policy, another kind, command or role list) = drifted, which the release, the rollback and the preflight refuse or do not report as
--   applied. COMMENT ON POLICY is not used: it needs ownership of storage.objects (owned by supabase_storage_admin), which the login that
--   applies release files does not have (CI probe: ALTER POLICY succeeds for it, COMMENT ON POLICY fails with 42501).
-- WHY NOTHING ELSE IS NEEDED: a plain upload is an INSERT (new, timestamped path) and needs no UPDATE privilege (the job-photos bucket
--   forbids UPDATE altogether and its uploads work, tests/db/job-photos.test.ts); registering a revision (bump_drawing_revision,
--   set_job_drawing_revision, job_files_revision_change) writes job_files and jobs rows only; the service role bypasses row-level
--   security, so authorised service operations are unaffected. No app path upserts, moves or copies in job-drawings.
-- MECHANISM: the same as 034 and 131, which alter policies on storage.objects with plain statements run as the role that applies
--   release files (no SET ROLE, no ownership change). A role that may not alter the policy fails with "must be owner of table objects"
--   and the whole transaction is rolled back.
-- MUST NOT CHANGE: the job-drawings insert, select and delete policies; 034's RESTRICTIVE "attached job files are not overwritten" and
--   "attached job files are not deleted" policies; any other bucket's policy; any grant, role membership, table, row or function. The release's
--   self-check proves every other policy is byte for byte as before and the policy count is unchanged.
BEGIN;

-- ---- 1. No browser role can update or replace an object in job-drawings ------------------------------------------------------
ALTER POLICY "job drawings org update" ON storage.objects
  USING (false)
  WITH CHECK (false);

COMMIT;
