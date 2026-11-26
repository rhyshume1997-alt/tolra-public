-- CR-002 rollback. Input: the installed release 171 policy. Output: restore the prior Storage read rules.
-- Preserve all objects and registrations. The old rules allow reads of unregistered uploads again.
BEGIN;
DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'job drawings require registration'
      AND (permissive = 'RESTRICTIVE' AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
      AND with_check IS NULL
      AND md5(regexp_replace(replace(qual, 'public.', ''),
            'created_at < ''[^'']+''::timestamp with time zone', 'created_at < CUTOFF')) = '50ac03900843b8e1587f77400a84d478') IS NOT TRUE
  ) THEN
    RAISE EXCEPTION '171 rollback: the restrictive drawing policy differs from the approved definition';
  END IF;
END
$rollback$;

DROP POLICY IF EXISTS "job drawings require registration" ON storage.objects;
COMMIT;
