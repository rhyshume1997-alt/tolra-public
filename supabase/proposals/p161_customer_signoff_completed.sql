-- =====================================================================================================
-- p161 (post-144 release 161, after 156 in supabase/release-plan.json): a customer's sign-off is accepted only on a RELEASED job, and
-- never for a revision ahead of the job's own. Fixes the P1 found by the audit (J3): sign_off_job_customer (072) recorded a customer's
-- signature on an unfinished job, with a made-up shown revision. PM ruling: "completed" = released by the existing server rule.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/161_customer_signoff_completed.release.sql, which adds the guard (072 and 081 in place; the function is 072's or
-- already 161's), a before/after fingerprint and the self-check. Verify: supabase/verify/customer_signoff_completed_161.sql (every row
-- true). Rollback: supabase/release/161_customer_signoff_completed.rollback.sql (puts 072's body back byte for byte).
--
-- INPUTS: none (one-time replacement of one function). OUTPUTS: public.sign_off_job_customer (the 12-argument form), below.
-- WHAT IT CHANGES: 072's body with exactly two checks added, straight after the replay branch (an offline replay of a signature that
--   is already recorded still returns its first answer, even if the job has changed since) and before the phone's clock window, the
--   company switch and the one-per-revision test:
--   1. The job must be released: public.job_release_state(job).released (081; the same rule that decides despatch: the job has passed
--      inspection with nothing live in rework, or an admin's recorded early release is in force; a finish time alone, a voided or a
--      stale early release does not count). Not released: ERRCODE 22023, HINT job_not_released, nothing written.
--   2. The revision the customer was shown (p_shown_version) must not be higher than the job's current worksheet_version: ERRCODE
--      22023, HINT shown_revision_ahead, nothing written. A LOWER (historical) shown revision and NULL are accepted as before.
--   Signature, SECURITY DEFINER, search_path, TimeZone, and grants (EXECUTE revoked from PUBLIC and anon, granted to authenticated) are
--   072's. Nothing is written on public.jobs; the function already holds the job row lock, so no new lock.
-- UNCHANGED BY DESIGN: delivery without a customer signature stays permitted (a delivery note's "signed" status never touches
--   job_signoffs); a late signature on a released job stays permitted (only 072's phone-clock window applies: 30 days before to 1 day
--   after the upload); one customer sign-off per revision; the company switch; staff sign-off (045's sign_off_job).
-- MUST NOT CHANGE: any other function, grant, policy or trigger; job_release_state and job_early_release_active (081); any row;
--   migration 072's files; company isolation (job_release_state is scoped to the caller's company).
-- ROLLBACK: puts 072's body back (supabase/release/161_customer_signoff_completed.rollback.sql); after it the defect is open again.
BEGIN;

