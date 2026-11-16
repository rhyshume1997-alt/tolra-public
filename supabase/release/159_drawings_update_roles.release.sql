-- Post-144 release step 159 (nobody can replace an object in the job-drawings bucket from the browser; registered in
-- supabase/release-plan.json as phase 159, after 156; CI's post-144 step installs it). One transaction; never part of baseline replay.
-- Not applied anywhere hosted. Canonical source: supabase/proposals/p159_drawings_update_roles.sql (its body between BEGIN; and COMMIT;
-- is copied below verbatim between the fingerprint and the self-check; read its header for what changes, why and the PM ruling).
-- Verify: supabase/verify/drawings_update_roles_159.sql (every row true), and supabase/verify/rls_select_wrap_131.sql (every row true:
-- its "job drawings org update" row accepts exactly 131's text or 159's text and nothing else).
-- Rollback: supabase/release/159_drawings_update_roles.rollback.sql (puts 131's exact text back). Production only with Rhys's separate yes.
-- STATE is judged by the policy's exact text alone (there is no comment: COMMENT ON POLICY needs ownership of storage.objects, which the
-- login that applies release files does not have). The policy must be the PERMISSIVE UPDATE policy for exactly {authenticated}, and
-- md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) decides: 76e489d7de7f079451629dc75177d894 = ABSENT (131's text), the release
-- applies; 18b6c82111707e214f8aaa30c5b6e717 = INSTALLED (159's text), running this file again changes nothing; anything else (a third
-- text, a missing policy, another kind, command or role list) = DRIFTED: the file REFUSES with a message and changes nothing.
-- MECHANISM: plain ALTER POLICY on storage.objects as the role that applies release files, exactly as 034 and 131 do (no SET ROLE, no
-- ownership change). If that role may not alter the policy the statement fails and nothing is kept.
-- Inputs: the policies and role memberships of the database. Outputs: one policy changed. Must not change: any other policy, any role
-- membership (the self-check compares a fingerprint of every other policy, the policy count, this policy's kind / command / roles, the
-- table's row security flags, owner and grants, and every pg_auth_members row, before and after).
BEGIN;
DO $post_release_guard$
DECLARE
  v_m TEXT;
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
END $post_release_guard$;

-- Before: a fingerprint of everything 159 must not touch: every other policy in the database, the policy count, this policy's
-- command / roles / kind, storage.objects' row security flags, owner and grants, and every role membership (pg_auth_members: each
-- whole row as JSON, so the columns it has on the server's version are all covered: roleid, member, grantor, admin_option and, from
-- PostgreSQL 16, inherit_option and set_option, without naming a column that an older server lacks). The self-check requires the
-- identical fingerprint. Session-only helper, dropped before COMMIT.
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
  UNION ALL SELECT 'role memberships (pg_auth_members)', md5(coalesce(string_agg(to_jsonb(m)::TEXT, ';' ORDER BY m.roleid, m.member, m.grantor), ''))
  FROM pg_catalog.pg_auth_members m
$p159fp$;
CREATE TEMP TABLE p159_before ON COMMIT DROP AS SELECT * FROM pg_temp.p159_fingerprint();

-- ---- 1. No browser role can update or replace an object in job-drawings ------------------------------------------------------
ALTER POLICY "job drawings org update" ON storage.objects
  USING (false)
  WITH CHECK (false);

DO $p159_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
                   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
                   AND p.qual = 'false' AND p.with_check = 'false'
                   AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '18b6c82111707e214f8aaa30c5b6e717') THEN
    RAISE EXCEPTION '159 self-check: "job drawings org update" must be the PERMISSIVE UPDATE policy for authenticated with USING false and WITH CHECK false';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p159_before EXCEPT SELECT * FROM pg_temp.p159_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p159_fingerprint() EXCEPT SELECT * FROM pg_temp.p159_before) THEN
    RAISE EXCEPTION '159 self-check: another policy, the policy count, this policy''s kind, command or roles, storage.objects'' row security, owner or grants, or a role membership changed';
  END IF;
END
$p159_self_check$;
DROP TABLE pg_temp.p159_before;
DROP FUNCTION pg_temp.p159_fingerprint();
COMMIT;
