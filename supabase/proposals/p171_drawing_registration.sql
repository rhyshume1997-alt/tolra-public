-- CR-002, release 171. Input: the verified UTC time migration 034 took effect on this database.
-- Before the first apply, set tolra.drawing_legacy_before to that ISO 8601 timestamp with a Z suffix
-- in the same SQL session. For a database with no pre-034 objects, use its verified pre-upload cutover.
-- The policy stores the cutoff as a literal. Later sessions cannot change it through a setting.
-- Output: one restrictive Storage SELECT policy. Uploads, write privileges and revision history are preserved.
-- Use the guarded release file for application; this is its canonical proposal.
BEGIN;

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

COMMIT;
