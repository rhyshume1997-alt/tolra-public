-- 072_customer_signoff.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 072: customer sign-off on a job (Marpet Fabrications, owner Jason: "customers sign off the job on site").
--
-- A fitter at the customer's site hands the customer their phone; the customer prints their name (optionally their position and
-- company), reads the statement shown above the box, signs (drawn, or typed as the fallback) and may add a comment. The fitter is
-- signed in as themselves (own Tolra login), so the record says who captured it. It extends the operator sign-off of 045:
--
--  * public.job_signoffs takes a third kind, 'customer' (045: 'primary', 'inspector'). The customer's details live in new columns that
--    only a customer row has (signer_position, signer_company, statement, customer_comment, device_signed_at, shown_worksheet_version,
--    shown_snapshot_sha256); a CHECK keeps them NULL on every other kind, so 045's rows and sign_off_job are unchanged. signed_by is,
--    for a customer row, the member who captured it (the fitter). Everything else of 045 holds as it is: the immutability trigger
--    (never changed or removed, also by definer code and the service role), no API write grant, same-company SELECT for every role,
--    same-org parent check, support read-only and admin second-step statement triggers, row audit.
--  * public.sign_off_job_customer records one. Organisation and capturer come from the session; admin, office and workshop capture (on
--    any job of their company: workshop sees every company job), a viewer is refused (42501), another company's job is not found
--    (P0002). It needs the company setting (below) on: 42501, hint customer_signoff_off.
--  * What the customer signs is the job, not the internal worksheet revision, and a customer's signature can't be fetched again once
--    the fitter has left site. So, unlike 045, a worksheet edited between capture and upload does NOT refuse it: the row is bound (as
--    every sign-off row is) to the revision current at upload, with that revision's snapshot and hash, and also keeps the revision and
--    snapshot hash the fitter's screen showed (shown_worksheet_version / shown_snapshot_sha256, NULL when the device had none). The app
--    says when the two differ. No finished job and no operator sign-off are needed first.
--  * Time: created_at is the server's time when it arrived (upload, so "server time on sync"); device_signed_at is the phone's clock
--    when the customer signed, recorded as given (milliseconds). signed_on is the UK date of the earlier of the two, so a phone clock
--    ahead never makes a future date. The phone's time must be finite and within 30 days before to 1 day after the upload (the server's
--    now()): 30 days covers a phone kept offline far longer than the 12-hour offline limit (docs/OFFLINE.md), 1 day covers a phone
--    clock a little ahead or in another time zone; anything else (a clock reset to 1970 or 2099, +/-infinity) is refused, 22023 hint
--    device_time_out_of_range, and the signature stays on the phone (held, with the message) to set the clock and capture again. The
--    table repeats it against created_at (CHECK job_signoffs_device_time_window: immutable, so a restore of old rows still passes). A
--    replay of a recorded key is answered before this check, so a late retry of an upload that was recorded still gets its answer.
--  * Device claims, kept as such: the statement text is sent by the app (the wording shown above the box, CUSTOMER_SIGNOFF_STATEMENT
--    in lib/job-signoff.ts) and stored as given, so the record keeps what the customer was shown even if the wording later changes;
--    shown_worksheet_version / shown_snapshot_sha256 are what the phone says it showed, not checked against the server (the row's own
--    worksheet_version, snapshot and snapshot_sha256 are the server's).
--  * Personal data (UK GDPR): the customer's name, initials, position, company, signature and comment are personal data, held for the
--    company that captured them (the controller: JNR, owner John; Marpet, owner Jason). The row change is copied into the append-only
--    security_audit.audit_log by 045's audit trigger. Retention, the audit anonymiser keys and the erasure procedure for an immutable
--    sign-off row: docs/DATA-RETENTION.md ("Customer sign-offs").
--  * Initials (045's column, required) are taken from the printed name the way lib/job-signoff.ts initialsFrom does (first letter of
--    each word, accents removed, A to Z only, at most 4), or 'C' when the name has no such letter.
--  * One customer sign-off per revision (045's UNIQUE (job_id, worksheet_version, kind)): a second is refused 23505, hint
--    already_signed. Offline (the existing outbox): p_client_op_id is required; a replay of the key by the same capturer with the same
--    content returns the first answer (replayed = true) and adds nothing, whatever changed since (even the setting); the key with
--    other content, another job or another capturer is refused (22023, hint client_op_reused).
--  * record_sha256 covers 045's fields plus every customer field and the capturer (keep in step with recordSha256 in
--    lib/job-signoff.ts). JOB_CUSTOMER_SIGN_OFF is written to the audit log.
--  * The company setting organization_settings.customer_signoff_enabled (default FALSE: no company's screens change on apply, and no
--    company is switched on by this file). Only an admin changes it: set_customer_signoff_enabled (second step, audited), and a trigger
--    refuses anyone else writing it through the API (the 058 rule for auto_convert_sales_orders, in its own trigger so 058's
--    organization_settings_guard_nav is not replaced). As with 058, an admin updating the column directly (the guard lets an admin
--    through) is not written as a named audit event; the RPC is the audited route and the one the app uses.
--
-- Forward only, safe to run more than once. Writes no business rows.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The company setting.
ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS customer_signoff_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.organization_settings_customer_signoff_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Through the API (a signed-in person) only an admin changes it; the owner and the service role are not API callers.
  IF auth.uid() IS NOT NULL
     AND NEW.customer_signoff_enabled IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.customer_signoff_enabled ELSE FALSE END)
     AND NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can turn customer sign-off on jobs on or off' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.organization_settings_customer_signoff_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS organization_settings_customer_signoff_guard ON public.organization_settings;
