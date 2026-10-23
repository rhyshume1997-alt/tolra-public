-- =====================================================================================================
-- 040: job photos (PR F). Photos taken on the shop floor and attached to a job's worksheet.
--
-- 1. job_files gains kind 'photo' (034 had drawings and certs only) with note, captured_at, mime_type, byte_size, upload_state,
--    uploaded_at and the deletion marker deleted_at / deleted_by. A photo is a JPEG of at most 2 MiB made on the device
--    (lib/photo-image.ts re-encodes it: orientation fixed, longest edge 2048 px, every piece of metadata dropped) and sits at
--    <company>/<job>/photos/<photo id>.jpg in its own private bucket, job-photos.
-- 2. Reserve, then finalise (SECURITY DEFINER, search_path pinned, company and role checks, read-only support refused by the
--    statement trigger every company table carries). The photo id is made by the device, so a retry of either step after a lost
--    connection is the same photo, never a second one:
--      reserve_job_photo(id, job, note, captured_at, byte_size)  the row, state 'reserved' (returns the existing row on a retry);
--                                                                at most 60 new reservations per person per hour (hint
--                                                                photo_rate_limited), counted with 011's auth_rate_hit;
--      <the device uploads exactly that object>
--      finalise_job_photo(id)                                    checks the stored object (a JPEG of the reserved size, 2 MiB at
--                                                                most), state 'uploaded', ADD_PHOTO in the history (a retry
--                                                                returns the uploaded row). A stored object that isn't the
--                                                                reserved one marks the row 'abandoned' (answer
--                                                                state 'abandoned', error photo_mismatch): it is never
--                                                                finalised, never retried under that id; the device sends the
--                                                                photo again under a new id.
--    The server records who and when (created_by = the session, created_at = now()): client values are ignored. captured_at is
--    the device's own "taken at" time, kept as information only.
--    Abandoned reservations: abandon_stale_job_photos(hours >= 24) marks reservations older than that with NO stored object
--    'abandoned' (admin: own company; service role / maintenance: every company). reserve_job_photo does the same for the
--    caller's own stale rows. A device that comes back later with the photo re-reserves the same id (no object, so it is the
--    same photo). Nothing is deleted: rows and any bytes stay (attached files are never overwritten or deleted).
-- 3. Removal is a marker, never a delete (remove_job_photo: admin and office, REMOVE_PHOTO in the history, the bytes are kept).
--    A reserve or finalise on a removed id is refused, so a delayed retry from a device that was offline can't bring a removed
--    photo back. Photo rows can't be inserted, changed or deleted through the table by the browser roles at all (job_files_guard,
--    replaced here with 034's rules kept for drawings and certs): only the four functions write them.
-- 4. Storage: the private bucket job-photos (created or corrected here) refuses at upload any object over 2 MiB
--    (file_size_limit 2097152) or not declared image/jpeg (allowed_mime_types). For the browser roles the only operation in it
--    is the upload of exactly the object a reservation names, by the person who reserved it; nothing can be read, listed,
--    signed, moved, copied, overwritten or deleted through Storage. finalise_job_photo still checks the stored object (declared
--    type and size), and the app server checks the JPEG signature before it serves bytes (/api/job-photos/<id>: the person's
--    own row read decides, RLS: same company, not a viewer, uploaded, not removed; then the server fetches the object).
-- 5. Who may do what: admin, office and workshop add and see photos; admin and office remove them; viewers see none (a RESTRICTIVE
--    policy on job_files, no Storage read, the server route refuses them).
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. job_files: kind 'photo' and its columns ------------------------------------------------------------
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_kind_check;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_kind_check CHECK (kind IN ('drawing', 'cert', 'photo'));
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS note         TEXT;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS captured_at  TIMESTAMPTZ;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS mime_type    TEXT;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS byte_size    INTEGER;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS upload_state TEXT;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS uploaded_at  TIMESTAMPTZ;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;
ALTER TABLE public.job_files ADD COLUMN IF NOT EXISTS deleted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 034 allowed the two drawing/cert buckets only; photos live in their own bucket.
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_storage_bucket_check;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_storage_bucket_check CHECK (storage_bucket IN ('job-drawings', 'quote-attachments', 'job-photos'));
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_note_length;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_note_length CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500);
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_photo_mime;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_photo_mime CHECK (mime_type IS NULL OR mime_type = 'image/jpeg');
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_photo_size;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_photo_size CHECK (byte_size IS NULL OR (byte_size > 0 AND byte_size <= 2097152));
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_upload_state;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_upload_state CHECK (upload_state IS NULL OR upload_state IN ('reserved', 'uploaded', 'abandoned'));
-- Only photos have an upload state, a size, a deletion marker; a photo has no revision, sits at its
-- own path in the job-photos bucket, and once uploaded carries its time and type.
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_photo_shape;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_photo_shape CHECK (
  ((kind = 'photo') = (upload_state IS NOT NULL))
  AND (kind = 'photo' OR (byte_size IS NULL AND mime_type IS NULL AND captured_at IS NULL AND uploaded_at IS NULL AND deleted_at IS NULL AND deleted_by IS NULL AND note IS NULL))
  AND (kind <> 'photo' OR (revision IS NULL AND byte_size IS NOT NULL AND storage_bucket = 'job-photos'
                           AND storage_path = organization_id::TEXT || '/' || job_id::TEXT || '/photos/' || id::TEXT || '.jpg'))
  AND (upload_state IS DISTINCT FROM 'uploaded' OR (uploaded_at IS NOT NULL AND mime_type IS NOT NULL)));
