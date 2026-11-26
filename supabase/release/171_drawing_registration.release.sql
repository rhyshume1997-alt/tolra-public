-- CR-002, release 171 after 170 in the release plan. Input: the verified migration 034 UTC cutoff.
-- Before first apply, run SET tolra.drawing_legacy_before = '<verified ISO 8601 UTC timestamp ending in Z>';
-- in this same SQL session. Release approval must establish the cutoff from deployment evidence.
-- Output: one restrictive Storage SELECT policy. Preserve existing grants, policies, data and revision history.
-- Verify with supabase/verify/drawing_registration_171.sql.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';

DO $post_release_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'job drawings org select'
      AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
      AND md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) = '0ecf1bddff5101df38f2fad021989797'
  ) OR (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::name[]
      AND ((policyname = 'job drawings org update' AND cmd = 'UPDATE' AND qual = 'false' AND with_check = 'false')
        OR (policyname = 'job drawings org delete' AND cmd = 'DELETE' AND qual = 'false' AND with_check IS NULL))
  ) <> 2 OR to_regprocedure('public.bump_drawing_revision(uuid,text,text,text)') IS NULL
    OR to_regclass('public.job_inspections') IS NULL THEN
    RAISE EXCEPTION '171: expected the 034 registration schema and the drawing policies from 131 and 159; run release preflight';
  END IF;
END
$post_release_guard$;

DO $drawing_registration$
DECLARE
  supplied_cutoff text := nullif(current_setting('tolra.drawing_legacy_before', true), '');
  cutoff timestamptz;
  installed_cutoff timestamptz;
BEGIN
  IF supplied_cutoff IS NOT NULL THEN
    IF supplied_cutoff !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN
      RAISE EXCEPTION '171: provide the verified migration 034 cutoff as an ISO 8601 UTC timestamp';
    END IF;
    cutoff := supplied_cutoff::timestamptz;
    IF cutoff >= transaction_timestamp() THEN
      RAISE EXCEPTION '171: the migration 034 cutoff must be in the past';
    END IF;
  END IF;

  SELECT substring(qual FROM 'created_at < ''([^'']+)''::timestamp with time zone')::timestamptz
    INTO installed_cutoff
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'job drawings require registration';
  IF FOUND THEN
    IF installed_cutoff IS NULL OR (cutoff IS NOT NULL AND cutoff <> installed_cutoff) THEN
      RAISE EXCEPTION '171: the installed policy has a different legacy cutoff';
    END IF;
    RETURN;
  END IF;
  IF cutoff IS NULL THEN
    RAISE EXCEPTION '171: set tolra.drawing_legacy_before to the verified migration 034 cutoff before applying';
  END IF;

  -- Legacy is limited to files directly in the job folder, using the Storage timestamp.
  -- Registered drawing paths include superseded revisions, whose files remain available.
  -- Certificates and inspection files keep opening through their own attachment records.
  EXECUTE format($policy$
    CREATE POLICY "job drawings require registration" ON storage.objects
      AS RESTRICTIVE FOR SELECT TO authenticated
      USING (
        bucket_id <> 'job-drawings'
        OR (cardinality(storage.foldername(name)) = 2 AND created_at < %L::timestamptz)
        OR EXISTS (
          SELECT 1 FROM public.job_files f
          WHERE f.organization_id = (SELECT public.current_user_organization_id())
            AND f.job_id::text = split_part(objects.name, '/', 2)
            AND f.storage_bucket = objects.bucket_id
            AND f.storage_path = objects.name
            AND (f.kind = 'drawing' OR (f.kind = 'cert' AND split_part(objects.name, '/', 3) = 'certs'))
        )
        OR EXISTS (
          SELECT 1 FROM public.job_inspections i
          WHERE i.organization_id = (SELECT public.current_user_organization_id())
            AND i.job_id::text = split_part(objects.name, '/', 2)
            AND i.attachment_path = objects.name
            AND split_part(objects.name, '/', 3) = 'inspection'
        )
      )
  $policy$, cutoff);
END
$drawing_registration$;

DO $drawing_policy_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'job drawings require registration'
      AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
      AND with_check IS NULL
      AND md5(regexp_replace(replace(qual, 'public.', ''),
            'created_at < ''[^'']+''::timestamp with time zone', 'created_at < CUTOFF')) = '50ac03900843b8e1587f77400a84d478'
  ) THEN
    RAISE EXCEPTION '171: the restrictive drawing policy differs from the approved definition';
  END IF;
END
$drawing_policy_check$;

COMMIT;