CREATE OR REPLACE FUNCTION public.sign_off_job_customer(p_job_id UUID, p_signer_name TEXT, p_signer_position TEXT, p_signer_company TEXT, p_statement TEXT,
                                                        p_comment TEXT, p_signature_kind TEXT, p_signature_data TEXT, p_device_signed_at TIMESTAMPTZ,
                                                        p_client_op_id UUID, p_shown_version INTEGER DEFAULT NULL, p_shown_snapshot_sha256 TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit, extensions
SET TimeZone = 'UTC'
AS $$
DECLARE
  v_org       UUID := public.current_user_organization_id();
  v_user      UUID := auth.uid();
  v_name      TEXT := btrim(coalesce(p_signer_name, ''));
  v_position  TEXT := nullif(btrim(coalesce(p_signer_position, '')), '');
  v_company   TEXT := nullif(btrim(coalesce(p_signer_company, '')), '');
  v_statement TEXT := btrim(coalesce(p_statement, ''));
  v_comment   TEXT := nullif(btrim(coalesce(p_comment, '')), '');
  v_kind      TEXT := p_signature_kind;
  v_data      TEXT := CASE WHEN p_signature_kind = 'typed' THEN btrim(coalesce(p_signature_data, '')) ELSE coalesce(p_signature_data, '') END;
  v_device    TIMESTAMPTZ := date_trunc('milliseconds', p_device_signed_at);
  v_shown_sha TEXT := nullif(lower(btrim(coalesce(p_shown_snapshot_sha256, ''))), '');
  v_initials  TEXT;
  v_signed_on DATE;
  v_job       public.jobs%ROWTYPE;
  v_snapshot  JSONB;
  v_sha       TEXT;
  v_record    TEXT;
  v_email     TEXT;
  v_id        UUID;
  v_prior     public.job_signoffs%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 200 OR position('@' IN v_name) > 0 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Enter the customer''s name in capitals (up to 200 characters, not an e-mail address).' USING ERRCODE = '22023';
  END IF;
  IF v_position IS NOT NULL AND (length(v_position) > 120 OR v_position ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'The position is up to 120 characters.' USING ERRCODE = '22023';
  END IF;
  IF v_company IS NOT NULL AND (length(v_company) > 200 OR v_company ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'The company name is up to 200 characters.' USING ERRCODE = '22023';
  END IF;
  IF length(v_statement) NOT BETWEEN 1 AND 500 OR v_statement ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'The statement the customer signs is missing. Reload and try again.' USING ERRCODE = '22023';
  END IF;
  IF v_comment IS NOT NULL AND (length(v_comment) > 1000 OR regexp_replace(v_comment, '[\n\r\t]', '', 'g') ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'The comment is up to 1000 characters.' USING ERRCODE = '22023';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('drawn', 'typed') THEN
    RAISE EXCEPTION 'The signature is drawn or typed.' USING ERRCODE = '22023';
  END IF;
  -- Stored inline, as in 045: a drawn signature is an SVG path of M/L/Q/Z commands and numbers, at most 100000 characters.
  IF v_kind = 'drawn' AND (length(v_data) NOT BETWEEN 1 AND 100000 OR v_data !~ '^M[MLQZml0-9 .,-]*$' OR position('L' IN v_data) = 0) THEN
    RAISE EXCEPTION 'Ask the customer to sign in the box, or type their name instead.' USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'typed' AND (length(v_data) NOT BETWEEN 1 AND 200 OR v_data ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Type the customer''s signature (up to 200 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_device IS NULL OR NOT isfinite(v_device) THEN
    RAISE EXCEPTION 'The time the customer signed is missing.' USING ERRCODE = '22023', HINT = 'device_time_out_of_range';
  END IF;
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'The signature''s key is missing. Reload and try again.' USING ERRCODE = '22023';
  END IF;
  IF (p_shown_version IS NOT NULL AND p_shown_version < 0) OR (v_shown_sha IS NOT NULL AND v_shown_sha !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'The revision shown when the customer signed is not valid. Reload and try again.' USING ERRCODE = '22023';
  END IF;

  -- Initials from the printed name (keep in step with initialsFrom in lib/job-signoff.ts), or 'C' for a name with no A-Z letter.
  SELECT upper(left(coalesce(string_agg(left(regexp_replace(t.w, '[^A-Za-z]', '', 'g'), 1), '' ORDER BY t.n), ''), 4)) INTO v_initials
    FROM regexp_split_to_table(regexp_replace(normalize(v_name, NFD), '[̀-ͯ]', '', 'g'), '[\s-]+') WITH ORDINALITY AS t(w, n);
  IF coalesce(v_initials, '') = '' THEN
    v_initials := 'C';
  END IF;
  v_signed_on := (least(v_device, now()) AT TIME ZONE 'Europe/London')::DATE;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- A replay (a retry after a lost answer, or the offline queue sending it again): the same key, capturer, job and content return the
  -- first answer and add nothing. The key with any other content is refused. Under the job row lock.
  SELECT * INTO v_prior FROM public.job_signoffs s WHERE s.organization_id = v_org AND s.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_prior.job_id = p_job_id AND v_prior.signed_by = v_user AND v_prior.kind = 'customer' AND v_prior.signer_name = v_name
       AND v_prior.signer_position IS NOT DISTINCT FROM v_position AND v_prior.signer_company IS NOT DISTINCT FROM v_company
       AND v_prior.statement = v_statement AND v_prior.customer_comment IS NOT DISTINCT FROM v_comment AND v_prior.signature_kind = v_kind
       AND v_prior.signature_data = v_data AND v_prior.device_signed_at = v_device
       AND v_prior.shown_worksheet_version IS NOT DISTINCT FROM p_shown_version AND v_prior.shown_snapshot_sha256 IS NOT DISTINCT FROM v_shown_sha THEN
      RETURN jsonb_build_object('id', v_prior.id, 'worksheet_version', v_prior.worksheet_version, 'kind', v_prior.kind, 'snapshot_sha256', v_prior.snapshot_sha256,
                                'record_sha256', v_prior.record_sha256, 'replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'This signature''s key was already used for a different signature. Capture it again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;

  -- 161: a customer signs for a RELEASED job only (081's public.job_release_state decides, as it does for despatch: the job has passed
  -- inspection, or an admin recorded an early release that is still in force), and the revision the customer was shown cannot be ahead
  -- of the job's own. After the replay above, so a recorded signature's late retry still gets its first answer. Reads only; the job row
  -- is already locked.
  IF NOT coalesce((SELECT s.released FROM public.job_release_state(p_job_id) s), FALSE) THEN
    RAISE EXCEPTION 'Job % has not been released. The customer can sign once the job has passed inspection or an admin has released it early.', v_job.job_no
      USING ERRCODE = '22023', HINT = 'job_not_released';
  END IF;
  IF p_shown_version IS NOT NULL AND p_shown_version > v_job.worksheet_version THEN
    RAISE EXCEPTION 'The revision shown when the customer signed (%) is ahead of the job''s current revision (%). Reload and try again.', p_shown_version, v_job.worksheet_version
      USING ERRCODE = '22023', HINT = 'shown_revision_ahead';
  END IF;

  -- The phone's clock (checked after the replay, so a recorded upload's late retry still gets its answer).
  IF v_device < now() - INTERVAL '30 days' OR v_device > now() + INTERVAL '1 day' THEN
    RAISE EXCEPTION 'This phone''s date and time (%) is wrong or the signature is more than 30 days old. Set the phone''s date and time, then capture the customer''s signature again.',
      to_char(v_device AT TIME ZONE 'Europe/London', 'DD Mon YYYY HH24:MI') USING ERRCODE = '22023', HINT = 'device_time_out_of_range';
  END IF;

  IF NOT coalesce((SELECT s.customer_signoff_enabled FROM public.organization_settings s WHERE s.organization_id = v_org), FALSE) THEN
    RAISE EXCEPTION 'Customer sign-off on jobs is turned off for this company. An admin can turn it on in Settings.' USING ERRCODE = '42501', HINT = 'customer_signoff_off';
  END IF;

  IF EXISTS (SELECT 1 FROM public.job_signoffs s WHERE s.job_id = p_job_id AND s.worksheet_version = v_job.worksheet_version AND s.kind = 'customer') THEN
    RAISE EXCEPTION 'Revision % of % already has a customer sign-off.', v_job.worksheet_version, v_job.job_no USING ERRCODE = '23505', HINT = 'already_signed';
  END IF;

  v_snapshot := public.job_signoff_snapshot(v_job);
  v_sha := encode(extensions.digest(convert_to(public.canonical_jsonb(v_snapshot), 'UTF8'), 'sha256'), 'hex');
  -- Keep in step with recordSha256 in lib/job-signoff.ts (045's fields, then the customer's and the capturer).
  v_record := encode(extensions.digest(convert_to(public.canonical_jsonb(jsonb_build_object(
    'snapshot_sha256', v_sha, 'initials', v_initials, 'signer_name', v_name, 'signed_on', to_char(v_signed_on, 'YYYY-MM-DD'),
    'signature_kind', v_kind, 'signature_data', v_data, 'worksheet_version', v_job.worksheet_version::TEXT, 'job_id', p_job_id::TEXT,
    'kind', 'customer', 'signer_position', v_position, 'signer_company', v_company, 'statement', v_statement, 'customer_comment', v_comment,
    'device_signed_at', to_char(v_device, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'shown_worksheet_version', p_shown_version::TEXT,
    'shown_snapshot_sha256', v_shown_sha, 'captured_by', v_user::TEXT)), 'UTF8'), 'sha256'), 'hex');

  BEGIN
    INSERT INTO public.job_signoffs (organization_id, job_id, worksheet_version, snapshot, snapshot_sha256, record_sha256, initials, signer_name, signed_on,
                                     signature_kind, signature_data, signed_by, kind, client_op_id, signer_position, signer_company, statement,
                                     customer_comment, device_signed_at, shown_worksheet_version, shown_snapshot_sha256)
    VALUES (v_org, p_job_id, v_job.worksheet_version, v_snapshot, v_sha, v_record, v_initials, v_name, v_signed_on, v_kind, v_data, v_user, 'customer',
            p_client_op_id, v_position, v_company, v_statement, v_comment, v_device, p_shown_version, v_shown_sha)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- The key was taken meanwhile by a signature on another job (that one held another job's lock).
    IF SQLERRM LIKE '%job_signoffs_client_op%' THEN
      RAISE EXCEPTION 'This signature''s key was already used for a different signature. Capture it again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
    RAISE;
  END;

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'JOB_CUSTOMER_SIGN_OFF', 'jobs', p_job_id::TEXT,
          jsonb_build_object('source', 'write_audit', 'signoff_id', v_id, 'job_no', v_job.job_no, 'worksheet_version', v_job.worksheet_version,
                             'shown_worksheet_version', p_shown_version, 'kind', 'customer', 'snapshot_sha256', v_sha, 'client_op_id', p_client_op_id));
  RETURN jsonb_build_object('id', v_id, 'worksheet_version', v_job.worksheet_version, 'kind', 'customer', 'snapshot_sha256', v_sha, 'record_sha256', v_record, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.sign_off_job_customer(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_off_job_customer(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER, TEXT) TO authenticated;

COMMIT;
