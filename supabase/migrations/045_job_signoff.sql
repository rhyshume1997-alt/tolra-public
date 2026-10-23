-- =====================================================================================================
-- 045: operator sign-off (M4). One migration for every database change in the batch.
--
-- At the end of a job the operator signs off: initials, name, a date and a signature (drawn on screen as an SVG path, or a
-- typed e-signature as the fallback). The server takes a canonical snapshot of the worksheet as it is at that moment, hashes it
-- (SHA-256 over a deterministic serialisation) and keeps both with the signature.
--
--  * A revision is jobs.worksheet_version (022/034: jobs_worksheet_version raises it on any worksheet field change). There is no
--    revision table: a sign-off belongs to the version it signed. "Signed" means a sign-off exists for the CURRENT version; an edit
--    afterwards leaves the old sign-off attached to the old revision and the job shows "edited since: sign again".
--  * public.job_signoffs holds the records. Everyone in the company can read them; nobody can write them through the API: rows are
--    added by sign_off_job only, and a trigger refuses any UPDATE or DELETE (also from definer code and the service role). Jobs are
--    never deleted (028: archive), so job_id is ON DELETE RESTRICT. signed_by is a plain UUID (no foreign key), so removing a user
--    never rewrites a signed record.
--  * public.canonical_jsonb(jsonb) is the SQL half of lib/snapshot-hash.ts canonicalJson: keys sorted by code point, no spaces,
--    strings escaped as JSON.stringify does, arrays in order; numbers are refused (a snapshot holds numbers as text). A DB test
--    proves the SQL and TypeScript hashes are identical.
--  * public.sign_off_job builds the snapshot itself from the locked job row (the worksheet fields jobs_worksheet_version watches,
--    except the legacy signed_off_by / signed_off_at, plus job_no and worksheet_version), stores snapshot_sha256 and record_sha256
--    (a hash over the snapshot hash and the signature fields, so the signature itself is tamper-evident) and writes JOB_SIGN_OFF
--    to the audit log. It does not change the job: worksheet_version, the release (jobs_release_guard) and the legacy
--    signed_off_* columns stay as they are, so signing before or after the inspection changes neither.
--  * A stale revision is refused the way record_job_inspection (034) and the rework functions (037) refuse one: SQLSTATE 22023 with a
--    message for the person (shown as it is by the app); 40001 is not used because clients retry it.
--  * Like every company table (036, 037) it carries the support_read_only and admin_mfa statement triggers.
--  * One sign-off per revision, with an optional co-signature (Rhys: "one sig for each bit", co-signing for inspecting). Each row has
--    a kind: 'primary' (the operator's sign-off) or a co-sign role; the only role today is 'inspector' (adding one is a change to the
--    CHECK and to SIGNOFF_ROLES in lib/job-signoff.ts). UNIQUE (job_id, worksheet_version, kind): exactly one primary and at most
--    one co-signature per role on a revision. A co-signature needs the revision's primary first and a different person (signed_by)
--    from the primary signer; the inspector is an admin or a member with can_inspect (034), as for record_job_inspection. A new
--    revision takes a new primary. The kind is part of record_sha256.
--  * Bound to one frozen revision: the client sends the revision it showed (p_expected_version) AND that revision's snapshot hash
--    (p_expected_snapshot_sha256, read from job_signoff_revision, or for a co-signature the primary's own snapshot_sha256). Under the
--    job row lock the server rebuilds the snapshot and refuses (22023, hint stale_revision) unless both match; a co-signature must
--    also match the primary's snapshot_sha256, so primary and co-signature always sign the same snapshot.
--  * Signatures are stored inline (signature_data: the drawn SVG path, at most 100000 characters of M/L/Q/Z commands and numbers,
--    or the typed name, at most 200 characters), never in Storage: the row is the signature, so the immutability trigger covers
--    the image itself. sign_off_job validates the format and size; the table CHECK repeats it.
--  * Offline signing (Rhys: "sign and save offline but uploads when back"): the app queues the signature on the device under its
--    client key (p_client_op_id, UNIQUE per company with the row). A replay of the key by the same signer with the same content
--    returns the first answer (replayed = true) and adds nothing, even when the worksheet changed since; the same key with any other
--    content, another job or another signer is refused (22023, hint client_op_reused). Every other rule (stale revision,
--    needs_primary, same_signer, not_inspector, already_signed) is checked again on upload.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. Canonical serialisation (keep in step with canonicalJson in lib/snapshot-hash.ts).
CREATE OR REPLACE FUNCTION public.canonical_jsonb(p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      -- COLLATE "C" in a UTF-8 database orders by bytes, which is code point order.
      RETURN '{' || coalesce((SELECT string_agg(to_jsonb(e.key)::TEXT || ':' || public.canonical_jsonb(e.value), ',' ORDER BY e.key COLLATE "C")
                              FROM jsonb_each(p_value) e), '') || '}';
    WHEN 'array' THEN
      RETURN '[' || coalesce((SELECT string_agg(public.canonical_jsonb(e.value), ',' ORDER BY e.n)
                              FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, n)), '') || ']';
    WHEN 'string' THEN
      RETURN p_value::TEXT;
    WHEN 'boolean' THEN
      RETURN p_value::TEXT;
    WHEN 'null' THEN
      RETURN 'null';
    ELSE
      RAISE EXCEPTION 'canonical_jsonb: a snapshot holds numbers as text' USING ERRCODE = '22023';
  END CASE;
END
$$;
-- An internal helper: not callable through the API. sign_off_job is SECURITY DEFINER and runs it as the function owner, and so does
-- canonical_jsonb itself when it calls itself; nothing in 045 relies on authenticated being able to execute it.
REVOKE ALL ON FUNCTION public.canonical_jsonb(JSONB) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 2. The sign-off records.
CREATE TABLE IF NOT EXISTS public.job_signoffs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  job_id            UUID NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  worksheet_version INTEGER NOT NULL CHECK (worksheet_version >= 0),
  snapshot          JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_sha256   TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  record_sha256     TEXT NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  initials          TEXT NOT NULL CHECK (initials ~ '^[A-Z]{1,4}$'),
  signer_name       TEXT NOT NULL CHECK (length(btrim(signer_name)) BETWEEN 1 AND 200 AND position('@' IN signer_name) = 0 AND signer_name !~ '[[:cntrl:]]'),
  signed_on         DATE NOT NULL,
  signature_kind    TEXT NOT NULL CHECK (signature_kind IN ('drawn', 'typed')),
  signature_data    TEXT NOT NULL,
  signed_by         UUID NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary', 'inspector')),
  client_op_id      UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_signoffs_one_per_kind UNIQUE (job_id, worksheet_version, kind),
  CONSTRAINT job_signoffs_client_op UNIQUE (organization_id, client_op_id),
  CONSTRAINT job_signoffs_signature_shape CHECK (
    (signature_kind = 'drawn' AND length(signature_data) BETWEEN 1 AND 100000 AND signature_data ~ '^M[MLQZml0-9 .,-]*$')
    OR (signature_kind = 'typed' AND length(btrim(signature_data)) BETWEEN 1 AND 200 AND signature_data !~ '[[:cntrl:]]'))
);
CREATE INDEX IF NOT EXISTS idx_job_signoffs_job ON public.job_signoffs (job_id, worksheet_version DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_signoffs_org ON public.job_signoffs (organization_id);

ALTER TABLE public.job_signoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_signoffs rbac select" ON public.job_signoffs;
CREATE POLICY "job_signoffs rbac select" ON public.job_signoffs FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.job_signoffs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_signoffs TO authenticated;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_signoffs;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');

-- A signed record is never changed or removed, by anyone (the API has no grant; this also stops definer code and the service role).
CREATE OR REPLACE FUNCTION public.job_signoffs_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'A sign-off is a record: it is never changed or removed. Sign again on the current revision instead.' USING ERRCODE = '42501';
END
$$;
DROP TRIGGER IF EXISTS job_signoffs_immutable ON public.job_signoffs;
CREATE TRIGGER job_signoffs_immutable BEFORE UPDATE OR DELETE ON public.job_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.job_signoffs_immutable();
DROP TRIGGER IF EXISTS job_signoffs_no_truncate ON public.job_signoffs;
CREATE TRIGGER job_signoffs_no_truncate BEFORE TRUNCATE ON public.job_signoffs
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_signoffs_immutable();

DROP TRIGGER IF EXISTS audit_job_signoffs_changes ON public.job_signoffs;
CREATE TRIGGER audit_job_signoffs_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_signoffs
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- Support access is read-only (036) and an admin at aal1 writes nothing when the company requires the second step (033): the
-- statement triggers every company table carries (036 adds them to the tables that exist when it runs; a later table adds its own).
DROP TRIGGER IF EXISTS support_read_only ON public.job_signoffs;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.job_signoffs
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_signoffs;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.job_signoffs
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. The revision's snapshot. job_signoff_snapshot builds it from a jobs row (internal: no API role may execute it);
-- job_signoff_revision gives a company member the current revision and its snapshot hash, which the app sends back with the
-- signature (and keeps on the device for signing offline).
CREATE OR REPLACE FUNCTION public.job_signoff_snapshot(p_job public.jobs)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The worksheet fields (jobs_worksheet_version, 034), without the legacy signed_off_by / signed_off_at this record replaces.
  v_fields CONSTANT TEXT[] := ARRAY[
    'description', 'material_ordered', 'checklist', 'customer_po', 'date_received', 'date_required', 'quote_ref',
    'dimension_report_no', 'material_cert_no', 'heat_cast_no', 'drawing_no', 'material_required', 'material_ordered_at',
    'material_ordered_notes', 'material_supplier', 'machine_1', 'program_1', 'machine_2', 'program_2', 'machine_3',
    'program_3', 'improvement_comments', 'overrun_reasons', 'checked_by',
    'job_time_quoted_hr', 'job_time_taken_hr', 'quantity_required', 'setup_time_hr', 'run_time_hr'];
  v_row      JSONB := to_jsonb(p_job);
  v_snapshot JSONB;
  v_val      JSONB;
  v_key      TEXT;
BEGIN
  -- Strings, booleans and nulls only (numbers as their text), so that both serialisations agree.
  v_snapshot := jsonb_build_object('job_no', to_jsonb(p_job.job_no), 'worksheet_version', to_jsonb(p_job.worksheet_version::TEXT));
  FOREACH v_key IN ARRAY v_fields LOOP
    v_val := v_row -> v_key;
    IF v_key = 'checklist' THEN
      SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) IN ('boolean', 'string', 'null') THEN e.value ELSE to_jsonb(e.value #>> '{}') END), '{}'::JSONB)
        INTO v_val
        FROM jsonb_each(CASE WHEN jsonb_typeof(v_val) = 'object' THEN v_val ELSE '{}'::JSONB END) e;
    ELSIF v_val IS NULL OR jsonb_typeof(v_val) = 'null' THEN
      v_val := 'null'::JSONB;
    ELSIF jsonb_typeof(v_val) NOT IN ('string', 'boolean') THEN
      v_val := to_jsonb(v_val #>> '{}');
    END IF;
    v_snapshot := v_snapshot || jsonb_build_object(v_key, v_val);
  END LOOP;
  RETURN v_snapshot;
END
$$;
REVOKE ALL ON FUNCTION public.job_signoff_snapshot(public.jobs) FROM PUBLIC, anon, authenticated;

-- { job_id, worksheet_version, snapshot_sha256 } of the caller's company's job (P0002 for any other job). Read only.
CREATE OR REPLACE FUNCTION public.job_signoff_revision(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_job public.jobs%ROWTYPE;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object('job_id', v_job.id, 'worksheet_version', v_job.worksheet_version,
    'snapshot_sha256', encode(extensions.digest(convert_to(public.canonical_jsonb(public.job_signoff_snapshot(v_job)), 'UTF8'), 'sha256'), 'hex'));
END
$$;
REVOKE ALL ON FUNCTION public.job_signoff_revision(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_signoff_revision(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Signing off. Organisation and signer come from the session; the job row is locked first. The date is the operator's (a paper
-- sign-off, or one signed offline and uploaded later, can be entered later) but never after today in the UK and never before the job
-- started (its start day in the UK, or the day it was created when it has no start). p_kind is 'primary' (the default) or a co-sign
-- role ('inspector'). p_expected_version and p_expected_snapshot_sha256 are the revision the person signed (see section 3). p_client_op_id
-- is the app's key for this signature (offline queue and retries). Refusals for the person: a stale revision (the version or the snapshot
-- hash differs, or a co-signature's snapshot isn't the primary's) 22023 (hint stale_revision); a second primary or a second co-signature
-- of a role on the revision 23505 (hint already_signed); a co-signature before the primary 22023 (hint needs_primary); a co-signature by
-- the primary signer 22023 (hint same_signer); an inspector co-signature by someone who may not inspect 42501 (hint not_inspector); a
-- client key already used for different content 22023 (hint client_op_reused). The checks run under the job row lock and the unique
-- constraints back them. Returns { id, worksheet_version, kind, snapshot_sha256, record_sha256, replayed }.
-- The earlier forms (7 and 8 arguments, before the frozen-revision and offline decisions; never applied to a hosted project) are dropped
-- so only one signature exists.
DROP FUNCTION IF EXISTS public.sign_off_job(UUID, INTEGER, TEXT, TEXT, DATE, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.sign_off_job(UUID, INTEGER, TEXT, TEXT, DATE, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.sign_off_job(p_job_id UUID, p_expected_version INTEGER, p_expected_snapshot_sha256 TEXT, p_initials TEXT, p_signer_name TEXT,
                                               p_signed_on DATE, p_signature_kind TEXT, p_signature_data TEXT, p_kind TEXT DEFAULT 'primary', p_client_op_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit, extensions
SET TimeZone = 'UTC'
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_user     UUID := auth.uid();
  v_initials TEXT := upper(btrim(coalesce(p_initials, '')));
  v_name     TEXT := btrim(coalesce(p_signer_name, ''));
  v_kind     TEXT := p_signature_kind;
  v_data     TEXT := CASE WHEN p_signature_kind = 'typed' THEN btrim(coalesce(p_signature_data, '')) ELSE coalesce(p_signature_data, '') END;
  v_expected TEXT := lower(btrim(coalesce(p_expected_snapshot_sha256, '')));
  v_job      public.jobs%ROWTYPE;
  v_start    DATE;
  v_snapshot JSONB;
  v_sha      TEXT;
  v_record   TEXT;
  v_email    TEXT;
  v_id       UUID;
  v_role     TEXT := coalesce(p_kind, 'primary');
  v_primary  public.job_signoffs%ROWTYPE;
  v_prior    public.job_signoffs%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_initials !~ '^[A-Z]{1,4}$' THEN
    RAISE EXCEPTION 'Initials are 1 to 4 letters.' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 200 OR position('@' IN v_name) > 0 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Enter your name (up to 200 characters, not an e-mail address).' USING ERRCODE = '22023';
  END IF;
  IF p_signed_on IS NULL OR p_signed_on > (now() AT TIME ZONE 'Europe/London')::DATE THEN
    RAISE EXCEPTION 'The sign-off date can''t be in the future.' USING ERRCODE = '22023';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('drawn', 'typed') THEN
    RAISE EXCEPTION 'The signature is drawn or typed.' USING ERRCODE = '22023';
  END IF;
  -- The signature is stored inline, so its format and size are checked here: a drawn one is an SVG path of M/L/Q/Z commands and numbers
  -- (no data: URL, no markup), at most 100000 characters; a typed one is at most 200 characters of text.
  IF v_kind = 'drawn' AND (length(v_data) NOT BETWEEN 1 AND 100000 OR v_data !~ '^M[MLQZml0-9 .,-]*$' OR position('L' IN v_data) = 0) THEN
    RAISE EXCEPTION 'Draw your signature, or type it instead.' USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'typed' AND (length(v_data) NOT BETWEEN 1 AND 200 OR v_data ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Type your signature (up to 200 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_role NOT IN ('primary', 'inspector') THEN
    RAISE EXCEPTION 'A sign-off is the primary signature or an inspector''s co-signature.' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR v_expected !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Reload the worksheet before signing (the revision you are signing is missing).' USING ERRCODE = '22023', HINT = 'stale_revision';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- A replay of a signature already recorded (a retry after a lost answer, or the offline queue sending it again): the same key, signer,
  -- job, role, revision and content return the first answer and add nothing, whatever happened to the worksheet since. The key with any
  -- other content is refused, never reported as replayed. Under the job row lock, so two retries of one key can't both insert.
  IF p_client_op_id IS NOT NULL THEN
    SELECT * INTO v_prior FROM public.job_signoffs s WHERE s.organization_id = v_org AND s.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_prior.job_id = p_job_id AND v_prior.signed_by = v_user AND v_prior.kind = v_role AND v_prior.worksheet_version = p_expected_version
         AND v_prior.snapshot_sha256 = v_expected AND v_prior.initials = v_initials AND v_prior.signer_name = v_name AND v_prior.signed_on = p_signed_on
         AND v_prior.signature_kind = v_kind AND v_prior.signature_data = v_data THEN
        RETURN jsonb_build_object('id', v_prior.id, 'worksheet_version', v_prior.worksheet_version, 'kind', v_prior.kind, 'snapshot_sha256', v_prior.snapshot_sha256,
                                  'record_sha256', v_prior.record_sha256, 'replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This signature''s key was already used for a different signature. Sign again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;

  v_start := (coalesce(v_job.started_at, v_job.created_at) AT TIME ZONE 'Europe/London')::DATE;
  IF p_signed_on < v_start THEN
    RAISE EXCEPTION 'The sign-off date can''t be before the job started (%, %).', v_job.job_no, to_char(v_start, 'FMDD FMMonth YYYY') USING ERRCODE = '22023';
  END IF;
  IF v_job.finished_at IS NULL THEN
    RAISE EXCEPTION '% is not finished yet: finish the job before signing it off.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  -- The frozen revision: the version AND the snapshot the person saw. The same code as record_job_inspection (034) and the rework functions
  -- (037) use for a stale version; the app shows the message. 40001 is not used because clients retry it.
  v_snapshot := public.job_signoff_snapshot(v_job);
  v_sha := encode(extensions.digest(convert_to(public.canonical_jsonb(v_snapshot), 'UTF8'), 'sha256'), 'hex');
  IF p_expected_version IS DISTINCT FROM v_job.worksheet_version OR v_expected IS DISTINCT FROM v_sha THEN
    RAISE EXCEPTION 'The worksheet changed since you opened it: reload and check before signing (% is now revision %).', v_job.job_no, v_job.worksheet_version
      USING ERRCODE = '22023', HINT = 'stale_revision';
  END IF;
  -- One primary and at most one co-signature per role on a revision (the row lock above serialises signers of this job).
  IF EXISTS (SELECT 1 FROM public.job_signoffs s WHERE s.job_id = p_job_id AND s.worksheet_version = v_job.worksheet_version AND s.kind = v_role) THEN
    RAISE EXCEPTION '%', CASE WHEN v_role = 'primary'
        THEN format('Revision %s of %s is already signed off. Edit the worksheet to make a new revision, or add a co-signature.', v_job.worksheet_version, v_job.job_no)
        ELSE format('Revision %s of %s already has an %s co-signature.', v_job.worksheet_version, v_job.job_no, v_role) END
      USING ERRCODE = '23505', HINT = 'already_signed';
  END IF;
  IF v_role <> 'primary' THEN
    SELECT * INTO v_primary FROM public.job_signoffs s WHERE s.job_id = p_job_id AND s.worksheet_version = v_job.worksheet_version AND s.kind = 'primary';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Revision % of % has no sign-off yet: the operator signs first, then the % co-signs.', v_job.worksheet_version, v_job.job_no, v_role
        USING ERRCODE = '22023', HINT = 'needs_primary';
    END IF;
    -- The co-signature signs the very snapshot the primary signed.
    IF v_primary.snapshot_sha256 IS DISTINCT FROM v_sha THEN
      RAISE EXCEPTION 'The worksheet changed since revision % of % was signed: reload and check before co-signing.', v_job.worksheet_version, v_job.job_no
        USING ERRCODE = '22023', HINT = 'stale_revision';
    END IF;
    IF v_primary.signed_by = v_user THEN
      RAISE EXCEPTION 'You signed revision % of % yourself: a co-signature is from someone else.', v_job.worksheet_version, v_job.job_no
        USING ERRCODE = '22023', HINT = 'same_signer';
    END IF;
    -- An inspector's co-signature is from someone who may inspect: an admin, or a member an admin made an inspector (034).
    IF NOT public.has_org_role(ARRAY['admin'])
       AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_user AND m.organization_id = v_org AND m.active AND m.can_inspect) THEN
      RAISE EXCEPTION 'An admin has to make you an inspector before you can co-sign as the inspector.' USING ERRCODE = '42501', HINT = 'not_inspector';
    END IF;
  END IF;

  -- Keep in step with recordSha256 in lib/job-signoff.ts.
  v_record := encode(extensions.digest(convert_to(public.canonical_jsonb(jsonb_build_object(
    'snapshot_sha256', v_sha, 'initials', v_initials, 'signer_name', v_name, 'signed_on', to_char(p_signed_on, 'YYYY-MM-DD'),
    'signature_kind', v_kind, 'signature_data', v_data, 'worksheet_version', v_job.worksheet_version::TEXT, 'job_id', p_job_id::TEXT,
    'kind', v_role)), 'UTF8'), 'sha256'), 'hex');

  BEGIN
    INSERT INTO public.job_signoffs (organization_id, job_id, worksheet_version, snapshot, snapshot_sha256, record_sha256, initials, signer_name,
                                     signed_on, signature_kind, signature_data, signed_by, kind, client_op_id)
    VALUES (v_org, p_job_id, v_job.worksheet_version, v_snapshot, v_sha, v_record, v_initials, v_name, p_signed_on, v_kind, v_data, v_user, v_role, p_client_op_id)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- The key was taken meanwhile by a signature on another job (that one held another job's lock).
    IF SQLERRM LIKE '%job_signoffs_client_op%' THEN
      RAISE EXCEPTION 'This signature''s key was already used for a different signature. Sign again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
    RAISE;
  END;

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'JOB_SIGN_OFF', 'jobs', p_job_id::TEXT,
          jsonb_build_object('source', 'write_audit', 'signoff_id', v_id, 'job_no', v_job.job_no, 'worksheet_version', v_job.worksheet_version,
                             'kind', v_role, 'snapshot_sha256', v_sha, 'client_op_id', p_client_op_id));
  RETURN jsonb_build_object('id', v_id, 'worksheet_version', v_job.worksheet_version, 'kind', v_role, 'snapshot_sha256', v_sha, 'record_sha256', v_record, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.sign_off_job(UUID, INTEGER, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_off_job(UUID, INTEGER, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, UUID) TO authenticated;
