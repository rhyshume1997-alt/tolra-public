-- 033_prelaunch_hardening.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 033: pre-go-live hardening (external audits, October 2026). One migration for every database change in the batch.
--
-- 1. Storage follows the session check. 017 left the Storage API out of the revoked-session check, so a signed-out or
--    revoked token still read and wrote files until it expired. One RESTRICTIVE policy on storage.objects now requires
--    public.session_is_active() for every signed-in request, for every bucket (today and any added later). Anonymous
--    requests were already refused by the per-bucket policies (they need a company id).
-- 2. Invoices, quotes and purchase orders can only be CREATED as drafts through the API. 027 checked the totals when a
--    status changed, but an admin could still insert an invoice that was already 'issued' (or a quote 'sent') and skip
--    the issue step. API users (anon, authenticated) now get a draft or a refusal. The database owner, the importer and
--    the service role are exempt, as for the other locks.
-- 3. convert_sales_order (018): the quote-derived job number (QUO-1393 -> J-1393) is allocated under a per-company lock,
--    so two orders converting from one quote at the same time can't both take it (the second takes the next J number).
-- 4. Job e-mail ledger (025) gets the outcome states of the mailbox ledger (031): sending, accepted, unknown, failed,
--    confirmed_sent, drafted. A definite refusal by the provider is 'failed' (retry allowed); a network error, a timeout
--    or a 5xx is 'unknown' and is never retried automatically: an admin settles it with resolve_job_email.
--    A reservation still 'sending' after 10 minutes is treated as 'unknown'. Each retry of a failed send is a new ledger row
--    (attempt 2, 3 and so on, linked to the first attempt): every attempt is kept and each one counts against the limits.
-- 5. Optional admin MFA at database level: organizations.require_admin_mfa (off by default). When on, an admin whose token
--    is not aal2 is refused in EVERY privileged database operation, even by calling the REST API or an RPC directly:
--    public.assert_privileged_aal() is the first statement of each privileged function (payments recorded, reversed and
--    confirmed, invoices issued, orders converted, members and roles, mail send and settle, inbound mail, job e-mails) and
--    a statement trigger on every table those functions and the screens write (invoices and lines, payments, quotes and lines,
--    purchase and sales orders, settings, members, profiles, organisations, e-mail history and ledgers). The app enforces the
--    same in its API guard and pages (REQUIRE_ADMIN_MFA). The audit trail also accepts a new RESET_MFA event.
-- 6. invoices.tax_point: an optional supply date for the invoice, set on the draft (issued invoices are locked).
-- 7. claim_error_alert(): the budget for production error e-mails (one per fingerprint per hour, 20 a day).
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. Storage: revoked sessions ----------------------------------------------------------------------
DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '033: storage schema not found, skipping the Storage session check';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS "storage requires active session" ON storage.objects;
  CREATE POLICY "storage requires active session" ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT public.session_is_active())) WITH CHECK ((SELECT public.session_is_active()));
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. New invoices, quotes and purchase orders start as drafts -----------------------------------------
-- Only anon / authenticated are held to this (not service_role): the importer and the test fixtures create finished
-- records as the owner or service role.
CREATE OR REPLACE FUNCTION public.documents_start_as_drafts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_bad TEXT[];
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF coalesce(v_row ->> 'status', 'draft') <> 'draft' THEN
    v_bad := array_append(v_bad, 'status');
  END IF;
  -- What only the issue / send / accept / payment steps set.
  IF TG_TABLE_NAME = 'invoices' THEN
    IF v_row ->> 'invoice_ref' IS NOT NULL THEN v_bad := array_append(v_bad, 'invoice_ref'); END IF;
    IF v_row ->> 'sent_date' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_date'); END IF;
    IF v_row ->> 'paid_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'paid_at'); END IF;
    IF coalesce((v_row ->> 'amount_paid')::NUMERIC, 0) <> 0 THEN v_bad := array_append(v_bad, 'amount_paid'); END IF;
  ELSIF TG_TABLE_NAME = 'quotes' THEN
    IF v_row ->> 'sent_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_at'); END IF;
    IF v_row ->> 'accepted_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'accepted_at'); END IF;
    IF v_row ->> 'rejected_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'rejected_at'); END IF;
  ELSE
    IF v_row ->> 'sent_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_at'); END IF;
    IF v_row ->> 'received_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'received_at'); END IF;
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'A new % must be saved as a draft and then issued (not set: %).', replace(TG_TABLE_NAME, '_', ' '), array_to_string(v_bad, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS invoices_start_as_drafts ON public.invoices;
CREATE TRIGGER invoices_start_as_drafts BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.documents_start_as_drafts();
DROP TRIGGER IF EXISTS quotes_start_as_drafts ON public.quotes;
CREATE TRIGGER quotes_start_as_drafts BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.documents_start_as_drafts();
DROP TRIGGER IF EXISTS purchase_orders_start_as_drafts ON public.purchase_orders;
CREATE TRIGGER purchase_orders_start_as_drafts BEFORE INSERT ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.documents_start_as_drafts();

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Quote-derived job numbers under a lock -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_sales_order(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job     public.jobs%ROWTYPE;
  v_quote   TEXT;
  v_job_no  TEXT;
  v_num     TEXT;
  v_lines   TEXT;
  v_count   INT;
  v_qty     NUMERIC;
  v_spec    TEXT;
  v_now     TIMESTAMPTZ := now();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can convert sales orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already converted (either side of the link): hand back that job, change nothing.
  SELECT j.* INTO v_job FROM public.jobs j
  WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = p_order)
  ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1;
  IF FOUND THEN
    IF v_order.converted_to_job_id IS DISTINCT FROM v_job.id THEN
      UPDATE public.sales_orders SET converted_to_job_id = v_job.id, converted_at = coalesce(converted_at, v_now) WHERE id = p_order;
    END IF;
    RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', FALSE);
  END IF;

  -- Job number: the quote's number when free, otherwise the next J number. The row lock above only serialises calls for
  -- ONE order; two orders for the same quote would both find J-1393 free. One lock per company, held to the end of this
  -- transaction, makes the "is it free" check and the insert a single step.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  v_quote := v_order.quote_ref;
  IF coalesce(v_quote, '') = '' AND v_order.quote_id IS NOT NULL THEN
    SELECT q.quote_ref INTO v_quote FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
  END IF;
  v_num := substring(coalesce(v_quote, '') FROM '^\s*[Qq][Uu][Oo][-\s]?(\d+)\s*$');
  IF v_num IS NOT NULL THEN
    v_job_no := 'J-' || CASE WHEN length(ltrim(v_num, '0')) < 4 THEN lpad(coalesce(nullif(ltrim(v_num, '0'), ''), '0'), 4, '0') ELSE ltrim(v_num, '0') END;
    IF EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = v_org AND job_no = v_job_no) THEN
      v_job_no := NULL;
    END IF;
  END IF;
  IF v_job_no IS NULL THEN
    v_job_no := public.next_doc_number('J');
  END IF;

  -- What the workshop needs from the quote: descriptions and quantities, never prices.
  IF v_order.quote_id IS NOT NULL THEN
    SELECT string_agg('- ' || btrim(l.description) || ' x ' || trim_scale(l.quantity)::TEXT, E'\n' ORDER BY l.position, l.id),
           count(*), max(l.quantity)
      INTO v_lines, v_count, v_qty
    FROM public.quote_line_items l
    WHERE l.quote_id = v_order.quote_id AND l.organization_id = v_org;
  END IF;
  v_spec := 'Sales order ' || v_order.so_number
    || CASE WHEN v_order.delivery_date IS NOT NULL THEN '; customer delivery required ' || to_char(v_order.delivery_date, 'DD/MM/YYYY') ELSE '' END
    || '.'
    || CASE WHEN v_lines IS NOT NULL THEN E'\n' || coalesce(v_quote, 'Quote') || E':\n' || v_lines ELSE '' END;

  INSERT INTO public.jobs (
    organization_id, job_no, quote_id, customer, description, stage, due_date, status, specification, drawings,
    customer_po, quote_ref, date_received, date_required, quantity_required, converted_from_sales_order_id, converted_at)
  VALUES (
    v_org, v_job_no, v_order.quote_id, v_order.customer, 'Converted from ' || v_order.so_number, 'material',
    v_order.delivery_date, 'on_track', v_spec, '[]'::JSONB,
    v_order.so_number, nullif(v_quote, ''), v_order.order_date, v_order.delivery_date,
    CASE WHEN v_count = 1 AND v_qty >= 1 AND v_qty = trunc(v_qty) THEN v_qty::INT END,
    p_order, v_now)
  RETURNING * INTO v_job;

  INSERT INTO public.job_values (job_id, organization_id, value) VALUES (v_job.id, v_org, coalesce(v_order.total_value, 0));

  UPDATE public.sales_orders SET status = 'converted', converted_to_job_id = v_job.id, converted_at = v_now WHERE id = p_order;

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Optional admin MFA (read by the triggers and functions below) -------------------------------------
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS require_admin_mfa BOOLEAN NOT NULL DEFAULT FALSE;

