-- Post-144 release step 159 (nobody can replace an object in the job-drawings bucket from the browser; registered in
-- supabase/release-plan.json as phase 159, after 156; CI's post-144 step installs it). One transaction; never part of baseline replay.
-- Not applied anywhere hosted. Canonical source: supabase/proposals/p159_drawings_update_roles.sql (its body between BEGIN; and COMMIT;
-- is copied below verbatim between the fingerprint and the self-check; read its header for what changes, why and the PM ruling).
-- Verify: supabase/verify/drawings_update_roles_159.sql (every row true), and supabase/verify/rls_select_wrap_131.sql (every row true:
-- its "job drawings org update" row is state aware and recognises exactly this release, by the comment this file writes).
-- Rollback: supabase/release/159_drawings_update_roles.rollback.sql (puts 131's exact text back and removes the comment). Production only
-- with Rhys's separate yes. Running this file again once applied changes nothing.
-- REFUSES, changing nothing, unless the policy "job drawings org update" on storage.objects is PERMISSIVE, FOR UPDATE, TO authenticated
-- and has exactly release 131's text (md5 76e489d7de7f079451629dc75177d894) or already 159's (md5 18b6c82111707e214f8aaa30c5b6e717),
-- and carries no comment other than 159's (131's text with 159's comment is a half-installed state: run 159's rollback first).
-- MECHANISM: plain ALTER POLICY / COMMENT ON POLICY on storage.objects as the role that applies release files, exactly as 034 and 131
-- do (no SET ROLE, no ownership change). If that role may not alter the policy the statement fails and nothing is kept.
-- Inputs: the policies of the database. Outputs: one policy changed and commented. Must not change: any other policy (the self-check
-- compares a fingerprint of every other policy, the policy count, the table's row security flag, owner and grants before and after).
BEGIN;
DO $post_release_guard$
DECLARE
  v_m TEXT;
  v_c TEXT;
BEGIN
 IF to_regclass('storage.objects') IS NULL THEN
  RAISE EXCEPTION '159: storage.objects is missing; stop and check release preflight';
 END IF;
 SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_m
 FROM pg_catalog.pg_policies p
 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}';
 IF v_m IS NULL THEN
  RAISE EXCEPTION '159: policy "job drawings org update" on storage.objects is missing or is not the PERMISSIVE UPDATE policy for authenticated; stop and compare it first';
 END IF;
 IF v_m IS DISTINCT FROM '76e489d7de7f079451629dc75177d894' AND v_m IS DISTINCT FROM '18b6c82111707e214f8aaa30c5b6e717' THEN
  RAISE EXCEPTION '159: policy "job drawings org update" is neither 131''s nor 159''s (text md5 %); stop and compare it first', v_m;
 END IF;
 SELECT d.description INTO v_c
 FROM pg_catalog.pg_policy po
 JOIN pg_catalog.pg_description d ON d.objoid = po.oid AND d.classoid = 'pg_catalog.pg_policy'::regclass AND d.objsubid = 0
 WHERE po.polrelid = to_regclass('storage.objects') AND po.polname = 'job drawings org update';
 IF v_c IS NOT NULL AND v_c IS DISTINCT FROM 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql' THEN
  RAISE EXCEPTION '159: policy "job drawings org update" carries a comment that is not 159''s; stop and compare it first';
 END IF;
 IF v_m = '76e489d7de7f079451629dc75177d894' AND v_c IS NOT NULL THEN
  RAISE EXCEPTION '159: policy "job drawings org update" has 131''s text but 159''s comment (half installed); run 159''s rollback first, then apply 159 again';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 159 must not touch: every other policy in the database, the policy count, this policy's
-- command / roles / kind, and storage.objects' row security flags, owner and grants. The self-check requires the identical
-- fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p159_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p159fp$
  SELECT 'every other policy'::TEXT, md5(coalesce(string_agg(md5(concat_ws('|', p.schemaname, p.tablename, p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, ''))), '' ORDER BY p.schemaname, p.tablename, p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE NOT (p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update')
  UNION ALL SELECT 'policy count', count(*)::TEXT FROM pg_catalog.pg_policies
  UNION ALL SELECT 'this policy: kind, command, roles', coalesce(string_agg(p.permissive || '|' || p.cmd || '|' || p.roles::TEXT, ';'), 'missing')
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
  UNION ALL SELECT 'storage.objects: row security, owner, grants', c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, '')
  FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('storage.objects')
$p159fp$;
CREATE TEMP TABLE p159_before ON COMMIT DROP AS SELECT * FROM pg_temp.p159_fingerprint();

-- ---- 1. No browser role can update or replace an object in job-drawings ------------------------------------------------------
ALTER POLICY "job drawings org update" ON storage.objects
  USING (false)
  WITH CHECK (false);

-- ---- 2. The trace release 159 leaves (release preflight and 131's verify read it; the rollback removes it) -------------------
COMMENT ON POLICY "job drawings org update" ON storage.objects IS 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql';

DO $p159_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
                   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
                   AND p.qual = 'false' AND p.with_check = 'false'
                   AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '18b6c82111707e214f8aaa30c5b6e717') THEN
    RAISE EXCEPTION '159 self-check: "job drawings org update" must be the PERMISSIVE UPDATE policy for authenticated with USING false and WITH CHECK false';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy po
                 JOIN pg_catalog.pg_description d ON d.objoid = po.oid AND d.classoid = 'pg_catalog.pg_policy'::regclass AND d.objsubid = 0
                 WHERE po.polrelid = to_regclass('storage.objects') AND po.polname = 'job drawings org update'
                   AND d.description = 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql') THEN
    RAISE EXCEPTION '159 self-check: the policy must carry 159''s comment';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p159_before EXCEPT SELECT * FROM pg_temp.p159_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p159_fingerprint() EXCEPT SELECT * FROM pg_temp.p159_before) THEN
    RAISE EXCEPTION '159 self-check: another policy, the policy count, this policy''s command or roles, or storage.objects'' row security, owner or grants changed';
  END IF;
END
$p159_self_check$;
DROP TABLE pg_temp.p159_before;
DROP FUNCTION pg_temp.p159_fingerprint();
COMMIT;
