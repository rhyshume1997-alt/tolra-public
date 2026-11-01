-- =====================================================================================================
-- 106: company e-mail templates (E11: Settings > Email templates, lib/email/templates) and the per-company switch for the AI
-- pre-issue finance check (E1). Needs 033 (require_admin_mfa_guard, assert_privileged_aal), 036 (support_readonly_guard), 000/035
-- (security_audit.log_row_change) and 101 (ai_helper_settings, _ai_helper_caller, _ai_helper_audit). Touches none of 102 to 105's
-- objects. Safe to run again.
--
-- WHAT IT ADDS. Two tables, one column, six functions; no existing row, policy or grant changes, and no existing function is replaced.
--   a. public.email_templates: one row per company per template key (quote, invoice, purchase_order, delivery_note, invoice_reminder,
--      timesheet, job_to_workshop, rfq_clarify): the company's own subject and body. No row = the default text in the app
--      (lib/email/templates/defaults.ts). Read by every member of the company; written (insert, update, delete) by admin and office.
--      The subject is one line (no CR or LF, at most 200 characters); the body at most 10000 characters. updated_at and updated_by
--      are stamped by the database (email_templates_stamp), and a row never moves to another company.
--   b. public.ai_helper_settings.finance_check_enabled BOOLEAN NOT NULL DEFAULT FALSE: the company's own switch for the finance check
--      (the server switch AI_FINANCE_CHECK_ENABLED still has to be on too). Off for every company until an admin turns it on.
--   c. public.ai_helper_set_finance_check(p_enabled BOOLEAN): the admin's way to change (b), through 101's _ai_helper_caller (admin,
--      second step, no support session) and 101's ai_helper_settings_updated audit event. ai_helper_settings keeps no write grant.
--   d. (E8) security_audit.company_email_sends and reserve_company_email / complete_company_email (+ internal _company_email_caller):
--      the company mailer's send ledger, so a retried e-mail is never written or sent twice (section 5).
-- RLS: on. Policies one per command (no FOR ALL). support_read_only, admin_mfa and the row audit trigger, as 084's tables carry.
-- GUARD (section 1). SELF-CHECK (section 4). Verify: supabase/verify/email_templates_106.sql (every row TRUE).
-- Rollback: supabase/release/106_email_templates.rollback.sql (drops the tables, the column and the functions; Rhys's approval).
-- The app works with 106 not applied: the Email templates card says so, senders use the default texts, the finance check switch reads
-- as off.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists.
DO $$
BEGIN
  IF to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regclass('public.organizations') IS NULL
     OR to_regclass('public.ai_helper_settings') IS NULL OR to_regprocedure('public._ai_helper_caller(text[])') IS NULL
     OR to_regprocedure('public._ai_helper_audit(uuid,text,text,text,jsonb)') IS NULL OR to_regprocedure('public.ai_helper_status()') IS NULL
     OR to_regprocedure('public.is_api_role()') IS NULL OR to_regprocedure('public.mail_send_stale_after()') IS NULL
     OR to_regprocedure('public._session_membership()') IS NULL OR to_regclass('public.email_history') IS NULL THEN
    RAISE EXCEPTION '106: a function or table it needs (033, 036, 031, the audit log, 101) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. public.email_templates.
CREATE TABLE IF NOT EXISTS public.email_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL CONSTRAINT email_templates_key CHECK (key IN ('quote', 'invoice', 'purchase_order', 'delivery_note',
                    'invoice_reminder', 'timesheet', 'job_to_workshop', 'rfq_clarify')),
  subject         TEXT NOT NULL CONSTRAINT email_templates_subject CHECK (char_length(btrim(subject)) BETWEEN 1 AND 200 AND subject !~ '[\r\n]'),
  body            TEXT NOT NULL CONSTRAINT email_templates_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID,
  CONSTRAINT email_templates_org_key UNIQUE (organization_id, key)
);

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_templates member select" ON public.email_templates;
CREATE POLICY "email_templates member select" ON public.email_templates FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id());
DROP POLICY IF EXISTS "email_templates office insert" ON public.email_templates;
CREATE POLICY "email_templates office insert" ON public.email_templates FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "email_templates office update" ON public.email_templates;
CREATE POLICY "email_templates office update" ON public.email_templates FOR UPDATE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']))
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "email_templates office delete" ON public.email_templates;
CREATE POLICY "email_templates office delete" ON public.email_templates FOR DELETE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));

