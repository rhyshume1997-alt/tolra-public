-- Post-144 release step 161 (a customer's sign-off only on a released job, never for a revision ahead of the job's; registered in
-- supabase/release-plan.json as phase 161, after 156; CI's post-144 step installs it). One transaction; never part of baseline replay.
-- Not applied anywhere hosted. Canonical source: supabase/proposals/p161_customer_signoff_completed.sql (its body between BEGIN; and
-- COMMIT; is copied below verbatim between the fingerprint and the self-check; read its header). Its guard needs 072 (customer sign-off)
-- and 081 (job release) only. Production only with Rhys's separate yes.
-- Verify: supabase/verify/customer_signoff_completed_161.sql (every row true).
-- Rollback: supabase/release/161_customer_signoff_completed.rollback.sql (puts 072's body back byte for byte; run it BEFORE 081's rollback).
-- Running this file again once applied changes nothing (the body is already 161's). REFUSES, changing nothing, if
-- public.sign_off_job_customer (the 12-argument form) is neither 072's nor 161's body (HINT: compare it first), or if 081's
-- public.job_release_state(uuid) or public.job_early_release_active(uuid) is missing. Changes no row and no other function, grant,
-- policy or trigger (the fingerprint below proves it). Release preflight row 60 shows which body is in place.
BEGIN;
DO $post_release_guard$
DECLARE
  v TEXT;
BEGIN
 IF to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)') IS NULL
    OR to_regclass('public.job_signoffs') IS NULL THEN
  RAISE EXCEPTION '161: required release 072 (customer sign-off) is missing; stop and check release preflight';
 END IF;
 IF to_regprocedure('public.job_release_state(uuid)') IS NULL OR to_regprocedure('public.job_early_release_active(uuid)') IS NULL THEN
  RAISE EXCEPTION '161: required release 081 (job flow and release: public.job_release_state, public.job_early_release_active) is missing; stop and check release preflight';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)') AND p.prosrc LIKE '%job_early_release_active%') THEN
  RAISE EXCEPTION '161: public.job_release_state is not 081''s (it does not ask job_early_release_active); stop and compare it first';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)');
 IF v IS DISTINCT FROM 'f3857352acdfa18b4738fc850dde461d' AND v IS DISTINCT FROM 'b8b2a0f43fac263f8b913c2f9f1d8e9f' THEN
  RAISE EXCEPTION '161: public.sign_off_job_customer is neither 072''s nor 161''s; stop and compare it first';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 161 must not touch: every other function in public and security_audit (body, definer flag, settings,
-- grants, owner), every policy and trigger there, and the sign-off and job rows. The function 161 replaces is fingerprinted apart
-- (everything but its body). The self-check requires the identical fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p161_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p161fp$
  SELECT 'other functions'::TEXT, md5(coalesce(string_agg(p.oid::regprocedure::TEXT || '|' || p.prosrc || '|' || p.prosecdef::TEXT || '|' || coalesce(p.proconfig::TEXT, '-') || '|'
                                                          || coalesce(p.proacl::TEXT, '-') || '|' || pg_get_userbyid(p.proowner), E'\n' ORDER BY p.oid::regprocedure::TEXT), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit')
    AND p.oid IS DISTINCT FROM to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
  UNION ALL SELECT 'sign_off_job_customer apart from its body', md5(p.oid::regprocedure::TEXT || '|' || pg_get_function_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::TEXT
                                                                || '|' || p.provolatile::TEXT || '|' || coalesce(p.proconfig::TEXT, '-') || '|' || coalesce(p.proacl::TEXT, '-') || '|' || pg_get_userbyid(p.proowner))
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
  UNION ALL SELECT 'policies', md5(coalesce(string_agg(c.oid::regclass::TEXT || '|' || o.polname || '|' || o.polcmd::TEXT || '|' || o.polroles::TEXT || '|' || coalesce(pg_get_expr(o.polqual, o.polrelid), '-')
                                                       || '|' || coalesce(pg_get_expr(o.polwithcheck, o.polrelid), '-'), E'\n' ORDER BY c.oid::regclass::TEXT, o.polname), ''))
  FROM pg_policy o JOIN pg_class c ON c.oid = o.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'security_audit')
  UNION ALL SELECT 'triggers', md5(coalesce(string_agg(pg_get_triggerdef(t.oid), E'\n' ORDER BY c.oid::regclass::TEXT, t.tgname), ''))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public', 'security_audit')
  UNION ALL SELECT 'job_signoffs rows', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.job_signoffs x
  UNION ALL SELECT 'jobs rows', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.jobs x
$p161fp$;
CREATE TEMP TABLE p161_before ON COMMIT DROP AS SELECT * FROM pg_temp.p161_fingerprint();

-- ---- The one function (072's body plus the two checks; see the proposal's header) -------------------------------------------------
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

DO $p161_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b8b2a0f43fac263f8b913c2f9f1d8e9f'
                   AND p.prosrc LIKE '%job_not_released%' AND p.prosrc LIKE '%shown_revision_ahead%' AND p.prosrc LIKE '%job_release_state%') THEN
    RAISE EXCEPTION '161 self-check: public.sign_off_job_customer must be 161''s';
  END IF;
  -- Definer, pinned search_path and TimeZone, callable by signed-in users only (not anon, not PUBLIC), as 072 left it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
                   AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, security_audit, extensions', 'TimeZone=UTC'])
     OR NOT has_function_privilege('authenticated', 'public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
                  AND a.grantee = 0) THEN
    RAISE EXCEPTION '161 self-check: function security settings or grants are not as 072 left them';
  END IF;
  -- Nothing else changed: the same fingerprint (other functions, this function apart from its body, policies, triggers, rows).
  IF EXISTS (SELECT * FROM pg_temp.p161_before EXCEPT SELECT * FROM pg_temp.p161_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p161_fingerprint() EXCEPT SELECT * FROM pg_temp.p161_before) THEN
    RAISE EXCEPTION '161 self-check: another function, a grant, a policy, a trigger, a sign-off or a job changed';
  END IF;
END
$p161_self_check$;
DROP TABLE pg_temp.p161_before;
DROP FUNCTION pg_temp.p161_fingerprint();
COMMIT;
