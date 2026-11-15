-- =====================================================================================================
-- p159 (post-144 release 159, after 156 in supabase/release-plan.json): nobody can replace an object in the job-drawings bucket
-- from the browser. Audit finding ST1 (P0): a signed-in workshop, office or admin user could UPDATE (or upsert over) an object that
-- was uploaded to job-drawings but not yet registered to a job; objects already registered (job_files / job_inspections rows) were
-- protected by 034's RESTRICTIVE "attached job files are not overwritten" policy. The bucket holds drawings, certificates (certs/)
-- and inspection files (inspection/). PM ruling: refuse storage overwrites for all ordinary browser roles; keep new uploads,
-- registered revisions and authorised service operations.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/159_drawings_update_roles.release.sql, which adds the guard, a before/after fingerprint and the self-check.
-- Verify: supabase/verify/drawings_update_roles_159.sql (every row true). Rollback: supabase/release/159_drawings_update_roles.rollback.sql.
--
-- INPUTS: none (one policy altered, one comment written). OUTPUTS: the policy "job drawings org update" on storage.objects.
-- WHAT IT CHANGES (ALTER, not DROP; the policy stays PERMISSIVE, FOR UPDATE, TO authenticated, so the policy count is unchanged):
--   1. USING (false) WITH CHECK (false): no row of storage.objects can be updated by a browser role (authenticated). It was 006's text
--      as 131 left it (bucket job-drawings, own company folder, admin / office / workshop). pg_policies prints the new text as
--      "false" for both, so md5(qual || '|' || with_check) is 18b6c82111707e214f8aaa30c5b6e717 (131's was 76e489d7de7f079451629dc75177d894).
--   2. COMMENT ON POLICY: the durable trace that release 159 (and nothing else) put the policy in that state. It is the marker that
--      release preflight ("post-144 marker 159 drawings_update_roles") and supabase/verify/rls_select_wrap_131.sql key on. The rollback
--      removes it. Existing releases mark themselves by an object or a function body; a policy-only release has no new object, and
--      the policy text alone cannot be its own marker (that would make "159 installed" mean "the policy says false").
-- WHY NOTHING ELSE IS NEEDED: a plain upload is an INSERT (new, timestamped path) and needs no UPDATE privilege (the job-photos bucket
--   forbids UPDATE altogether and its uploads work, tests/db/job-photos.test.ts); registering a revision (bump_drawing_revision,
--   set_job_drawing_revision, job_files_revision_change) writes job_files and jobs rows only; the service role bypasses row-level
--   security, so authorised service operations are unaffected. No app path upserts, moves or copies in job-drawings.
-- MECHANISM: the same as 034 and 131, which alter policies on storage.objects with plain statements run as the role that applies
--   release files (no SET ROLE, no ownership change). A role that may not alter the policy fails with "must be owner of table objects"
--   and the whole transaction is rolled back.
-- MUST NOT CHANGE: the job-drawings insert, select and delete policies; 034's RESTRICTIVE "attached job files are not overwritten" and
--   "attached job files are not deleted" policies; any other bucket's policy; any grant, table, row or function. The release's
--   self-check proves every other policy is byte for byte as before and the policy count is unchanged.
BEGIN;

-- ---- 1. No browser role can update or replace an object in job-drawings ------------------------------------------------------
ALTER POLICY "job drawings org update" ON storage.objects
  USING (false)
  WITH CHECK (false);

-- ---- 2. The trace release 159 leaves (release preflight and 131's verify read it; the rollback removes it) -------------------
COMMENT ON POLICY "job drawings org update" ON storage.objects IS 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql';

COMMIT;