-- TRUE unless the caller is an admin of a company that requires MFA and the token is not aal2 (a second factor was not
-- used for this sign-in). Service role and the database owner (no company) always pass.
CREATE OR REPLACE FUNCTION public.mfa_ok()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT coalesce((SELECT o.require_admin_mfa FROM public.organizations o WHERE o.id = public.current_user_organization_id()), FALSE)
      OR NOT public.has_org_role(ARRAY['admin'])
      OR coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;
REVOKE ALL ON FUNCTION public.mfa_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_ok() TO authenticated;

-- The one check every privileged database operation makes. Raises when the caller is an admin of a company that requires the
-- second step and the token is not aal2. Called at the top of the privileged functions (injected below) and by the table
-- trigger, so a direct call to the REST API or an RPC at aal1 is refused whichever way it reaches the data.
CREATE OR REPLACE FUNCTION public.assert_privileged_aal()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() AND NOT public.mfa_ok() THEN
    RAISE EXCEPTION 'Confirm your authenticator code first (second step of sign-in).' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.assert_privileged_aal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_privileged_aal() TO authenticated;

CREATE OR REPLACE FUNCTION public.require_admin_mfa_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_privileged_aal();
  RETURN NULL;
END
$$;

-- Every write (insert, update, delete: once per statement, so even one that matches no row is refused) to what an admin
-- does with money, documents, settings, people and mail needs the second step when the company requires it. Replaces the
-- three narrower triggers this migration used to create.
DROP TRIGGER IF EXISTS invoice_payments_reversal_admin_mfa ON public.invoice_payments;
DROP TRIGGER IF EXISTS mail_send_ledger_resolve_admin_mfa ON security_audit.mail_send_ledger;
DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.invoices', 'public.invoice_line_items', 'public.invoice_payments', 'public.quotes', 'public.quote_line_items',
    'public.purchase_orders', 'public.sales_orders', 'public.organization_settings', 'public.organization_members',
    'public.user_profiles', 'public.organizations', 'public.email_history', 'public.inbound_emails', 'public.mail_poll_state',
    'security_audit.email_send_ledger', 'security_audit.mail_send_ledger']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON %s', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$do$;
