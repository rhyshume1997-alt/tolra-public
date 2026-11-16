-- Post-144 release step 159 (nobody can replace or delete an object in the job-drawings bucket from the browser; registered in
-- supabase/release-plan.json as phase 159, after 156; CI's post-144 step installs it). One transaction; never part of baseline replay.
-- Not applied anywhere hosted. Canonical source: supabase/proposals/p159_drawings_update_roles.sql (its body between BEGIN; and COMMIT;
-- is copied below verbatim between the fingerprint and the self-check; read its header for what changes, why and the PM ruling).
-- Verify: supabase/verify/drawings_update_roles_159.sql (every row true), and supabase/verify/rls_select_wrap_131.sql (every row true:
-- its "job drawings org update" and "job drawings org delete" rows each accept exactly 131's text or 159's text and nothing else).
-- Rollback: supabase/release/159_drawings_update_roles.rollback.sql (puts 131's exact text back on both). Production only with Rhys's
-- separate yes.
-- STATE covers TWO policies on storage.objects and is judged by their exact text alone (there is no comment: COMMENT ON POLICY needs
-- ownership of storage.objects, which the login that applies release files does not have). "job drawings org update" must be the
-- PERMISSIVE UPDATE policy and "job drawings org delete" the PERMISSIVE DELETE policy, each for exactly {authenticated}, and
-- md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) of each decides. ABSENT = both at 131's text (update
-- 76e489d7de7f079451629dc75177d894, delete 2b7ec566b4506d9dc5918f7b02dd8374): the release applies. INSTALLED = both at 159's text (update
-- 18b6c82111707e214f8aaa30c5b6e717, delete a1f94f5b6390b515dc6714c2ca6f51b9): running this file again changes nothing. DRIFTED = anything
-- else: a third text on either, a missing policy, another kind, command or role list, or ONE policy at 131's text and the other at
-- 159's (a half-installed state): the file REFUSES with a message and changes nothing.
-- MECHANISM: plain ALTER POLICY on storage.objects as the role that applies release files, exactly as 034 and 131 do (no SET ROLE, no
-- ownership change). If that role may not alter a policy the statement fails and nothing is kept.
-- Inputs: the policies and role memberships of the database. Outputs: two policies changed. Must not change: any other policy, any role
-- membership (the self-check compares a fingerprint of every other policy, the policy count, these two policies' names / kinds /
-- commands / roles, the table's row security flags, owner and grants, and every pg_auth_members row, before and after).
BEGIN;
DO $post_release_guard$
DECLARE
  v_u TEXT;
  v_d TEXT;
BEGIN
 IF to_regclass('storage.objects') IS NULL THEN
  RAISE EXCEPTION '159: storage.objects is missing; stop and check release preflight';
 END IF;
 SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_u
 FROM pg_catalog.pg_policies p
 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}';
 SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_d
 FROM pg_catalog.pg_policies p
 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org delete'
   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'DELETE' AND p.roles::TEXT = '{authenticated}';
 IF v_u IS NULL THEN
  RAISE EXCEPTION '159: policy "job drawings org update" on storage.objects is missing or is not the PERMISSIVE UPDATE policy for authenticated; stop and compare it first';
 END IF;
 IF v_d IS NULL THEN
  RAISE EXCEPTION '159: policy "job drawings org delete" on storage.objects is missing or is not the PERMISSIVE DELETE policy for authenticated; stop and compare it first';
 END IF;
 IF v_u IS DISTINCT FROM '76e489d7de7f079451629dc75177d894' AND v_u IS DISTINCT FROM '18b6c82111707e214f8aaa30c5b6e717' THEN
  RAISE EXCEPTION '159: policy "job drawings org update" is neither 131''s nor 159''s (text md5 %); stop and compare it first', v_u;
 END IF;
 IF v_d IS DISTINCT FROM '2b7ec566b4506d9dc5918f7b02dd8374' AND v_d IS DISTINCT FROM 'a1f94f5b6390b515dc6714c2ca6f51b9' THEN
  RAISE EXCEPTION '159: policy "job drawings org delete" is neither 131''s nor 159''s (text md5 %); stop and compare it first', v_d;
 END IF;
 IF (v_u = '76e489d7de7f079451629dc75177d894') IS DISTINCT FROM (v_d = '2b7ec566b4506d9dc5918f7b02dd8374') THEN
  RAISE EXCEPTION '159: the update and delete policies of job-drawings are in different states (update md5 %, delete md5 %): one has 131''s text and the other 159''s, a half-installed state; stop and compare them first, nothing was changed', v_u, v_d;
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 159 must not touch: every other policy in the database, the policy count, these two policies'
-- names / commands / roles / kinds, storage.objects' row security flags, owner and grants, and every role membership (pg_auth_members: each
-- whole row as JSON, so the columns it has on the server's version are all covered: roleid, member, grantor, admin_option and, from
-- PostgreSQL 16, inherit_option and set_option, without naming a column that an older server lacks). The self-check requires the
-- identical fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p159_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p159fp$
  SELECT 'every other policy'::TEXT, md5(coalesce(string_agg(md5(concat_ws('|', p.schemaname, p.tablename, p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, ''))), '' ORDER BY p.schemaname, p.tablename, p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE NOT (p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname IN ('job drawings org update', 'job drawings org delete'))
  UNION ALL SELECT 'policy count', count(*)::TEXT FROM pg_catalog.pg_policies
  UNION ALL SELECT 'these two policies: name, kind, command, roles', coalesce(string_agg(p.policyname || '|' || p.permissive || '|' || p.cmd || '|' || p.roles::TEXT, ';' ORDER BY p.policyname), 'missing')
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname IN ('job drawings org update', 'job drawings org delete')
  UNION ALL SELECT 'storage.objects: row security, owner, grants', c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, '')
  FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('storage.objects')
  UNION ALL SELECT 'role memberships (pg_auth_members)', md5(coalesce(string_agg(to_jsonb(m)::TEXT, ';' ORDER BY m.roleid, m.member, m.grantor), ''))
  FROM pg_catalog.pg_auth_members m
$p159fp$;
CREATE TEMP TABLE p159_before ON COMMIT DROP AS SELECT * FROM pg_temp.p159_fingerprint();

-- ---- 1. No browser role can update or replace an object in job-drawings ------------------------------------------------------
ALTER POLICY "job drawings org update" ON storage.objects
  USING (false)
  WITH CHECK (false);

-- ---- 2. No browser role can delete an object in job-drawings (a delete then re-upload at the same path would be an overwrite) -----
ALTER POLICY "job drawings org delete" ON storage.objects
  USING (false);

DO $p159_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
                   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
                   AND p.qual = 'false' AND p.with_check = 'false'
                   AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '18b6c82111707e214f8aaa30c5b6e717') THEN
    RAISE EXCEPTION '159 self-check: "job drawings org update" must be the PERMISSIVE UPDATE policy for authenticated with USING false and WITH CHECK false';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org delete'
                   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'DELETE' AND p.roles::TEXT = '{authenticated}'
                   AND p.qual = 'false' AND p.with_check IS NULL
                   AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = 'a1f94f5b6390b515dc6714c2ca6f51b9') THEN
    RAISE EXCEPTION '159 self-check: "job drawings org delete" must be the PERMISSIVE DELETE policy for authenticated with USING false';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p159_before EXCEPT SELECT * FROM pg_temp.p159_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p159_fingerprint() EXCEPT SELECT * FROM pg_temp.p159_before) THEN
    RAISE EXCEPTION '159 self-check: another policy, the policy count, these two policies'' name, kind, command or roles, storage.objects'' row security, owner or grants, or a role membership changed';
  END IF;
END
$p159_self_check$;
DROP TABLE pg_temp.p159_before;
DROP FUNCTION pg_temp.p159_fingerprint();
COMMIT;