CREATE INDEX IF NOT EXISTS idx_job_files_photos ON public.job_files (job_id, created_at) WHERE kind = 'photo' AND deleted_at IS NULL;

-- Viewers see drawings and certs (034) but no photo at all. RESTRICTIVE: it only takes access away.
DROP POLICY IF EXISTS "job_files photos not for viewers" ON public.job_files;
CREATE POLICY "job_files photos not for viewers" ON public.job_files AS RESTRICTIVE FOR SELECT TO authenticated
  USING (kind <> 'photo' OR public.has_org_role(ARRAY['admin', 'office', 'workshop']));

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. The guard: 034's rules for drawings and certs, and photos written only by their functions ----------------
-- Replaces 034's job_files_guard. For the browser roles a photo row is inserted or changed only inside reserve_job_photo,
-- finalise_job_photo, remove_job_photo and abandon_stale_job_photos (they set quoteflow.photo_rpc for the statement), its kind never changes, and it is
-- never deleted (removal is the marker). Everything 034 said about drawings and certs is unchanged.
CREATE OR REPLACE FUNCTION public.job_files_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row  public.job_files%ROWTYPE;
  v_sent BOOLEAN := FALSE;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  -- 040: photos.
  IF v_row.kind = 'photo' OR (TG_OP = 'UPDATE' AND OLD.kind = 'photo') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'A photo is removed by marking it (remove_job_photo), never deleted.' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'A photo stays a photo.' USING ERRCODE = '42501';
    END IF;
    IF current_setting('quoteflow.photo_rpc', TRUE) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Photos are added with reserve_job_photo / finalise_job_photo and removed with remove_job_photo.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('INSERT', 'DELETE') AND v_row.kind = 'cert' THEN
    SELECT EXISTS (SELECT 1 FROM public.jobs j
                   JOIN public.delivery_notes d ON d.organization_id = j.organization_id AND d.status IN ('despatched', 'delivered', 'signed')
                                               AND (d.job_id = j.id OR (d.job_id IS NULL AND d.job_ref = j.job_no))
                   WHERE j.id = v_row.job_id) INTO v_sent;
    IF v_sent THEN
      RAISE EXCEPTION 'A delivery note for this job has gone out with its certificates, so the cert pack can''t be changed.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_at IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'A file is replaced by uploading the next revision, not by marking it.' USING ERRCODE = '42501';
    END IF;
    IF NEW.revision IS NOT NULL AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only an admin approves a drawing revision.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['revision', 'superseded_at', 'superseded_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision', 'superseded_at', 'superseded_by']) THEN
      RAISE EXCEPTION 'An attached file can''t be changed: a new revision is a new file.' USING ERRCODE = '42501';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision THEN
      IF OLD.revision IS NOT NULL OR NEW.revision IS NULL THEN
        RAISE EXCEPTION 'A revision can''t be changed once it is set: upload the next revision as a new file.' USING ERRCODE = '42501';
      END IF;
      IF NOT public.has_org_role(ARRAY['admin']) THEN
        RAISE EXCEPTION 'Only an admin approves a drawing revision.' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by)
       AND (OLD.superseded_at IS NOT NULL OR current_setting('quoteflow.drawing_bump', TRUE) IS DISTINCT FROM OLD.id::TEXT) THEN
      RAISE EXCEPTION 'A file is replaced by uploading the next revision, not by marking it.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.kind = 'drawing' THEN
    RAISE EXCEPTION 'An attached drawing can''t be removed; upload the next revision instead.' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION public.job_files_guard() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Reserve, finalise, remove, abandon -------------------------------------------------------------------