DROP TRIGGER IF EXISTS organization_settings_admin_mfa ON public.organization_settings;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Job e-mail ledger: outcomes ----------------------------------------------------------------------
-- status: sending (reserved), drafted (no provider configured: only saved), accepted (the provider answered OK),
-- failed (the provider definitely refused: nothing was sent), unknown (no answer we can trust: a network error, a timeout
-- or a server error, so it may have been sent), confirmed_sent (an admin checked and it went).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'security_audit' AND table_name = 'email_send_ledger' AND column_name = 'status') THEN
    ALTER TABLE security_audit.email_send_ledger ADD COLUMN status TEXT NOT NULL DEFAULT 'sending';
    ALTER TABLE security_audit.email_send_ledger ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    -- Existing attempts: what the visible history says; a send with no trace, or still 'sending', is treated as unknown.
    UPDATE security_audit.email_send_ledger l
    SET status = CASE h.status
                   WHEN 'sent_via_system' THEN 'accepted'
                   WHEN 'drafted' THEN 'drafted'
                   WHEN 'failed' THEN 'failed'
                   ELSE 'unknown' END,
        updated_at = l.created_at
    FROM (SELECT l2.id, (SELECT e.status FROM public.email_history e WHERE e.id = l2.history_id) AS status FROM security_audit.email_send_ledger l2) h
    WHERE h.id = l.id;
  END IF;
END
$do$;
-- Retries: one row per attempt. The first attempt of a request key is attempt 1 with no retry_of; a retry after a definite
-- refusal is a new row with the same key and history, the next attempt number and retry_of = the first attempt. The earlier
-- rows keep their outcome and their date, and every row counts against the limits of the hour and the day it was made.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'security_audit' AND table_name = 'email_send_ledger' AND column_name = 'attempt') THEN
    ALTER TABLE security_audit.email_send_ledger ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE security_audit.email_send_ledger ADD COLUMN retry_of UUID REFERENCES security_audit.email_send_ledger(id) ON DELETE CASCADE;
  END IF;
