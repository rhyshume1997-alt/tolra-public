-- READ ONLY. Migration 040 (job photos): run in a read-only transaction AFTER applying 040 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 8 are facts about the schema and the data and must be "true". Rows 9 to 12 are
-- informational: how many photos are uploaded, how many reservations never finished, how many were removed, and the biggest one.
WITH
fn AS (SELECT p.proname, p.prosrc, p.prosecdef, p.oid, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
photos AS (SELECT * FROM public.job_files WHERE kind = 'photo')
SELECT * FROM (
  SELECT 1 AS n, 'job_files takes kind photo and has the photo columns' AS check_name,
      ((SELECT count(*) = 8 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_files'
          AND column_name IN ('note', 'captured_at', 'mime_type', 'byte_size', 'upload_state', 'uploaded_at', 'deleted_at', 'deleted_by'))
       AND (SELECT pg_get_constraintdef(oid) LIKE '%''photo''%' FROM pg_constraint WHERE conrelid = 'public.job_files'::regclass AND conname = 'job_files_kind_check')
       AND (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.job_files'::regclass AND conname = 'job_files_photo_shape'))::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'The four photo functions exist (one of each), are SECURITY DEFINER with a pinned search_path and are closed to anon',
      (SELECT count(*) = 4 AND bool_and(prosecdef) AND bool_and(array_to_string(proconfig, ',') LIKE 'search_path=pg_catalog, public%')
          AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname IN ('reserve_job_photo', 'finalise_job_photo', 'remove_job_photo', 'abandon_stale_job_photos'))::text, 'true'
  UNION ALL SELECT 3, 'Every photo writer checks the second step, the company and the role, and finalise checks the stored object',
      ((SELECT count(*) = 3 FROM fn WHERE proname IN ('reserve_job_photo', 'finalise_job_photo', 'remove_job_photo')
          AND prosrc LIKE '%assert_privileged_aal()%' AND prosrc LIKE '%current_user_organization_id()%' AND prosrc LIKE '%has_org_role%')
       AND (SELECT count(*) = 1 FROM fn WHERE proname = 'finalise_job_photo' AND prosrc LIKE '%storage.objects%' AND prosrc LIKE '%image/jpeg%' AND prosrc LIKE '%2097152%')
       AND (SELECT count(*) = 1 FROM fn WHERE proname = 'job_files_guard' AND prosrc LIKE '%quoteflow.photo_rpc%' AND prosrc LIKE '%remove_job_photo%'))::text, 'true'
  UNION ALL SELECT 4, 'Viewers are kept from photo rows (restrictive policy) and the photo guard trigger is on job_files',
      ((SELECT count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_files' AND policyname = 'job_files photos not for viewers' AND permissive = 'RESTRICTIVE')
       AND (SELECT count(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'job_files' AND t.tgname = 'job_files_guard' AND NOT t.tgisinternal))::text, 'true'
  UNION ALL SELECT 5, 'The private job-photos bucket refuses over 2 MiB and anything but image/jpeg at upload; one permissive rule (the reserved object) and four restrictive ones (no read, move/overwrite or delete) on it',
      ((SELECT count(*) = 1 FROM storage.buckets WHERE id = 'job-photos' AND NOT public AND file_size_limit = 2097152 AND allowed_mime_types = ARRAY['image/jpeg'])
       AND (SELECT count(*) = 4 AND bool_and(permissive = 'RESTRICTIVE') FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname IN ('job photos: only the reserved object is uploaded', 'job photos are not read from storage', 'job photos are not moved or overwritten', 'job photos are not deleted'))
       AND (SELECT count(*) = 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'job photos: the reserved object is uploaded'
              AND permissive = 'PERMISSIVE' AND cmd = 'INSERT' AND with_check LIKE '%job-photos%' AND with_check LIKE '%reserved%')
       AND (SELECT count(*) = 0 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'PERMISSIVE'
              AND cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL') AND (coalesce(qual, '') LIKE '%job-photos%' OR coalesce(with_check, '') LIKE '%job-photos%')))::text, 'true'
  UNION ALL SELECT 6, 'Every photo row sits at its own path in job-photos, as a JPEG of up to 2 MiB (the table constraints hold for the stored rows)',
      (SELECT count(*) = 0 FROM photos p WHERE p.storage_bucket <> 'job-photos' OR p.storage_path <> p.organization_id::text || '/' || p.job_id::text || '/photos/' || p.id::text || '.jpg'
         OR p.byte_size IS NULL OR p.byte_size < 1 OR p.byte_size > 2097152 OR p.upload_state NOT IN ('reserved', 'uploaded', 'abandoned'))::text, 'true'
  UNION ALL SELECT 7, 'Every uploaded photo has its stored object, of the reserved size, declared image/jpeg',
      (SELECT count(*) = 0 FROM photos p WHERE p.upload_state = 'uploaded' AND NOT EXISTS (
         SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'job-photos' AND o.name = p.storage_path
           AND o.metadata ->> 'mimetype' = 'image/jpeg' AND (o.metadata ->> 'size')::bigint = p.byte_size))::text, 'true'
  UNION ALL SELECT 8, 'Every recent photo records who added it, and every recent removal who removed it (an older one may have lost its login)',
      (SELECT count(*) = 0 FROM photos p WHERE (p.created_by IS NULL AND p.created_at > now() - interval '1 day')
         OR (p.deleted_at IS NOT NULL AND p.deleted_by IS NULL AND p.deleted_at > now() - interval '1 day'))::text, 'true'
  UNION ALL SELECT 9, 'Photos uploaded and not removed', (SELECT count(*) FROM photos WHERE upload_state = 'uploaded' AND deleted_at IS NULL)::text, 'informational (0 until the first photo)'
  UNION ALL SELECT 10, 'Reservations older than a day that never finished uploading, not yet marked abandoned', (SELECT count(*) FROM photos WHERE upload_state = 'reserved' AND deleted_at IS NULL AND created_at < now() - interval '1 day')::text, 'informational (run select public.abandon_stale_job_photos(24) as maintenance; rows and bytes are kept)'
  UNION ALL SELECT 11, 'Photos removed (bytes kept)', (SELECT count(*) FROM photos WHERE deleted_at IS NOT NULL)::text, 'informational'
  UNION ALL SELECT 12, 'Largest uploaded photo, bytes', coalesce((SELECT max(byte_size) FROM photos WHERE upload_state = 'uploaded'), 0)::text, 'informational (2097152 at most)'
) AS t
ORDER BY n;