CREATE TRIGGER organization_settings_customer_signoff_guard BEFORE INSERT OR UPDATE ON public.organization_settings
  FOR EACH ROW EXECUTE FUNCTION public.organization_settings_customer_signoff_guard();

CREATE OR REPLACE FUNCTION public.set_customer_signoff_enabled(p_on BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_before BOOLEAN;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can turn customer sign-off on jobs on or off' USING ERRCODE = '42501';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Choose on or off.' USING ERRCODE = '22023';
  END IF;
  SELECT s.customer_signoff_enabled INTO v_before FROM public.organization_settings s WHERE s.organization_id = v_org FOR UPDATE;
  INSERT INTO public.organization_settings AS s (organization_id, customer_signoff_enabled) VALUES (v_org, p_on)
  ON CONFLICT (organization_id) DO UPDATE SET customer_signoff_enabled = EXCLUDED.customer_signoff_enabled;
  IF v_before IS DISTINCT FROM p_on THEN
    PERFORM security_audit.log_named_event(v_org, 'UPDATE', 'organization_settings', v_org::TEXT,
      jsonb_build_object('section', 'jobs', 'customer_signoff_enabled', p_on, 'previous', coalesce(v_before, FALSE)));
  END IF;
  RETURN p_on;
END
$$;
REVOKE ALL ON FUNCTION public.set_customer_signoff_enabled(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_signoff_enabled(BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 2. The record: a third kind and the customer's columns (NULL on every other kind).
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS signer_position TEXT;
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS signer_company TEXT;
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS statement TEXT;
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS customer_comment TEXT;
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS device_signed_at TIMESTAMPTZ;
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS shown_worksheet_version INTEGER;
ALTER TABLE public.job_signoffs ADD COLUMN IF NOT EXISTS shown_snapshot_sha256 TEXT;

ALTER TABLE public.job_signoffs DROP CONSTRAINT IF EXISTS job_signoffs_kind_check;
ALTER TABLE public.job_signoffs ADD CONSTRAINT job_signoffs_kind_check CHECK (kind IN ('primary', 'inspector', 'customer'));
ALTER TABLE public.job_signoffs DROP CONSTRAINT IF EXISTS job_signoffs_customer_shape;
ALTER TABLE public.job_signoffs ADD CONSTRAINT job_signoffs_customer_shape CHECK (
  (kind = 'customer'
    AND statement IS NOT NULL AND length(btrim(statement)) BETWEEN 1 AND 500 AND statement !~ '[[:cntrl:]]'
    AND device_signed_at IS NOT NULL AND isfinite(device_signed_at)
    AND (signer_position IS NULL OR (length(btrim(signer_position)) BETWEEN 1 AND 120 AND signer_position !~ '[[:cntrl:]]'))
    AND (signer_company IS NULL OR (length(btrim(signer_company)) BETWEEN 1 AND 200 AND signer_company !~ '[[:cntrl:]]'))
    AND (customer_comment IS NULL OR (length(btrim(customer_comment)) BETWEEN 1 AND 1000 AND regexp_replace(customer_comment, '[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'))
    AND (shown_worksheet_version IS NULL OR shown_worksheet_version >= 0)
    AND (shown_snapshot_sha256 IS NULL OR shown_snapshot_sha256 ~ '^[0-9a-f]{64}$'))
  OR (kind <> 'customer'
    AND signer_position IS NULL AND signer_company IS NULL AND statement IS NULL AND customer_comment IS NULL
    AND device_signed_at IS NULL AND shown_worksheet_version IS NULL AND shown_snapshot_sha256 IS NULL));

-- The phone's time within 30 days before to 1 day after the row arrived (see the header); NULL on every other kind.
ALTER TABLE public.job_signoffs DROP CONSTRAINT IF EXISTS job_signoffs_device_time_window;
ALTER TABLE public.job_signoffs ADD CONSTRAINT job_signoffs_device_time_window CHECK (
  device_signed_at IS NULL OR (device_signed_at >= created_at - INTERVAL '30 days' AND device_signed_at <= created_at + INTERVAL '1 day'));

-- -----------------------------------------------------------------------------------------------------
-- 3. Recording a customer's sign-off. Returns { id, worksheet_version, kind, snapshot_sha256, record_sha256, replayed }.
-- Refusals for the person (shown as they are by the app): bad input 22023; the phone's time outside the window 22023 (hint
-- device_time_out_of_range); the setting off 42501 (hint customer_signoff_off); a second
-- customer sign-off on the revision 23505 (hint already_signed); a key already used for other content 22023 (hint client_op_reused).
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