END
$do$;
ALTER TABLE security_audit.email_send_ledger DROP CONSTRAINT IF EXISTS email_send_ledger_organization_id_user_id_idempotency_key_key;
ALTER TABLE security_audit.email_send_ledger DROP CONSTRAINT IF EXISTS email_send_ledger_attempt_check;
ALTER TABLE security_audit.email_send_ledger ADD CONSTRAINT email_send_ledger_attempt_check
  CHECK (attempt >= 1 AND (attempt = 1) = (retry_of IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS email_send_ledger_key_attempt
  ON security_audit.email_send_ledger (organization_id, user_id, idempotency_key, attempt);
CREATE INDEX IF NOT EXISTS email_send_ledger_history ON security_audit.email_send_ledger (history_id, attempt);

-- 025 made the ledger append-only for every API request. The outcome now has to be recorded: an UPDATE of status and
-- updated_at alone is allowed from inside the definer functions above (current_user is their owner); the API roles
-- themselves have no privileges on the table, and nothing else about a row can change (a retry is a new row, never an edit).
CREATE OR REPLACE FUNCTION security_audit.email_send_ledger_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() THEN
    IF TG_OP = 'UPDATE' AND current_user NOT IN ('anon', 'authenticated', 'service_role')
       AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'email send ledger is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

ALTER TABLE security_audit.email_send_ledger DROP CONSTRAINT IF EXISTS email_send_ledger_status_check;
ALTER TABLE security_audit.email_send_ledger ADD CONSTRAINT email_send_ledger_status_check
  CHECK (status IN ('sending', 'drafted', 'accepted', 'unknown', 'failed', 'confirmed_sent'));

-- The e-mail history can show the same word.
DO $do$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.email_history'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\mstatus\M'
      AND pg_get_constraintdef(oid) !~ '\mrelated_to_type\M'
  LOOP
    EXECUTE format('ALTER TABLE public.email_history DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.email_history ADD CONSTRAINT email_history_status_check
    CHECK (status IN ('drafted', 'copied', 'sent_manually', 'sent_via_system', 'sending', 'failed', 'unknown'));
END
$do$;

-- Stale 'sending' reservations of this company become 'unknown' (mail_send_stale_after is the 10 minutes of 031).
CREATE OR REPLACE FUNCTION public.expire_stale_job_emails()
RETURNS INTEGER
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH expired AS (
    UPDATE security_audit.email_send_ledger SET status = 'unknown', updated_at = now()
    WHERE organization_id = public.current_user_organization_id() AND status = 'sending' AND updated_at < now() - public.mail_send_stale_after()
    RETURNING history_id),
  marked AS (
    UPDATE public.email_history SET status = 'unknown'
    WHERE id IN (SELECT history_id FROM expired) AND status = 'sending'
    RETURNING 1)
  SELECT count(*)::INTEGER FROM expired
$$;
REVOKE ALL ON FUNCTION public.expire_stale_job_emails() FROM PUBLIC, anon, authenticated;

-- p_mode: 'sending' (the provider is configured) or 'drafted' (it isn't; the e-mail is only saved).
-- Returns { history_id, replay, status } where status is the history's status. The same key again never makes a second
-- attempt, except after a definite refusal ('failed'), which may be sent again under the same key (the provider
-- de-duplicates by key). Each retry is a new ledger row and is charged against the limits like any new send, so repeated
-- failed retries use up the allowance. An unknown outcome is NOT retried: it stays 'unknown' until an admin settles it.
CREATE OR REPLACE FUNCTION public.reserve_job_email(p_job UUID, p_recipient TEXT, p_subject TEXT, p_body TEXT,
                                                    p_key TEXT, p_mode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_prior   security_audit.email_send_ledger;
  v_status  TEXT;
  v_history UUID;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('sending', 'drafted') THEN
    RAISE EXCEPTION 'Unknown send mode' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job AND organization_id = v_org) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- One reservation at a time per company, so two requests can't both take the last place.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-email:' || v_org::TEXT, 0));
  PERFORM public.expire_stale_job_emails();

  -- The latest attempt under this key decides.
  SELECT * INTO v_prior FROM security_audit.email_send_ledger
  WHERE organization_id = v_org AND user_id = v_user AND idempotency_key = p_key
  ORDER BY attempt DESC LIMIT 1;
  IF FOUND THEN
    IF v_prior.job_id <> p_job OR v_prior.recipient <> p_recipient THEN
      RAISE EXCEPTION 'This request key was already used for a different e-mail' USING ERRCODE = 'PT409';
    END IF;
    -- A definite refusal may be tried again under the same key, but the retry is a new send: it is checked against the
    -- limits under the lock taken above like any new send, and recorded as its own row (the next attempt, linked to the
    -- first). The earlier attempts stay as they were and keep counting, so each retry uses an allowance and repeated
    -- failed retries are refused once the hour's or the day's is used.
    IF v_prior.status = 'failed' AND p_mode = 'sending' THEN
      IF (SELECT count(*) FROM security_audit.email_send_ledger
          WHERE user_id = v_user AND created_at > now() - INTERVAL '1 hour') >= 10 THEN
        RAISE EXCEPTION 'Rate limit exceeded. Max 10 emails per hour.' USING ERRCODE = 'PT429', HINT = 'user';
      END IF;
      IF (SELECT count(*) FROM security_audit.email_send_ledger
          WHERE organization_id = v_org AND created_at > now() - INTERVAL '1 day') >= 100 THEN
        RAISE EXCEPTION 'Daily email limit reached for your organisation.' USING ERRCODE = 'PT429', HINT = 'organization';
      END IF;
      INSERT INTO security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id, status, attempt, retry_of)
      VALUES (v_org, v_user, v_prior.job_id, v_prior.recipient, p_key, v_prior.history_id, 'sending', v_prior.attempt + 1, coalesce(v_prior.retry_of, v_prior.id));
      UPDATE public.email_history SET status = 'sending' WHERE id = v_prior.history_id;
      RETURN jsonb_build_object('history_id', v_prior.history_id, 'replay', FALSE, 'status', 'sending');
    END IF;
    SELECT status INTO v_status FROM public.email_history WHERE id = v_prior.history_id;
    RETURN jsonb_build_object('history_id', v_prior.history_id, 'replay', TRUE,
      'status', CASE WHEN v_prior.status = 'unknown' THEN 'unknown' WHEN v_prior.status = 'confirmed_sent' THEN 'sent_via_system' ELSE coalesce(v_status, 'unknown') END);
  END IF;

  IF (SELECT count(*) FROM security_audit.email_send_ledger
      WHERE user_id = v_user AND created_at > now() - INTERVAL '1 hour') >= 10 THEN
    RAISE EXCEPTION 'Rate limit exceeded. Max 10 emails per hour.' USING ERRCODE = 'PT429', HINT = 'user';
  END IF;
  IF (SELECT count(*) FROM security_audit.email_send_ledger
      WHERE organization_id = v_org AND created_at > now() - INTERVAL '1 day') >= 100 THEN
    RAISE EXCEPTION 'Daily email limit reached for your organisation.' USING ERRCODE = 'PT429', HINT = 'organization';
  END IF;

  INSERT INTO public.email_history (organization_id, to_email, subject, body, related_to_type, related_to_id, drafted_by, status)
  VALUES (v_org, p_recipient, p_subject, p_body, 'job', p_job::TEXT, v_user, p_mode)
  RETURNING id INTO v_history;
  INSERT INTO security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id, status)
  VALUES (v_org, v_user, p_job, p_recipient, p_key, v_history, p_mode);
  RETURN jsonb_build_object('history_id', v_history, 'replay', FALSE, 'status', p_mode);
