-- Rollback of release step 159 (nobody can replace an object in the job-drawings bucket from the browser). One transaction.
-- Puts policy "job drawings org update" on storage.objects back to the exact USING and WITH CHECK text release 131 left (copied byte for
-- byte from supabase/migrations/131_rls_select_wrap.sql; originally 006's text; md5 76e489d7de7f079451629dc75177d894). The policy keeps
-- its name, kind (PERMISSIVE), command (UPDATE) and role (authenticated). No row, grant, role membership or other policy is touched.
-- Running it twice equals running it once. After it the defect ST1 is open again (a signed-in workshop, office or admin user can replace
-- an object in job-drawings that no job has registered).
-- Order: roll 159 back BEFORE 131's rollback (131's guard refuses the drawings update policy while it has 159's text).
-- STATE is judged by the policy's exact text alone (no comment is read or written): INSTALLED (159's text, md5
-- 18b6c82111707e214f8aaa30c5b6e717) is restored to 131's text; ABSENT (already 131's text) is re-asserted unchanged (as before);
-- DRIFTED (the policy is missing, is not PERMISSIVE / UPDATE / exactly {authenticated}, or has any third text) REFUSES with a message and
-- changes nothing: stop and compare it first.
-- Inputs: the policies and role memberships of the database. Outputs: one policy changed. Must not change: any other policy or any role
-- membership (fingerprint checked below).
BEGIN;
SELECT pg_catalog.set_config('search_path', 'public, extensions', TRUE);
DO $rollback_guard$
DECLARE
  v_m TEXT;
BEGIN
 IF to_regclass('storage.objects') IS NULL THEN
  RAISE EXCEPTION '159 rollback: storage.objects is missing; stop and check release preflight';
 END IF;
 SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_m
 FROM pg_catalog.pg_policies p
 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}';
 IF v_m IS NULL THEN
  RAISE EXCEPTION '159 rollback: policy "job drawings org update" is missing or is not the PERMISSIVE UPDATE policy for authenticated; stop and compare it first';
 END IF;
 IF v_m IS DISTINCT FROM '18b6c82111707e214f8aaa30c5b6e717' AND v_m IS DISTINCT FROM '76e489d7de7f079451629dc75177d894' THEN
  RAISE EXCEPTION '159 rollback: policy "job drawings org update" is neither 159''s nor 131''s (text md5 %); stop and compare it first', v_m;
 END IF;
END $rollback_guard$;

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

-- 131's text, byte for byte (supabase/migrations/131_rls_select_wrap.sql, "job drawings org update").
ALTER POLICY "job drawings org update" ON storage.objects
  USING (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))))
  WITH CHECK (((bucket_id = 'job-drawings'::text) AND ((storage.foldername(name))[1] = ((SELECT current_user_organization_id()))::text) AND (SELECT has_org_role(ARRAY['admin'::text, 'office'::text, 'workshop'::text]))));

DO $rollback_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                 WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
                   AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
                   AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '76e489d7de7f079451629dc75177d894') THEN
    RAISE EXCEPTION '159 rollback self-check: "job drawings org update" must have 131''s text again (md5 76e489d7de7f079451629dc75177d894)';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p159_before EXCEPT SELECT * FROM pg_temp.p159_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p159_fingerprint() EXCEPT SELECT * FROM pg_temp.p159_before) THEN
    RAISE EXCEPTION '159 rollback self-check: another policy, the policy count, this policy''s kind, command or roles, storage.objects'' row security, owner or grants, or a role membership changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p159_before;
DROP FUNCTION pg_temp.p159_fingerprint();
COMMIT;
