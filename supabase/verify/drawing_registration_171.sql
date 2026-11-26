-- CR-002 verification. Input: the Storage policy catalogue. Output: installed policy check and UTC cutoff.
-- Read only. The cutoff must agree with the migration 034 deployment evidence for this database.
WITH installed AS (
  SELECT substring(qual FROM 'created_at < ''([^'']+)''::timestamp with time zone')::timestamptz AS cutoff,
         permissive = 'RESTRICTIVE' AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
      AND with_check IS NULL
      AND md5(regexp_replace(replace(qual, 'public.', ''),
            'created_at < ''[^'']+''::timestamp with time zone', 'created_at < CUTOFF')) = '50ac03900843b8e1587f77400a84d478' AS matches
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'job drawings require registration'
)
SELECT '171 drawing read policy matches the release; confirm cutoff against the deployment record' AS check_name,
       coalesce((SELECT matches AND isfinite(cutoff) AND cutoff < statement_timestamp() FROM installed), false) AS ok,
       (SELECT cutoff AT TIME ZONE 'UTC' FROM installed) AS legacy_before_utc;