REVOKE ALL ON public.email_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_templates TO authenticated;

-- Who changed it and when come from the database, never the client; a row stays in its company.
CREATE OR REPLACE FUNCTION public.email_templates_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'An e-mail template can''t move to another company.' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.email_templates_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS email_templates_stamp ON public.email_templates;
CREATE TRIGGER email_templates_stamp BEFORE INSERT OR UPDATE ON public.email_templates FOR EACH ROW EXECUTE FUNCTION public.email_templates_stamp();
DROP TRIGGER IF EXISTS audit_email_templates_changes ON public.email_templates;
CREATE TRIGGER audit_email_templates_changes AFTER INSERT OR DELETE OR UPDATE ON public.email_templates
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.email_templates;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.email_templates FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.email_templates;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.email_templates FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. The finance check's per-company switch (off by default) and the admin's function to change it.
ALTER TABLE public.ai_helper_settings ADD COLUMN IF NOT EXISTS finance_check_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.ai_helper_set_finance_check(p_enabled BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Choose on or off.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_helper_settings AS s (organization_id, finance_check_enabled, updated_at, updated_by)
  VALUES (v_org, p_enabled, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET finance_check_enabled = EXCLUDED.finance_check_enabled, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_settings_updated', 'ai_helper_settings', v_org::TEXT,
    jsonb_build_object('finance_check_enabled', p_enabled));
  RETURN jsonb_build_object('finance_check_enabled', p_enabled);
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_set_finance_check(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_set_finance_check(BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check.
DO $$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.email_templates'::regclass) THEN
    RAISE EXCEPTION '106: row level security is off on email_templates';
  END IF;
  IF has_table_privilege('anon', 'public.email_templates', 'SELECT') OR has_table_privilege('authenticated', 'public.email_templates', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.ai_helper_settings', 'UPDATE') OR has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT') THEN
    RAISE EXCEPTION '106: a grant is wider than intended';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_templates') <> 4
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_templates' AND cmd = 'ALL') THEN
    RAISE EXCEPTION '106: email_templates policies are not the four above';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.email_templates'::regclass AND NOT t.tgisinternal
        AND t.tgname IN ('email_templates_stamp', 'audit_email_templates_changes', 'support_read_only', 'admin_mfa')) <> 4 THEN
    RAISE EXCEPTION '106: an email_templates trigger is missing';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_set_finance_check(boolean)'))
     OR has_function_privilege('anon', 'public.ai_helper_set_finance_check(boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.email_templates_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION '106: a function is not definer, pinned and signed-in only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings'
                 AND column_name = 'finance_check_enabled' AND is_nullable = 'NO' AND column_default = 'false') THEN
    RAISE EXCEPTION '106: ai_helper_settings.finance_check_enabled is not NOT NULL DEFAULT FALSE';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 5. (E8) The company mailer's send ledger (lib/email/send-company-email.ts): one row per company e-mail, keyed by a digest of
--    (company, kind, document, the caller's idempotency key), reserved BEFORE anything is sent, so a retry (double click, network
--    retry, a schedule run twice) never writes a second email_history row or sends a second time through ANY provider (Microsoft
--    Graph has no idempotency header of its own). Modelled on 031's mail_send_ledger and reserve_mail_send (same per-company advisory
--    lock, same 10-minute stale rule), but its own table: 031's ledger allows only admin mailbox sends (kinds send/reply/forward, a
--    person always set) and can't hold a draft or a scheduled send. Not reachable through the API except by the two functions.
--    Statuses: drafted (no provider: the history row is a draft for Approvals), sending, accepted, failed (may be tried again with the
--    same key), unknown (no trustworthy answer, or 'sending' for over 10 minutes: never retried; an admin settles it in Email history).
--    Callers: a signed-in office or admin user of that company (the person is the caller; a support session is refused; an admin
--    passes the second step), or the server's service role (schedules; p_user NULL = sent by the system).
CREATE TABLE IF NOT EXISTS security_audit.company_email_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID,
  idempotency_key TEXT NOT NULL CONSTRAINT company_email_sends_key CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  history_id      UUID NOT NULL,
  status          TEXT NOT NULL CONSTRAINT company_email_sends_status CHECK (status IN ('drafted', 'sending', 'accepted', 'failed', 'unknown')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_email_sends_one_per_key UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS company_email_sends_org_time ON security_audit.company_email_sends (organization_id, created_at);
ALTER TABLE security_audit.company_email_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_audit.company_email_sends FROM PUBLIC, anon, authenticated, service_role;

-- Who may reserve or complete a company e-mail for p_org: the service role (server only), or a signed-in office/admin user of that
-- company acting as themselves (p_user = auth.uid()), not in a support session, past the second step when required. Anyone else: 42501.
CREATE OR REPLACE FUNCTION public._company_email_caller(p_org UUID, p_user UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role TEXT := coalesce(nullif(current_setting('role', true), 'none'), session_user::TEXT);
BEGIN
  IF v_role = 'service_role' OR NOT public.is_api_role() THEN
    IF p_org IS NULL THEN
      RAISE EXCEPTION 'No company.' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF v_role <> 'authenticated' THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_privileged_aal();
  IF auth.uid() IS NULL OR p_user IS DISTINCT FROM auth.uid() OR p_org IS DISTINCT FROM public.current_user_organization_id()
     OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only office and admin users of this company can send its e-mail.' USING ERRCODE = '42501';
  END IF;
  IF coalesce((SELECT s.is_support FROM public._session_membership() s LIMIT 1), FALSE) THEN
    RAISE EXCEPTION 'Support access can''t send e-mail.' USING ERRCODE = '42501', HINT = 'support_refused';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public._company_email_caller(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Reserve one company e-mail. A new key: an email_history row ('sending', or 'drafted' when no provider is set up) and a ledger row.
-- A key seen before: nothing new is written ({replay: true} with the earlier history row and status), unless that earlier attempt
-- definitely failed, in which case the same history row and ledger row are used again. At most 200 sends (sending, accepted, unknown)
-- per company per hour (PT429). Returns {send_id, history_id, status, replay}.
CREATE OR REPLACE FUNCTION public.reserve_company_email(p_org UUID, p_user UUID, p_key TEXT, p_to TEXT, p_subject TEXT, p_body TEXT,
                                                        p_related_type TEXT, p_related_id TEXT, p_mode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prior   security_audit.company_email_sends;
  v_history UUID;
  v_status  TEXT := CASE p_mode WHEN 'drafted' THEN 'drafted' ELSE 'sending' END;
BEGIN
  PERFORM public._company_email_caller(p_org, p_user);
  IF p_mode NOT IN ('sending', 'drafted') OR p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' OR nullif(btrim(coalesce(p_to, '')), '') IS NULL
     OR nullif(btrim(coalesce(p_subject, '')), '') IS NULL OR p_body IS NULL
     OR p_related_type NOT IN ('invoice', 'quote', 'sales_order', 'purchase_order', 'delivery_note', 'rfq', 'job', 'general') THEN
    RAISE EXCEPTION 'Invalid company e-mail' USING ERRCODE = '22023';
  END IF;

  -- One reservation at a time per company (the same lock as 031's reserve_mail_send).
  PERFORM pg_advisory_xact_lock(hashtextextended('mail-send:' || p_org::TEXT, 0));
  UPDATE security_audit.company_email_sends SET status = 'unknown', updated_at = now()
  WHERE organization_id = p_org AND status = 'sending' AND updated_at < now() - public.mail_send_stale_after();

  SELECT * INTO v_prior FROM security_audit.company_email_sends WHERE organization_id = p_org AND idempotency_key = p_key;
  IF FOUND AND v_prior.status <> 'failed' THEN
    RETURN jsonb_build_object('send_id', v_prior.id, 'history_id', v_prior.history_id, 'status', v_prior.status, 'replay', TRUE);
  END IF;

  IF v_status = 'sending' AND (SELECT count(*) FROM security_audit.company_email_sends
        WHERE organization_id = p_org AND status IN ('sending', 'accepted', 'unknown') AND created_at > now() - INTERVAL '1 hour') >= 200 THEN
    RAISE EXCEPTION 'Too many e-mails sent in the last hour. Try again later.' USING ERRCODE = 'PT429';
  END IF;

  IF v_prior.id IS NOT NULL THEN
    UPDATE public.email_history SET status = v_status, to_email = btrim(p_to), subject = p_subject, body = p_body
    WHERE id = v_prior.history_id AND organization_id = p_org RETURNING id INTO v_history;
  END IF;
  IF v_history IS NULL THEN
    INSERT INTO public.email_history (organization_id, to_email, subject, body, status, related_to_type, related_to_id, drafted_by)
    VALUES (p_org, btrim(p_to), p_subject, p_body, v_status, p_related_type, p_related_id, p_user)
    RETURNING id INTO v_history;
  END IF;
  IF v_prior.id IS NOT NULL THEN
    UPDATE security_audit.company_email_sends SET status = v_status, user_id = p_user, history_id = v_history, created_at = now(), updated_at = now()
    WHERE id = v_prior.id;
    RETURN jsonb_build_object('send_id', v_prior.id, 'history_id', v_history, 'status', v_status, 'replay', FALSE);
  END IF;
  INSERT INTO security_audit.company_email_sends (organization_id, user_id, idempotency_key, history_id, status)
  VALUES (p_org, p_user, p_key, v_history, v_status)
  RETURNING * INTO v_prior;
  RETURN jsonb_build_object('send_id', v_prior.id, 'history_id', v_history, 'status', v_status, 'replay', FALSE);
END
$$;

-- Record the provider's answer for a reservation still 'sending': accepted (history sent_via_system, sent_at), failed, or unknown.
CREATE OR REPLACE FUNCTION public.complete_company_email(p_org UUID, p_user UUID, p_send UUID, p_outcome TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row security_audit.company_email_sends;
BEGIN
  PERFORM public._company_email_caller(p_org, p_user);
  IF p_outcome NOT IN ('accepted', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'Unknown outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM security_audit.company_email_sends WHERE id = p_send AND organization_id = p_org AND status = 'sending' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No e-mail being sent with this id' USING ERRCODE = 'P0002';
  END IF;
  UPDATE security_audit.company_email_sends SET status = p_outcome, updated_at = now() WHERE id = p_send;
  UPDATE public.email_history
  SET status = CASE p_outcome WHEN 'accepted' THEN 'sent_via_system' ELSE p_outcome END,
      sent_at = CASE WHEN p_outcome = 'accepted' THEN now() ELSE sent_at END
  WHERE id = v_row.history_id AND organization_id = p_org;
END
$$;
REVOKE ALL ON FUNCTION public.reserve_company_email(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_company_email(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_company_email(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_company_email(UUID, UUID, UUID, TEXT) TO authenticated, service_role;

DROP TRIGGER IF EXISTS support_read_only ON security_audit.company_email_sends;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON security_audit.company_email_sends FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON security_audit.company_email_sends;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON security_audit.company_email_sends FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'security_audit.company_email_sends', 'SELECT') OR has_table_privilege('service_role', 'security_audit.company_email_sends', 'SELECT')
     OR has_function_privilege('authenticated', 'public._company_email_caller(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reserve_company_email(uuid,uuid,text,text,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.complete_company_email(uuid,uuid,uuid,text)', 'EXECUTE')
     OR NOT (SELECT bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) FROM pg_proc p
             WHERE p.oid IN ('public.reserve_company_email(uuid,uuid,text,text,text,text,text,text,text)'::regprocedure, 'public.complete_company_email(uuid,uuid,uuid,text)'::regprocedure)) THEN
    RAISE EXCEPTION '106: the company e-mail ledger or its functions are wider than intended';
  END IF;
END
$$;