-- The device makes the photo id (a UUID), so a retry is the same photo. Every function takes a per-id advisory lock, so two
-- replays of the same photo (two tabs) are serialised and the second sees what the first did.
CREATE INDEX IF NOT EXISTS idx_job_files_photo_reserved ON public.job_files (created_by, created_at) WHERE kind = 'photo' AND upload_state = 'reserved';

-- Reserves the row for a photo of the job: state 'reserved', who and when from the session. A retry with the same id returns
-- the row as it is (reserved or uploaded); an id marked abandoned for staleness (no object stored) is reserved again. Refused: a
-- removed photo, an id whose stored object didn't match (hint photo_abandoned: send it under a new id), an id reserved by
-- someone else or for another job, a job of another company (not found), a 61st new reservation within an hour (hint
-- photo_rate_limited). Admin, office and workshop. Returns { photo_id, state, storage_path, byte_size }.
CREATE OR REPLACE FUNCTION public.reserve_job_photo(p_id UUID, p_job UUID, p_note TEXT, p_captured_at TIMESTAMPTZ, p_byte_size INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_user  UUID := auth.uid();
  v_note  TEXT := left(nullif(btrim(p_note), ''), 500);
  v_taken TIMESTAMPTZ := p_captured_at;
  v_row   public.job_files%ROWTYPE;
  v_path  TEXT;
  v_stale INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_job IS NULL THEN
    RAISE EXCEPTION 'A photo id and a job are required.' USING ERRCODE = '22023';
  END IF;
  IF p_byte_size IS NULL OR p_byte_size < 1 OR p_byte_size > 2097152 THEN
    RAISE EXCEPTION 'A photo is a JPEG of up to 2 MB.' USING ERRCODE = '22023';
  END IF;
  -- The device's own "taken at" time is information only; a time in the future is nonsense and is dropped.
  IF v_taken IS NOT NULL AND v_taken > now() + interval '1 hour' THEN
    v_taken := NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('job_photo:' || p_id::TEXT));
  SELECT * INTO v_row FROM public.job_files WHERE id = p_id FOR UPDATE;
  IF FOUND THEN
    IF v_row.organization_id <> v_org OR v_row.kind <> 'photo' THEN
      RAISE EXCEPTION 'Photo not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.job_id <> p_job OR v_row.created_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'That photo id is already in use.' USING ERRCODE = '22023';
    END IF;
    IF v_row.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'This photo was removed, so it can''t be uploaded.' USING ERRCODE = '42501', HINT = 'photo_removed';
    END IF;
    IF v_row.upload_state = 'abandoned' THEN
      IF EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'job-photos' AND o.name = v_row.storage_path) THEN
        RAISE EXCEPTION 'The file stored for this photo didn''t match it, so it can''t be finished under this id. Send it again as a new photo.' USING ERRCODE = '22023', HINT = 'photo_abandoned';
      END IF;
      -- Marked abandoned only for its age, with nothing stored: the device still has the photo, so the same id goes on.
      PERFORM set_config('quoteflow.photo_rpc', 'on', TRUE);
      UPDATE public.job_files SET upload_state = 'reserved' WHERE id = p_id;
      PERFORM set_config('quoteflow.photo_rpc', '', TRUE);
      v_row.upload_state := 'reserved';
    END IF;
    RETURN jsonb_build_object('photo_id', v_row.id, 'state', v_row.upload_state, 'storage_path', v_row.storage_path, 'byte_size', v_row.byte_size);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- At most 60 new reservations per person per hour (a refused one isn't counted: the raise rolls the count back).
  IF NOT public.auth_rate_hit('job_photo_reserve', encode(sha256(convert_to(v_user::TEXT, 'UTF8')), 'hex'), 3600, 60) THEN
    RAISE EXCEPTION 'Too many photos started in the last hour. Wait a while, then try again.' USING ERRCODE = 'P0001', HINT = 'photo_rate_limited';
  END IF;
  v_path := v_org::TEXT || '/' || p_job::TEXT || '/photos/' || p_id::TEXT || '.jpg';
  PERFORM set_config('quoteflow.photo_rpc', 'on', TRUE);
  -- Housekeeping on the caller's own reservations: older than a day with nothing stored are marked abandoned (rows kept; one
-- ABANDON_STALE_PHOTOS row in the history with the count).
  UPDATE public.job_files f SET upload_state = 'abandoned'
  WHERE f.id IN (SELECT s.id FROM public.job_files s
                 WHERE s.kind = 'photo' AND s.upload_state = 'reserved' AND s.created_by = v_user AND s.deleted_at IS NULL
                   AND s.created_at < now() - interval '24 hours'
                   AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'job-photos' AND o.name = s.storage_path)
                 LIMIT 50);
  GET DIAGNOSTICS v_stale = ROW_COUNT;
  IF v_stale > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'ABANDON_STALE_PHOTOS', 'job_files', v_org::TEXT,
      jsonb_build_object('count', v_stale, 'older_than_hours', 24, 'scope', 'own reservations'));
  END IF;
  INSERT INTO public.job_files (id, organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, note, captured_at, byte_size, upload_state, created_by, created_at)
  VALUES (p_id, v_org, p_job, 'photo', 'photo', p_id::TEXT || '.jpg', 'job-photos', v_path, v_note, v_taken, p_byte_size, 'reserved', v_user, now());
  PERFORM set_config('quoteflow.photo_rpc', '', TRUE);
  RETURN jsonb_build_object('photo_id', p_id, 'state', 'reserved', 'storage_path', v_path, 'byte_size', p_byte_size);
