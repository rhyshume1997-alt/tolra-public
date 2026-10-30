-- 106_email_templates.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 106: company e-mail templates (E11: Settings > Email templates, lib/email/templates) and the per-company switch for the AI
-- pre-issue finance check (E1). Needs 033 (require_admin_mfa_guard, assert_privileged_aal), 036 (support_readonly_guard), 000/035
-- (security_audit.log_row_change) and 101 (ai_helper_settings, _ai_helper_caller, _ai_helper_audit). Touches none of 102 to 105's
-- objects. Safe to run again.
--
-- WHAT IT ADDS. One table, one column, two functions; no existing row, policy or grant changes, and no existing function is replaced.
--   a. public.email_templates: one row per company per template key (quote, invoice, purchase_order, delivery_note, invoice_reminder,
--      timesheet, job_to_workshop, rfq_clarify): the company's own subject and body. No row = the default text in the app
--      (lib/email/templates/defaults.ts). Read by every member of the company; written (insert, update, delete) by admin and office.
--      The subject is one line (no CR or LF, at most 200 characters); the body at most 10000 characters. updated_at and updated_by
--      are stamped by the database (email_templates_stamp), and a row never moves to another company.
--   b. public.ai_helper_settings.finance_check_enabled BOOLEAN NOT NULL DEFAULT FALSE: the company's own switch for the finance check
--      (the server switch AI_FINANCE_CHECK_ENABLED still has to be on too). Off for every company until an admin turns it on.
--   c. public.ai_helper_set_finance_check(p_enabled BOOLEAN): the admin's way to change (b), through 101's _ai_helper_caller (admin,
--      second step, no support session) and 101's ai_helper_settings_updated audit event. ai_helper_settings keeps no write grant.
-- RLS: on. Policies one per command (no FOR ALL). support_read_only, admin_mfa and the row audit trigger, as 084's tables carry.
-- GUARD (section 1). SELF-CHECK (section 4). Verify: supabase/verify/email_templates_106.sql (every row TRUE).
-- Rollback: supabase/release/106_email_templates.rollback.sql (drops the table, the column and the two functions; Rhys's approval).
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
     OR to_regprocedure('public._ai_helper_audit(uuid,text,text,text,jsonb)') IS NULL OR to_regprocedure('public.ai_helper_status()') IS NULL THEN
    RAISE EXCEPTION '106: a function or table it needs (033, 036, the audit log, 101) is missing';
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

COMMIT;
