-- Read only: after release 159 (nobody can replace an object in the job-drawings bucket from the browser; registered in
-- supabase/release-plan.json as phase 159, after 156), every row must say true. Inputs: the policies of the database. Outputs: one
-- row per check (check_name, ok). Must not change: this file only reads. Proves: "job drawings org update" is still PERMISSIVE, FOR
-- UPDATE, TO authenticated, with USING false and WITH CHECK false (md5 18b6c82111707e214f8aaa30c5b6e717, 131's was
-- 76e489d7de7f079451629dc75177d894) and carries 159's comment (the trace release preflight and 131's verify key on); the other three
-- job-drawings policies are 131's and 034's two RESTRICTIVE attached-file policies are as 034 wrote them; release preflight's 159
-- marker condition holds. The behaviour (who can insert, select, delete and update) is proved in tests/db/drawings-update-roles-159.test.ts.
SELECT 'policy: "job drawings org update" is PERMISSIVE, UPDATE, authenticated, USING false and WITH CHECK false (159''s text)' AS check_name,
  EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
          WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
            AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
            AND p.qual = 'false' AND p.with_check = 'false'
            AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '18b6c82111707e214f8aaa30c5b6e717') AS ok
UNION ALL SELECT 'marker: the policy carries 159''s comment',
  EXISTS (SELECT 1 FROM pg_catalog.pg_policy po
          JOIN pg_catalog.pg_description d ON d.objoid = po.oid AND d.classoid = 'pg_catalog.pg_policy'::regclass AND d.objsubid = 0
          WHERE po.polrelid = to_regclass('storage.objects') AND po.polname = 'job drawings org update'
            AND d.description = 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql')
UNION ALL SELECT 'policies: job-drawings insert, select and delete are exactly 131''s (nothing else about them changed)',
  (SELECT count(*) = 3 FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.permissive = 'PERMISSIVE' AND p.roles::TEXT = '{authenticated}'
     AND ((p.policyname, p.cmd, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))) IN
          (('job drawings org insert', 'INSERT', '2c8b842a92e82cbe88c465be8de536b4'), ('job drawings org select', 'SELECT', '0ecf1bddff5101df38f2fad021989797'),
           ('job drawings org delete', 'DELETE', '2b7ec566b4506d9dc5918f7b02dd8374'))))
UNION ALL SELECT 'policies: 034''s RESTRICTIVE "attached job files are not overwritten" (UPDATE) and "not deleted" (DELETE) are as 034 wrote them',
  (SELECT count(*) = 2 FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.permissive = 'RESTRICTIVE' AND p.roles::TEXT = '{authenticated}'
     AND ((p.policyname, p.cmd, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))) IN
          (('attached job files are not overwritten', 'UPDATE', 'd8795f7628b3664cff08f8d0dae55511'), ('attached job files are not deleted', 'DELETE', 'd8795f7628b3664cff08f8d0dae55511'))))
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 159 drawings_update_roles" condition holds',
  EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
          JOIN pg_catalog.pg_policy po ON po.polrelid = to_regclass('storage.objects') AND po.polname = p.policyname
          JOIN pg_catalog.pg_description d ON d.objoid = po.oid AND d.classoid = 'pg_catalog.pg_policy'::regclass AND d.objsubid = 0
          WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'job drawings org update'
            AND p.permissive = 'PERMISSIVE' AND p.cmd = 'UPDATE' AND p.roles::TEXT = '{authenticated}'
            AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = '18b6c82111707e214f8aaa30c5b6e717'
            AND d.description = 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql');