END
$$;
REVOKE ALL ON FUNCTION public.reserve_job_email(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_job_email(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Records the outcome of a reserved send: accepted (history becomes sent_via_system), failed, or unknown (history
-- 'unknown'). Only the person who reserved it, while it is still 'sending'.
CREATE OR REPLACE FUNCTION public.complete_job_email(p_history UUID, p_outcome TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row security_audit.email_send_ledger;
BEGIN
  IF p_outcome NOT IN ('accepted', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'Unknown outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM security_audit.email_send_ledger
  WHERE history_id = p_history AND organization_id = public.current_user_organization_id() AND user_id = auth.uid() AND status = 'sending'
  ORDER BY attempt DESC LIMIT 1
  FOR UPDATE;
  IF NOT FOUND OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  UPDATE security_audit.email_send_ledger SET status = p_outcome, updated_at = now() WHERE id = v_row.id;
  UPDATE public.email_history
  SET status = CASE p_outcome WHEN 'accepted' THEN 'sent_via_system' ELSE p_outcome END,
      sent_at = CASE WHEN p_outcome = 'accepted' THEN now() ELSE sent_at END
  WHERE id = p_history;
END
$$;
REVOKE ALL ON FUNCTION public.complete_job_email(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_job_email(UUID, TEXT) TO authenticated;

-- An admin who checked (the provider's log, or with the customer) settles an 'unknown' send: it went ('sent') or it did
-- not ('failed', so it may be sent again). A fresh 'sending' reservation can't be settled. Returns the history id.
CREATE OR REPLACE FUNCTION public.resolve_job_email(p_history UUID, p_as TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_row security_audit.email_send_ledger;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_as NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'Unknown resolution' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job-email:' || v_org::TEXT, 0));
  PERFORM public.expire_stale_job_emails();
  -- The latest attempt is the one to settle (earlier attempts of a retried send are already 'failed').
  SELECT * INTO v_row FROM security_audit.email_send_ledger WHERE history_id = p_history AND organization_id = v_org
  ORDER BY attempt DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Send not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'unknown' THEN
    RAISE EXCEPTION 'Only an unknown outcome can be resolved' USING ERRCODE = 'PT409';
  END IF;
  UPDATE security_audit.email_send_ledger SET status = CASE p_as WHEN 'sent' THEN 'confirmed_sent' ELSE 'failed' END, updated_at = now() WHERE id = v_row.id;
  UPDATE public.email_history SET status = CASE p_as WHEN 'sent' THEN 'sent_via_system' ELSE 'failed' END,
                                  sent_at = CASE p_as WHEN 'sent' THEN now() ELSE sent_at END
  WHERE id = p_history;
  RETURN p_history;
END
$$;
REVOKE ALL ON FUNCTION public.resolve_job_email(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_job_email(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- RESET_MFA: another admin resetting a colleague's two-step sign-in is recorded like the other user-management events
-- (audit_event_allowed, 023, with one more action; nothing else about it changes).
CREATE OR REPLACE FUNCTION public.audit_event_allowed(p_action TEXT, p_table TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_read  TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin'] WHEN 'sales_orders' THEN ARRAY['admin']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop', 'viewer'] WHEN 'machines' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
  v_write TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'machines' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin'] WHEN 'sales_orders' THEN ARRAY['admin']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop'] WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
BEGIN
  IF p_action = 'CHANGE_OWN_PASSWORD' THEN
    RETURN p_table = 'user_profiles';
  END IF;
  IF p_action IN ('CREATE_USER', 'SET_USER_PASSWORD', 'UPDATE_USERNAME', 'UPDATE_USER_ACCESS', 'DEACTIVATE_USER',
                  'REACTIVATE_USER', 'INVITE_USER', 'PASSWORD_RESET_PREPARED', 'RESET_MFA') THEN
    RETURN p_table = 'user_profiles' AND public.has_org_role(ARRAY['admin']);
  END IF;
  IF p_action IN ('EXPORT', 'PRINT_PACK', 'DOWNLOAD_PDF', 'DOWNLOAD_ATTACHMENT', 'EMAIL_COPIED') THEN
    RETURN v_read IS NOT NULL AND public.has_org_role(v_read);
  END IF;
  IF p_action IN ('CREATE', 'UPDATE', 'DELETE', 'SEND', 'DESPATCH', 'ACCEPT', 'REJECT', 'UPDATE_WORKSHEET',
                  'UPLOAD_DRAWING', 'CONVERT_TO_JOB', 'SEND_TO_WORKSHOP', 'MARK_RECEIVED', 'MARK_PAID', 'MARK_SIGNED',
                  'UPLOAD_ATTACHMENT', 'EMAIL_SENT_MANUALLY', 'DRAFT_CHASERS', 'CREATE_SUPPLIER', 'DELETE_SUPPLIER',
                  'ORGANIZATION_SETTINGS_UPDATE') THEN
    RETURN v_write IS NOT NULL AND public.has_org_role(v_write);
  END IF;
  RETURN FALSE;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. Error alert budget -----------------------------------------------------------------------------
-- The app e-mails the owner when something breaks in production (lib/server/error-alert.ts). So that a bug that fails a
-- thousand times sends one e-mail, not a thousand: at most one e-mail per error fingerprint per hour and 20 a day, counted
-- here because serverless instances don't share memory. Holds only a fingerprint (a hash of the route and the redacted
-- message) and a time: no message, no personal data. Only the service role can call it.
CREATE TABLE IF NOT EXISTS security_audit.error_alerts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{12,64}$'),
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_alerts_fingerprint_time ON security_audit.error_alerts (fingerprint, claimed_at DESC);
CREATE INDEX IF NOT EXISTS error_alerts_time ON security_audit.error_alerts (claimed_at DESC);
REVOKE ALL ON security_audit.error_alerts FROM PUBLIC, anon, authenticated, service_role;

-- TRUE when an e-mail for this fingerprint may be sent now (and records it); FALSE when this fingerprint was already sent in
-- the last hour or 20 e-mails have gone in the last 24 hours.
CREATE OR REPLACE FUNCTION public.claim_error_alert(p_fingerprint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{12,64}$' THEN
    RAISE EXCEPTION 'Invalid fingerprint' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('error-alert', 0));
  DELETE FROM security_audit.error_alerts WHERE claimed_at < now() - INTERVAL '2 days';
  IF EXISTS (SELECT 1 FROM security_audit.error_alerts WHERE fingerprint = p_fingerprint AND claimed_at > now() - INTERVAL '1 hour') THEN
    RETURN FALSE;
  END IF;
  IF (SELECT count(*) FROM security_audit.error_alerts WHERE claimed_at > now() - INTERVAL '1 day') >= 20 THEN
    RETURN FALSE;
  END IF;
  INSERT INTO security_audit.error_alerts (fingerprint) VALUES (p_fingerprint);
  RETURN TRUE;
END
$$;
REVOKE ALL ON FUNCTION public.claim_error_alert(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_error_alert(TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- ---- 8. The second-step check at the top of every privileged function ------------------------------------
-- Adds `PERFORM public.assert_privileged_aal();` as the first statement of each function below, keeping its signature,
-- owner, settings and grants (CREATE OR REPLACE). Done from the live definitions so nothing is copied by hand. A function
-- already carrying the call is left as it is, so this is safe to run again. If a body has no plain BEGIN line to anchor on,
-- or a function is missing, the migration stops.
-- CRLF bodies (pasted into the SQL editor) are accepted: the anchor takes an optional CR and the body keeps its own line ending.
DO $do$
DECLARE
  f     TEXT;
  v_oid OID;
  v_def TEXT;
  v_new TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.record_invoice_payment(uuid,numeric,date,text,text,uuid)',
    'public.reverse_invoice_payment(uuid,text)',
    'public.confirm_invoice_payments(uuid,text)',
    'public.issue_invoice(uuid)',
    'public.convert_sales_order(uuid)',
    'public.set_member_access(uuid,text,boolean,text,boolean,text[])',
    'public.reserve_mail_send(text,text,text[],text,text,uuid)',
    'public.complete_mail_send(uuid,text)',
    'public.resolve_mail_send(uuid,text)',
    'public.save_mail_poll_state(text,timestamptz)',
    'public.record_inbound_email(text,text,text,text,text,timestamptz,text,text)',
    'public.reserve_job_email(uuid,text,text,text,text,text)',
    'public.complete_job_email(uuid,text)',
    'public.resolve_job_email(uuid,text)']
  LOOP
    v_oid := to_regprocedure(f);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '033: function % not found', f;
    END IF;
    v_def := pg_get_functiondef(v_oid);
    CONTINUE WHEN position('assert_privileged_aal' IN v_def) > 0;
    v_new := regexp_replace(v_def, E'\nBEGIN(\\r?)\n', E'\nBEGIN\\1\n  PERFORM public.assert_privileged_aal();\\1\n');
    IF v_new = v_def THEN
      RAISE EXCEPTION '033: no BEGIN line to anchor the second-step check in %', f;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Invoice tax point ---------------------------------------------------------------------------------
-- The date of supply when it differs from the invoice date. Optional. Set on the draft: an issued invoice is locked
-- (invoice_issue_lock compares every column that is not listed as open), so it can't be changed afterwards.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS tax_point DATE;

COMMIT;