END
$$;
REVOKE ALL ON FUNCTION public.reserve_job_photo(UUID, UUID, TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_job_photo(UUID, UUID, TEXT, TIMESTAMPTZ, INTEGER) TO authenticated;

-- Finishes the upload: the stored object must be exactly the reserved one (a JPEG of the reserved size, 2 MiB at most); the row
-- becomes 'uploaded' and ADD_PHOTO is written in the same transaction. A retry on an uploaded photo returns it. Refused: a
-- removed photo (it stays removed), an abandoned one (hint photo_abandoned), someone else's reservation, a photo of another
-- company (not found). Not uploaded yet: refused with hint photo_not_uploaded (the device uploads and tries again). The wrong
-- object stored (another size or type): the row is marked 'abandoned', PHOTO_MISMATCH (reserved size, stored size and type) is
-- written in the history, and the answer is { photo_id, state: 'abandoned',
-- error: 'photo_mismatch', message } (not raised, so the marker is kept). Otherwise { photo_id, state, created_by, created_at,
-- uploaded_at }.
CREATE OR REPLACE FUNCTION public.finalise_job_photo(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_row    public.job_files%ROWTYPE;
  v_mime   TEXT;
  v_size   BIGINT;
  v_job_no TEXT;
  v_now    TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('job_photo:' || p_id::TEXT));
  SELECT * INTO v_row FROM public.job_files WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.organization_id <> v_org OR v_row.kind <> 'photo' THEN
    RAISE EXCEPTION 'Photo not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.created_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'Only the person who took this photo finishes uploading it.' USING ERRCODE = '42501';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This photo was removed, so it can''t be uploaded.' USING ERRCODE = '42501', HINT = 'photo_removed';
  END IF;
  IF v_row.upload_state = 'uploaded' THEN
    RETURN jsonb_build_object('photo_id', v_row.id, 'state', 'uploaded', 'created_by', v_row.created_by, 'created_at', v_row.created_at, 'uploaded_at', v_row.uploaded_at);
  END IF;
  IF v_row.upload_state = 'abandoned' THEN
    RAISE EXCEPTION 'This photo''s upload was abandoned, so it can''t be finished under this id. Send it again as a new photo.' USING ERRCODE = '22023', HINT = 'photo_abandoned';
  END IF;
  SELECT o.metadata ->> 'mimetype', (o.metadata ->> 'size')::BIGINT INTO v_mime, v_size
  FROM storage.objects o WHERE o.bucket_id = 'job-photos' AND o.name = v_row.storage_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The photo hasn''t been uploaded yet.' USING ERRCODE = '22023', HINT = 'photo_not_uploaded';
  END IF;
  IF v_mime IS DISTINCT FROM 'image/jpeg' OR v_size IS NULL OR v_size <> v_row.byte_size OR v_size > 2097152 THEN
    -- Never attached, never retried under this id: the marker is kept (an answer, not an error, so it isn't rolled back).
    PERFORM set_config('quoteflow.photo_rpc', 'on', TRUE);
    UPDATE public.job_files SET upload_state = 'abandoned' WHERE id = p_id;
    PERFORM set_config('quoteflow.photo_rpc', '', TRUE);
    SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_row.job_id;
    PERFORM security_audit.log_named_event(v_org, 'PHOTO_MISMATCH', 'jobs', v_row.job_id::TEXT,
      jsonb_build_object('photo_id', p_id, 'job_no', v_job_no, 'reserved_byte_size', v_row.byte_size, 'stored_size', v_size, 'stored_mime', v_mime));
    RETURN jsonb_build_object('photo_id', p_id, 'state', 'abandoned', 'error', 'photo_mismatch',
      'message', format('The uploaded file isn''t the photo that was reserved (a JPEG of %s bytes), so it wasn''t attached.', v_row.byte_size));
  END IF;
  PERFORM set_config('quoteflow.photo_rpc', 'on', TRUE);
  UPDATE public.job_files SET upload_state = 'uploaded', uploaded_at = v_now, mime_type = 'image/jpeg' WHERE id = p_id;
  PERFORM set_config('quoteflow.photo_rpc', '', TRUE);
  SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_row.job_id;
  PERFORM security_audit.log_named_event(v_org, 'ADD_PHOTO', 'jobs', v_row.job_id::TEXT,
    jsonb_build_object('photo_id', p_id, 'job_no', v_job_no, 'note', v_row.note, 'byte_size', v_row.byte_size));
  RETURN jsonb_build_object('photo_id', p_id, 'state', 'uploaded', 'created_by', v_row.created_by, 'created_at', v_row.created_at, 'uploaded_at', v_now);
END
$$;
REVOKE ALL ON FUNCTION public.finalise_job_photo(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalise_job_photo(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Marks a photo removed (deleted_at / deleted_by from the session; the bytes are kept; REMOVE_PHOTO in the history). Admin and
-- office. A photo already removed is left as it is. Returns { photo_id, state: 'removed', deleted_at }.
CREATE OR REPLACE FUNCTION public.remove_job_photo(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_row    public.job_files%ROWTYPE;
  v_job_no TEXT;
  v_now    TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin and office staff remove photos.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('job_photo:' || p_id::TEXT));
  SELECT * INTO v_row FROM public.job_files WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.organization_id <> v_org OR v_row.kind <> 'photo' THEN
    RAISE EXCEPTION 'Photo not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('photo_id', v_row.id, 'state', 'removed', 'deleted_at', v_row.deleted_at);
  END IF;
  PERFORM set_config('quoteflow.photo_rpc', 'on', TRUE);
  UPDATE public.job_files SET deleted_at = v_now, deleted_by = v_user WHERE id = p_id;
  PERFORM set_config('quoteflow.photo_rpc', '', TRUE);
  SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_row.job_id;
  PERFORM security_audit.log_named_event(v_org, 'REMOVE_PHOTO', 'jobs', v_row.job_id::TEXT,
    jsonb_build_object('photo_id', p_id, 'job_no', v_job_no, 'was_uploaded', v_row.upload_state = 'uploaded', 'added_by', v_row.created_by));
  RETURN jsonb_build_object('photo_id', p_id, 'state', 'removed', 'deleted_at', v_now);
END
$$;
REVOKE ALL ON FUNCTION public.remove_job_photo(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_job_photo(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- Marks reservations older than p_hours (24 at least) that have NO stored object as 'abandoned' (a device that never came back
-- with the photo). Nothing is deleted: the rows stay, and a reservation whose object did land is left for its device to finalise.
-- An admin cleans their own company; the service role or a maintenance session (docs/RELEASE.md) every company. Returns the
-- number of rows marked, and writes one ABANDON_STALE_PHOTOS row (with the count) in each touched company's history. reserve_job_photo does the same for the caller's own reservations.
CREATE OR REPLACE FUNCTION public.abandon_stale_job_photos(p_hours INTEGER DEFAULT 24)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_maint BOOLEAN := coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated');
  v_org   UUID;
  v_n     INTEGER := 0;
  v_orgs  UUID[];
  v_rec   RECORD;
BEGIN
  IF p_hours IS NULL OR p_hours < 24 THEN
    RAISE EXCEPTION 'A reservation is abandoned after 24 hours at the earliest.' USING ERRCODE = '22023';
  END IF;
  IF NOT v_maint THEN
    PERFORM public.assert_privileged_aal();
    v_org := public.current_user_organization_id();
    IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only an admin cleans up photo reservations.' USING ERRCODE = '42501';
    END IF;
  END IF;
  PERFORM set_config('quoteflow.photo_rpc', 'on', TRUE);
  WITH marked AS (
    UPDATE public.job_files f SET upload_state = 'abandoned'
    WHERE f.kind = 'photo' AND f.upload_state = 'reserved' AND f.deleted_at IS NULL
      AND f.created_at < now() - make_interval(hours => p_hours)
      AND (v_maint OR f.organization_id = v_org)
      AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'job-photos' AND o.name = f.storage_path)
    RETURNING f.organization_id)
  SELECT coalesce(array_agg(organization_id), ARRAY[]::UUID[]) INTO v_orgs FROM marked;
  PERFORM set_config('quoteflow.photo_rpc', '', TRUE);
  -- One ABANDON_STALE_PHOTOS row in each touched company's history, with its count.
  FOR v_rec IN SELECT o AS org, count(*)::INTEGER AS n FROM unnest(v_orgs) AS o GROUP BY o LOOP
    PERFORM security_audit.log_named_event(v_rec.org, 'ABANDON_STALE_PHOTOS', 'job_files', v_rec.org::TEXT,
      jsonb_build_object('count', v_rec.n, 'older_than_hours', p_hours, 'scope', CASE WHEN v_maint THEN 'maintenance' ELSE 'company admin' END));
    v_n := v_n + v_rec.n;
  END LOOP;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.abandon_stale_job_photos(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abandon_stale_job_photos(INTEGER) TO authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Storage: the private job-photos bucket ----------------------------------------------------------------
-- The bucket refuses at upload anything over 2 MiB or not declared image/jpeg (the Storage service checks file_size_limit and
-- allowed_mime_types itself). Created here, or put back to these settings if it exists. For the browser roles one PERMISSIVE
-- rule lets in exactly the object a reservation of their own names; RESTRICTIVE rules on top take everything else away, so a
-- broader rule added later still can't open the bucket: no read, no listing, no signed link, no move or copy, no overwrite, no
-- delete. 033 (active session) and 036 (read-only support) apply here as everywhere. A Storage copy from another bucket the caller
-- can read into their own reserved path is NOT stopped by the bucket's limits (storage-api applies them to uploads only): it
-- ends as a mismatch (finalise marks the row abandoned, PHOTO_MISMATCH in the history) and is never served. The app server serves the bytes after the
-- person's own row read.
DO $do$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '040: storage schema not found, skipping the job-photos bucket and its rules';
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('job-photos', 'job-photos', FALSE, 2097152, ARRAY['image/jpeg'])
  ON CONFLICT (id) DO UPDATE SET public = FALSE, file_size_limit = 2097152, allowed_mime_types = ARRAY['image/jpeg'];

  DROP POLICY IF EXISTS "job photos: the reserved object is uploaded" ON storage.objects;
  CREATE POLICY "job photos: the reserved object is uploaded" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'job-photos'
                AND EXISTS (SELECT 1 FROM public.job_files f
                            WHERE f.storage_bucket = 'job-photos' AND f.storage_path = name AND f.kind = 'photo'
                              AND f.upload_state = 'reserved' AND f.deleted_at IS NULL
                              AND f.created_by = auth.uid() AND f.organization_id = public.current_user_organization_id()));
  DROP POLICY IF EXISTS "job photos: only the reserved object is uploaded" ON storage.objects;
  CREATE POLICY "job photos: only the reserved object is uploaded" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK (bucket_id <> 'job-photos'
                OR EXISTS (SELECT 1 FROM public.job_files f
                           WHERE f.storage_bucket = 'job-photos' AND f.storage_path = name AND f.kind = 'photo'
                             AND f.upload_state = 'reserved' AND f.deleted_at IS NULL
                             AND f.created_by = auth.uid() AND f.organization_id = public.current_user_organization_id()));
  DROP POLICY IF EXISTS "job photos are not read from storage" ON storage.objects;
  CREATE POLICY "job photos are not read from storage" ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
    USING (bucket_id <> 'job-photos');
  DROP POLICY IF EXISTS "job photos are not moved or overwritten" ON storage.objects;
  CREATE POLICY "job photos are not moved or overwritten" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
    USING (bucket_id <> 'job-photos') WITH CHECK (bucket_id <> 'job-photos');
  DROP POLICY IF EXISTS "job photos are not deleted" ON storage.objects;
  CREATE POLICY "job photos are not deleted" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
    USING (bucket_id <> 'job-photos');
END
$do$;
