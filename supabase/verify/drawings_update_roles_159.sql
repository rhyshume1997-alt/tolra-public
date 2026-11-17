-- Read only: after release 159 (nobody can replace or delete an object in the job-drawings bucket from the browser; registered in
-- supabase/release-plan.json as phase 159, after 156), every row must say true. Inputs: the policies of the database. Outputs: one
-- row per check (check_name, ok). Must not change: this file only reads. Proves: "job drawings org update" is still PERMISSIVE, FOR
-- UPDATE, TO authenticated, with USING false and WITH CHECK false (md5 18b6c82111707e214f8aaa30c5b6e717, 131's was
-- 76e489d7de7f079451629dc75177d894) and "job drawings org delete" is PERMISSIVE, FOR DELETE, TO authenticated, with USING false and no WITH
-- CHECK (md5 a1f94f5b6390b515dc6714c2ca6f51b9, 131's was 2b7ec566b4506d9dc5918f7b02dd8374); those exact texts are the only record of
-- "installed" (no comment is read: COMMENT ON POLICY needs ownership of storage.objects), so one policy at 159's text and the other at 131's
-- is NOT installed; the job-drawings insert and select policies are 131's and 034's two RESTRICTIVE attached-file policies are as 034 wrote
-- them; release preflight's 159 marker condition holds. The behaviour (who can insert, select, delete and update) is proved in tests/db/drawings-update-roles-159.test.ts.
SELECT 'policy: "job drawings org update" is PERMISSIVE, UPDATE, authenticated, USING false and WITH CHECK false (159''s text)' AS check_name,
  EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
          WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
            AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
            AND p.qual = 'false' AND p.with_check = 'false'
            AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '18b6c82111707e214f8aaa30c5b6e717') AS ok
UNION ALL SELECT 'policy: "job drawings org delete" is PERMISSIVE, DELETE, authenticated, USING false and no WITH CHECK (159''s text)',
  EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
          WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org delete'
            AND p.permissive = 'PERMISSIVE' AND p.cmd = 'DELETE' AND p.roles::TEXT = '{authenticated}'
            AND p.qual = 'false' AND p.with_check IS NULL
            AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = 'a1f94f5b6390b515dc6714c2ca6f51b9')
UNION ALL SELECT 'policies: job-drawings insert and select are exactly 131''s (nothing else about them changed)',
  (SELECT count(*) = 2 FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.permissive = 'PERMISSIVE' AND p.roles::TEXT = '{authenticated}'
     AND ((p.policyname, p.cmd, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))) IN
          (('job drawings org insert', 'INSERT', '2c8b842a92e82cbe88c465be8de536b4'), ('job drawings org select', 'SELECT', '0ecf1bddff5101df38f2fad021989797'))))
UNION ALL SELECT 'policies: 034''s RESTRICTIVE "attached job files are not overwritten" (UPDATE) and "not deleted" (DELETE) are as 034 wrote them',
  (SELECT count(*) = 2 FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.permissive = 'RESTRICTIVE' AND p.roles::TEXT = '{authenticated}'
     AND ((p.policyname, p.cmd, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))) IN
          (('attached job files are not overwritten', 'UPDATE', 'd8795f7628b3664cff08f8d0dae55511'), ('attached job files are not deleted', 'DELETE', 'd8795f7628b3664cff08f8d0dae55511'))))
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 159 drawings_update_roles" condition holds (159''s exact text on both policies)',
  (SELECT count(*) = 2 FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.permissive = 'PERMISSIVE' AND p.roles::TEXT = '{authenticated}'
     AND ((p.policyname, p.cmd, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))) IN
          (('job drawings org update', 'UPDATE', '18b6c82111707e214f8aaa30c5b6e717'), ('job drawings org delete', 'DELETE', 'a1f94f5b6390b515dc6714c2ca6f51b9'))));
