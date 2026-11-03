-- 138_chase_steps.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 138 (provisional number; the final one is given at merge): late-payer chasing, phase 1 (Rhys, 2 Nov). Per company, chase STEPS: an
-- offset in days from the invoice's due date (-3 = three days before it is due; 7 = a week after) and a tone (before_due, friendly,
-- firm, final). The scheduled pass (108's invoice_reminder schedule) and Invoices > Chase All Overdue make DRAFTS for the Approvals queue,
-- never an e-mail: an office or admin user approves each one ("Approve and send" through the company mailer, or copy / mail app / mark
-- sent). Each invoice gets each step at most once, and never a step while it is paid, void, credited, written off, still a draft, has a
-- payment to confirm (027's payment_unverified), no balance, or its chasing (or its customer's) is paused.
-- Needs 000 (organizations, invoices, customers, email_history, security_audit.audit_log), 027 (invoices.payment_unverified), 033/036
-- (require_admin_mfa_guard, support_readonly_guard), 106 (email_templates and its key list), 108 (email_schedules: the company's time
-- zone), 076 (invoice_issue_lock). Touches TWO existing objects: 106's CHECK constraint email_templates_key, which also allows the three
-- new template keys 'chase_before_due', 'chase_firm', 'chase_final' (the friendly step uses 106's 'invoice_reminder' text), and 076's
-- invoice_issue_lock (g below). Adds four columns to public.invoices (all NULL). NO EXISTING ROW CHANGES.
--
-- WHAT IT ADDS.
--   a. public.chase_steps: a company's steps (at most 10, one per offset). Members read; admin and office write (workshop and viewer
--      cannot). A step on or before the due date (offset <= 0) is 'before_due'; after it (offset > 0) friendly, firm or final.
--   b. public.chase_pauses: chasing paused for ONE invoice or ONE customer (a reason; optionally until a date, inclusive). Admin and office
--      read and write; resume = delete the row. A customer pause covers every invoice made out to that customer's name (invoices name the
--      customer as text: the same rule the reminders use to find the customer's address, trimmed and case-insensitive).
--   c. public.chase_sends: one row per invoice per step that was drafted (and, once approved and sent, who approved it and the sent
--      e-mail). Admin and office read; only chase_create_draft / chase_record_sent write it (no API grant to write).
--   d. public.chase_create_draft(...): the ONLY way a chase draft is made. Re-checks everything above in the database, never a step
--      before its day (today - due date >= the step's offset), at most once per invoice per step (a per-invoice lock + UNIQUE
--      (invoice_id, step_id)), writes the email_history draft and the chase_sends row together, and audits it. WHICH step is due on a
--      day is the app's choice (lib/chasing/steps.ts dueChaseSteps); this function only refuses what must never happen.
--   e. public.chase_record_sent(...): after "Approve and send" went through the mailer: records who approved it and the sent e-mail,
--      removes the draft it replaced (the sent e-mail, its history row, holds the final text), and audits it.
--   d and e are SECURITY DEFINER, search_path pinned, and callable by the service role ONLY (the server routes and the cron, which check
--   the signed-in caller first); no grant to anon, authenticated or PUBLIC.
--   f. Row triggers chase_steps_guard / chase_pauses_guard (at most 10 steps; same company; who and when), and support_read_only +
--      admin_mfa on the three tables (as every settings table).
--   g. (6b) A payment claim on an invoice, for ChatGPT's task 7 (no UI here): four invoices columns (payment_claimed_at,
--      payment_claim_source 'email' | 'manual', payment_claim_evidence, payment_claim_message_id), public.mark_payment_claimed (office /
--      admin of the invoice's company, or the service role) and public.resolve_payment_claim (office / admin: 'confirmed' |
--      'not_received'), both SECURITY DEFINER, pinned, audited. An invoice with a claim is never chased. SECOND EXISTING OBJECT TOUCHED:
--      076's invoice_issue_lock, whose list of columns still open after issue gains the four claim columns (nothing else changes), and a
--      new row trigger invoices_payment_claim_guard keeps them to the two functions.
-- GUARD (section 1): what it needs exists, 106's key constraint is 106's text (or already this file's), invoice_issue_lock is 076's (or
-- already this file's), and d / e / g's functions, when already there, are this file's bodies (md5 with every whitespace character removed). Safe to run again. SELF-CHECK (section 7).
-- Verify: supabase/verify/chase_steps_138.sql (every row TRUE).
-- Rollback: supabase/release/138_chase_steps.rollback.sql (drops a to g, puts back 106's constraint and 076's invoice_issue_lock; deletes
-- saved texts for the three new keys, the chase records and every payment claim; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
DECLARE
  v_def TEXT;
  v_md5 TEXT;
BEGIN
  IF to_regclass('public.email_templates') IS NULL OR to_regclass('public.email_schedules') IS NULL OR to_regclass('public.email_history') IS NULL
     OR to_regclass('public.invoices') IS NULL OR to_regclass('public.customers') IS NULL OR to_regclass('security_audit.audit_log') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'payment_unverified') THEN
    RAISE EXCEPTION '138: 000 / 027 / 033 / 036 / 106 / 108 objects are missing; apply them first';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c WHERE c.conrelid = 'public.email_templates'::regclass AND c.conname = 'email_templates_key';
  IF v_def IS DISTINCT FROM 'CHECK ((key = ANY (ARRAY[''quote''::text, ''invoice''::text, ''purchase_order''::text, ''delivery_note''::text, ''invoice_reminder''::text, ''timesheet''::text, ''job_to_workshop''::text, ''rfq_clarify''::text])))'
     AND v_def IS DISTINCT FROM 'CHECK ((key = ANY (ARRAY[''quote''::text, ''invoice''::text, ''purchase_order''::text, ''delivery_note''::text, ''invoice_reminder''::text, ''timesheet''::text, ''job_to_workshop''::text, ''rfq_clarify''::text, ''chase_before_due''::text, ''chase_firm''::text, ''chase_final''::text])))' THEN
    RAISE EXCEPTION '138: email_templates_key is not 106''s (%); stop and compare it first', coalesce(v_def, 'missing');
  END IF;
  -- 138's own bodies only, when already there (a second run): 5452f25d1f364e3915e01db2cfed2fee chase_create_draft, 213c534d5aeb25f0d14f9070396faf76 chase_record_sent (section 7 pins both).
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '5452f25d1f364e3915e01db2cfed2fee' THEN
    RAISE EXCEPTION '138: public.chase_create_draft is not this file''s (md5 without whitespace %); stop and compare it first', v_md5;
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '213c534d5aeb25f0d14f9070396faf76' THEN
    RAISE EXCEPTION '138: public.chase_record_sent is not this file''s (md5 without whitespace %); stop and compare it first', v_md5;
  END IF;
  -- invoice_issue_lock: be26a190744e6b961c9ad71366c67099 076's (the newest before 138); aa8c9f3ae3035d0ed566723a28edd827 this file's (6b).
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_lock()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('be26a190744e6b961c9ad71366c67099', 'aa8c9f3ae3035d0ed566723a28edd827') THEN
    RAISE EXCEPTION '138: public.invoice_issue_lock is not 076''s (md5 without whitespace %); stop and compare it first', coalesce(v_md5, 'missing');
  END IF;
  -- The payment-claim functions (6b), when already there: this file's only.
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid IN (to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)'), to_regprocedure('public.resolve_payment_claim(uuid,text)'), to_regprocedure('public.invoices_payment_claim_guard()'))
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) NOT IN ('1ee5cb529645fd03263bd9e481864b1d', 'd3cbee1ab48f8e29d20fe23f8d8603fd', '7f540f262f12c85432b5a5172442d005')) THEN
    RAISE EXCEPTION '138: a payment-claim function is already there and is not this file''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. 106's template keys, plus the before-due, firm and final chase texts (a company's own wording for them).
ALTER TABLE public.email_templates DROP CONSTRAINT IF EXISTS email_templates_key;
ALTER TABLE public.email_templates ADD CONSTRAINT email_templates_key
  CHECK (key IN ('quote', 'invoice', 'purchase_order', 'delivery_note', 'invoice_reminder', 'timesheet', 'job_to_workshop', 'rfq_clarify',
                 'chase_before_due', 'chase_firm', 'chase_final'));

-- -----------------------------------------------------------------------------------------------------
-- 3. Tables.
CREATE TABLE IF NOT EXISTS public.chase_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  offset_days     INTEGER NOT NULL CONSTRAINT chase_steps_offset CHECK (offset_days BETWEEN -60 AND 365),
  tone            TEXT NOT NULL CONSTRAINT chase_steps_tone CHECK (tone IN ('before_due', 'friendly', 'firm', 'final')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID,
  -- On or before the due date the e-mail is a nudge ("is due on"); after it, an overdue reminder in the tone chosen.
  CONSTRAINT chase_steps_tone_fits CHECK ((tone = 'before_due') = (offset_days <= 0)),
  CONSTRAINT chase_steps_one_per_offset UNIQUE (organization_id, offset_days)
);

CREATE TABLE IF NOT EXISTS public.chase_pauses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES public.customers(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CONSTRAINT chase_pauses_reason CHECK (char_length(btrim(reason)) BETWEEN 1 AND 300),
  paused_until    DATE,                                                  -- inclusive; NULL = until resumed
  paused_by       UUID,
  paused_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chase_pauses_one_target CHECK (num_nonnulls(invoice_id, customer_id) = 1),
  CONSTRAINT chase_pauses_one_per_invoice UNIQUE (invoice_id),
  CONSTRAINT chase_pauses_one_per_customer UNIQUE (customer_id)
);
CREATE INDEX IF NOT EXISTS chase_pauses_org ON public.chase_pauses (organization_id);

CREATE TABLE IF NOT EXISTS public.chase_sends (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  step_id          UUID REFERENCES public.chase_steps(id) ON DELETE SET NULL,
  offset_days      INTEGER NOT NULL,                                     -- the step as it was when drafted
  tone             TEXT NOT NULL CONSTRAINT chase_sends_tone CHECK (tone IN ('before_due', 'friendly', 'firm', 'final')),
  status           TEXT NOT NULL DEFAULT 'drafted' CONSTRAINT chase_sends_status CHECK (status IN ('drafted', 'sent')),
  draft_history_id UUID REFERENCES public.email_history(id) ON DELETE SET NULL,
  sent_history_id  UUID REFERENCES public.email_history(id) ON DELETE SET NULL,
  drafted_by       UUID,                                                 -- NULL: the scheduled pass
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by      UUID,
  approved_at      TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  CONSTRAINT chase_sends_one_per_step UNIQUE (invoice_id, step_id)
);
CREATE INDEX IF NOT EXISTS chase_sends_org_invoice ON public.chase_sends (organization_id, invoice_id);
CREATE INDEX IF NOT EXISTS chase_sends_draft ON public.chase_sends (draft_history_id);

-- -----------------------------------------------------------------------------------------------------
-- 4. Row triggers: at most 10 steps a company; the paused invoice or customer is the company's; who changed it and when.
CREATE OR REPLACE FUNCTION public.chase_steps_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'A chase step stays with its company.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('chase-steps:' || NEW.organization_id::TEXT, 0));
    IF (SELECT count(*) FROM public.chase_steps s WHERE s.organization_id = NEW.organization_id) >= 10 THEN
      RAISE EXCEPTION 'At most 10 chase steps.' USING ERRCODE = '22023', HINT = 'too_many_steps';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  NEW.updated_by := coalesce(auth.uid(), CASE WHEN TG_OP = 'UPDATE' THEN OLD.updated_by END);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.chase_steps_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS chase_steps_guard ON public.chase_steps;
CREATE TRIGGER chase_steps_guard BEFORE INSERT OR UPDATE ON public.chase_steps FOR EACH ROW EXECUTE FUNCTION public.chase_steps_guard();

CREATE OR REPLACE FUNCTION public.chase_pauses_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
                           OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    RAISE EXCEPTION 'A pause stays with its invoice or customer: resume it and pause again.' USING ERRCODE = '42501';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That invoice is not in this company.' USING ERRCODE = '42501';
  END IF;
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = NEW.customer_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That customer is not in this company.' USING ERRCODE = '42501';
  END IF;
  NEW.reason := btrim(NEW.reason);
  NEW.paused_at := clock_timestamp();
  NEW.paused_by := coalesce(auth.uid(), CASE WHEN TG_OP = 'UPDATE' THEN OLD.paused_by END);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.chase_pauses_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS chase_pauses_guard ON public.chase_pauses;
CREATE TRIGGER chase_pauses_guard BEFORE INSERT OR UPDATE ON public.chase_pauses FOR EACH ROW EXECUTE FUNCTION public.chase_pauses_guard();

-- -----------------------------------------------------------------------------------------------------
-- 5. Row security. Steps: the company reads, admin and office write. Pauses: admin and office. Sends: admin and office read; the server writes.
ALTER TABLE public.chase_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chase_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chase_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chase_steps member select" ON public.chase_steps;
CREATE POLICY "chase_steps member select" ON public.chase_steps FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()));
DROP POLICY IF EXISTS "chase_steps office insert" ON public.chase_steps;
CREATE POLICY "chase_steps office insert" ON public.chase_steps FOR INSERT TO authenticated
  WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));
DROP POLICY IF EXISTS "chase_steps office update" ON public.chase_steps;
CREATE POLICY "chase_steps office update" ON public.chase_steps FOR UPDATE TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])))
  WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));
DROP POLICY IF EXISTS "chase_steps office delete" ON public.chase_steps;
CREATE POLICY "chase_steps office delete" ON public.chase_steps FOR DELETE TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));

DROP POLICY IF EXISTS "chase_pauses office select" ON public.chase_pauses;
CREATE POLICY "chase_pauses office select" ON public.chase_pauses FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));
DROP POLICY IF EXISTS "chase_pauses office insert" ON public.chase_pauses;
CREATE POLICY "chase_pauses office insert" ON public.chase_pauses FOR INSERT TO authenticated
  WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));
DROP POLICY IF EXISTS "chase_pauses office update" ON public.chase_pauses;
CREATE POLICY "chase_pauses office update" ON public.chase_pauses FOR UPDATE TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])))
  WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));
DROP POLICY IF EXISTS "chase_pauses office delete" ON public.chase_pauses;
CREATE POLICY "chase_pauses office delete" ON public.chase_pauses FOR DELETE TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));

DROP POLICY IF EXISTS "chase_sends office select" ON public.chase_sends;
CREATE POLICY "chase_sends office select" ON public.chase_sends FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));

REVOKE ALL ON public.chase_steps, public.chase_pauses, public.chase_sends FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chase_steps, public.chase_pauses TO authenticated;
GRANT SELECT ON public.chase_sends TO authenticated;

DROP TRIGGER IF EXISTS support_read_only ON public.chase_steps;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chase_steps FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.chase_steps;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.chase_steps FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.chase_pauses;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chase_pauses FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.chase_pauses;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.chase_pauses FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.chase_sends;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.chase_sends FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.chase_sends;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.chase_sends FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 6. The two server-only functions.
-- chase_create_draft: one chase draft for one invoice and one step, or the reason there is none. p_user: the office/admin user who pressed
-- Chase All Overdue (they must be an active admin or office member of p_org), or NULL for the scheduled pass. "Today" is the company's
-- date in its invoice_reminder schedule's time zone (Europe/London without one). The invoice is owed exactly as lib/receivables says:
-- issued, not paid / void / voided / cancelled / canceled / credited / written_off, no payment to confirm, and total - received - credited
-- + refunded above 0 (numeric: exact to the penny). Returns {created: true, history_id, chase_id} or {created: false, reason}.
CREATE OR REPLACE FUNCTION public.chase_create_draft(p_org UUID, p_invoice UUID, p_step UUID, p_to TEXT, p_to_name TEXT, p_subject TEXT, p_body TEXT, p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv     public.invoices%ROWTYPE;
  v_step    public.chase_steps%ROWTYPE;
  v_status  TEXT;
  v_today   DATE;
  v_reason  TEXT;
  v_history UUID;
  v_chase   UUID;
BEGIN
  IF p_org IS NULL OR p_invoice IS NULL OR p_step IS NULL OR nullif(btrim(coalesce(p_to, '')), '') IS NULL OR length(p_to) > 2000
     OR nullif(btrim(coalesce(p_subject, '')), '') IS NULL OR length(p_subject) > 200 OR p_subject ~ '[\r\n]'
     OR nullif(btrim(coalesce(p_body, '')), '') IS NULL OR length(p_body) > 100000 THEN
    RAISE EXCEPTION 'Invalid chase draft' USING ERRCODE = '22023';
  END IF;
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = p_user AND m.organization_id = p_org
                                         AND m.active AND m.role IN ('admin', 'office')) THEN
    RAISE EXCEPTION 'Only office and admin users of this company can chase its invoices.' USING ERRCODE = '42501';
  END IF;
  -- One chase decision at a time per invoice: two passes (or the pass and the button) can't both draft the same step.
  PERFORM pg_advisory_xact_lock(hashtextextended('chase:' || p_invoice::TEXT, 0));

  SELECT * INTO v_inv FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_step FROM public.chase_steps s WHERE s.id = p_step AND s.organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chase step not found' USING ERRCODE = 'P0002';
  END IF;

  v_today := (now() AT TIME ZONE coalesce((SELECT e.timezone FROM public.email_schedules e WHERE e.organization_id = p_org AND e.kind = 'invoice_reminder'), 'Europe/London'))::DATE;
  v_status := coalesce(nullif(lower(btrim(coalesce(v_inv.status, ''))), ''), 'draft');
  v_reason := CASE
    WHEN v_status = 'draft' OR nullif(btrim(coalesce(v_inv.invoice_ref, '')), '') IS NULL THEN 'not_issued'
    WHEN v_status = 'paid' THEN 'paid'
    WHEN v_status IN ('void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off') THEN 'closed'
    WHEN coalesce(v_inv.payment_unverified, FALSE) THEN 'payment_unverified'
    WHEN v_inv.payment_claimed_at IS NOT NULL THEN 'payment_claimed'
    WHEN round(coalesce(v_inv.total, 0), 2) - round(coalesce(v_inv.amount_paid, 0), 2) - round(coalesce(v_inv.credited_amount, 0), 2)
         + round(coalesce(v_inv.refunded_amount, 0), 2) <= 0 THEN 'no_balance'
    WHEN v_inv.due_date IS NULL THEN 'no_due_date'
    WHEN v_today - v_inv.due_date < v_step.offset_days THEN 'not_due'
    WHEN EXISTS (SELECT 1 FROM public.chase_pauses p WHERE p.organization_id = p_org AND p.invoice_id = p_invoice
                 AND (p.paused_until IS NULL OR p.paused_until >= v_today)) THEN 'invoice_paused'
    WHEN EXISTS (SELECT 1 FROM public.chase_pauses p JOIN public.customers c ON c.id = p.customer_id AND c.organization_id = p_org
                 WHERE p.organization_id = p_org AND lower(btrim(c.name)) = lower(btrim(coalesce(v_inv.customer, '')))
                 AND (p.paused_until IS NULL OR p.paused_until >= v_today)) THEN 'customer_paused'
    WHEN EXISTS (SELECT 1 FROM public.chase_sends s WHERE s.invoice_id = p_invoice AND s.step_id = p_step) THEN 'step_done'
  END;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('created', FALSE, 'reason', v_reason);
  END IF;

  INSERT INTO public.email_history (organization_id, to_email, to_name, subject, body, status, related_to_type, related_to_id, drafted_by)
  VALUES (p_org, btrim(p_to), nullif(btrim(coalesce(p_to_name, '')), ''), p_subject, p_body, 'drafted', 'invoice', p_invoice::TEXT, p_user)
  RETURNING id INTO v_history;
  INSERT INTO public.chase_sends (organization_id, invoice_id, step_id, offset_days, tone, draft_history_id, drafted_by)
  VALUES (p_org, p_invoice, p_step, v_step.offset_days, v_step.tone, v_history, p_user)
  RETURNING id INTO v_chase;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (p_org, p_user, (SELECT u.email FROM public.user_profiles u WHERE u.id = p_user), 'chase_drafted', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'chase_138', 'chase_id', v_chase, 'history_id', v_history, 'offset_days', v_step.offset_days, 'tone', v_step.tone,
                             'by', CASE WHEN p_user IS NULL THEN 'schedule' ELSE 'person' END));
  RETURN jsonb_build_object('created', TRUE, 'history_id', v_history, 'chase_id', v_chase);
END
$$;

-- chase_record_sent: the chase draft p_draft was approved by p_user (an active admin or office member of p_org) and sent through the
-- company mailer as the history row p_sent ('sent_via_system', the same invoice). Records the approval and the sent e-mail on the chase
-- row, removes the draft it replaced, and audits it. Running it again for the same pair changes nothing ({recorded: false, already: true}).
CREATE OR REPLACE FUNCTION public.chase_record_sent(p_org UUID, p_draft UUID, p_sent UUID, p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_chase public.chase_sends%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_draft IS NULL OR p_sent IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'Invalid chase approval' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = p_user AND m.organization_id = p_org AND m.active AND m.role IN ('admin', 'office')) THEN
    RAISE EXCEPTION 'Only office and admin users of this company can approve a chase.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_chase FROM public.chase_sends s
  WHERE s.organization_id = p_org AND (s.draft_history_id = p_draft OR (s.status = 'sent' AND s.sent_history_id = p_sent))
  ORDER BY (s.draft_history_id = p_draft) DESC NULLS LAST LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chase draft not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_chase.status = 'sent' THEN
    IF v_chase.sent_history_id = p_sent THEN
      RETURN jsonb_build_object('recorded', FALSE, 'already', TRUE, 'chase_id', v_chase.id);
    END IF;
    RAISE EXCEPTION 'This chase was already sent.' USING ERRCODE = '23505';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_history h WHERE h.id = p_sent AND h.organization_id = p_org AND h.status = 'sent_via_system'
                 AND h.related_to_type = 'invoice' AND h.related_to_id = v_chase.invoice_id::TEXT) THEN
    RAISE EXCEPTION 'The sent e-mail is not this invoice''s.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.chase_sends SET status = 'sent', sent_history_id = p_sent, sent_at = clock_timestamp(), approved_by = p_user, approved_at = clock_timestamp()
  WHERE id = v_chase.id;
  DELETE FROM public.email_history h WHERE h.id = p_draft AND h.organization_id = p_org AND h.status = 'drafted';
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (p_org, p_user, (SELECT u.email FROM public.user_profiles u WHERE u.id = p_user), 'chase_approved_sent', 'invoices', v_chase.invoice_id::TEXT,
          jsonb_build_object('source', 'chase_138', 'chase_id', v_chase.id, 'draft_id', p_draft, 'history_id', p_sent, 'offset_days', v_chase.offset_days, 'tone', v_chase.tone));
  RETURN jsonb_build_object('recorded', TRUE, 'already', FALSE, 'chase_id', v_chase.id);
END
$$;
REVOKE ALL ON FUNCTION public.chase_create_draft(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chase_record_sent(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chase_create_draft(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.chase_record_sent(UUID, UUID, UUID, UUID) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 6b. A payment claim on an invoice ("we've paid", from the customer's e-mail or noted by hand), for ChatGPT's task 7: the inbox poll
-- (service role) or an office / admin user marks it; an office / admin user resolves it (confirmed or not received). While an invoice
-- carries a claim it is never chased (chase_create_draft above refuses 'payment_claimed'; the app's pass skips it too). No UI here.
--   Columns (all NULL = no claim): payment_claimed_at, payment_claim_source ('email' | 'manual'), payment_claim_evidence (up to 2000
--   characters: what the customer said, or the person's note), payment_claim_message_id (the e-mail's message id, up to 998).
--   invoice_issue_lock (076's body, one change): the four columns stay open after issue (as status and payment_unverified are), and
--   invoices_payment_claim_guard lets NO API role change them except through the two functions below (which mark the transaction for
--   that one invoice: quoteflow.payment_claim). A direct UPDATE by a signed-in user, or the service role's REST, is refused.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_claimed_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_claim_source TEXT CONSTRAINT invoices_payment_claim_source CHECK (payment_claim_source IN ('email', 'manual'));
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_claim_evidence TEXT CONSTRAINT invoices_payment_claim_evidence CHECK (char_length(payment_claim_evidence) <= 2000);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_claim_message_id TEXT CONSTRAINT invoices_payment_claim_message_id CHECK (char_length(payment_claim_message_id) <= 998);
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_payment_claim_whole;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_payment_claim_whole CHECK (
  (payment_claimed_at IS NULL AND payment_claim_source IS NULL AND payment_claim_evidence IS NULL AND payment_claim_message_id IS NULL)
  OR (payment_claimed_at IS NOT NULL AND payment_claim_source IS NOT NULL));

CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- 138: the four payment-claim columns stay open after issue too; invoices_payment_claim_guard lets only the two claim functions change them.
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_date', 'job_id', 'payment_unverified', 'updated_at', 'updated_by',
                                  'payment_claimed_at', 'payment_claim_source', 'payment_claim_evidence', 'payment_claim_message_id'];
  v_receipts CONSTANT TEXT[] := ARRAY['amount_paid', 'paid_at', 'credited_amount', 'refunded_amount'];
  v_via_payment BOOLEAN;
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be deleted.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t go back to draft.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  v_via_payment := current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF NOT v_via_payment THEN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.credited_amount IS DISTINCT FROM OLD.credited_amount OR NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount THEN
      RAISE EXCEPTION 'Invoice %: payments are recorded with Record payment and credits applied with Apply credit, not by editing the amounts.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF OLD.payment_unverified AND NOT NEW.payment_unverified THEN
      RAISE EXCEPTION 'Invoice %: payments are confirmed with Confirm payments complete, not by editing the flag.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND (lower(coalesce(NEW.status, '')) IN ('paid', 'partial', 'credited') OR lower(coalesce(OLD.status, '')) IN ('paid', 'partial', 'credited')) THEN
      RAISE EXCEPTION 'Invoice %: it becomes part paid, paid or credited only when a payment is recorded or a credit applied.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - v_open - v_receipts) IS DISTINCT FROM (to_jsonb(OLD) - v_open - v_receipts) THEN
    RAISE EXCEPTION 'Invoice % has been issued: its amounts, customer and details can''t be changed (only payment and status).', OLD.invoice_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.invoices_payment_claim_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() AND current_setting('quoteflow.payment_claim', TRUE) IS DISTINCT FROM NEW.id::TEXT
     AND (CASE WHEN TG_OP = 'INSERT' THEN num_nonnulls(NEW.payment_claimed_at, NEW.payment_claim_source, NEW.payment_claim_evidence, NEW.payment_claim_message_id) > 0
               ELSE (NEW.payment_claimed_at, NEW.payment_claim_source, NEW.payment_claim_evidence, NEW.payment_claim_message_id)
                    IS DISTINCT FROM (OLD.payment_claimed_at, OLD.payment_claim_source, OLD.payment_claim_evidence, OLD.payment_claim_message_id) END) THEN
    RAISE EXCEPTION 'A payment claim is marked with mark_payment_claimed and cleared with resolve_payment_claim, not by editing the invoice.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.invoices_payment_claim_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_payment_claim_guard ON public.invoices;
CREATE TRIGGER invoices_payment_claim_guard BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.invoices_payment_claim_guard();

-- mark_payment_claimed: the service role (the inbox poll: any company's invoice, by id) or an office / admin user of the invoice's company
-- (an admin past the second step; a support session is refused by the invoices' support_read_only trigger). Not for a draft (not
-- issued), paid, void / voided / cancelled / canceled, credited or written-off invoice. Marking again replaces the claim. Audited
-- (payment_claimed: source, whether there is a message id, the evidence's length; never the evidence itself).
CREATE OR REPLACE FUNCTION public.mark_payment_claimed(p_invoice UUID, p_source TEXT, p_evidence TEXT, p_message_id TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role   TEXT := coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT);
  v_inv    public.invoices%ROWTYPE;
  v_status TEXT;
  v_actor  UUID;
BEGIN
  IF p_invoice IS NULL OR p_source IS NULL OR p_source NOT IN ('email', 'manual')
     OR char_length(coalesce(p_evidence, '')) > 2000 OR char_length(coalesce(p_message_id, '')) > 998 THEN
    RAISE EXCEPTION 'Invalid payment claim' USING ERRCODE = '22023';
  END IF;
  IF v_role = 'service_role' THEN
    SELECT * INTO v_inv FROM public.invoices i WHERE i.id = p_invoice FOR UPDATE;
  ELSIF v_role = 'authenticated' THEN
    PERFORM public.assert_privileged_aal();
    IF auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
      RAISE EXCEPTION 'Only office and admin users can mark a payment claim.' USING ERRCODE = '42501';
    END IF;
    v_actor := auth.uid();
    SELECT * INTO v_inv FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = public.current_user_organization_id() FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  v_status := coalesce(nullif(lower(btrim(coalesce(v_inv.status, ''))), ''), 'draft');
  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'Invoice % is still a draft.', coalesce(v_inv.invoice_ref, '') USING ERRCODE = '22023', HINT = 'invoice_draft';
  ELSIF v_status = 'paid' THEN
    RAISE EXCEPTION 'Invoice % is already paid.', v_inv.invoice_ref USING ERRCODE = '22023', HINT = 'invoice_paid';
  ELSIF v_status IN ('void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off') THEN
    RAISE EXCEPTION 'Invoice % is %, so a payment claim can''t be marked on it.', v_inv.invoice_ref, v_status USING ERRCODE = '22023', HINT = 'invoice_closed';
  END IF;
  PERFORM set_config('quoteflow.payment_claim', p_invoice::TEXT, TRUE);
  UPDATE public.invoices SET payment_claimed_at = clock_timestamp(), payment_claim_source = p_source,
         payment_claim_evidence = nullif(btrim(coalesce(p_evidence, '')), ''), payment_claim_message_id = nullif(btrim(coalesce(p_message_id, '')), '')
  WHERE id = p_invoice;
  PERFORM set_config('quoteflow.payment_claim', '', TRUE);
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_inv.organization_id, v_actor, (SELECT u.email FROM public.user_profiles u WHERE u.id = v_actor), 'payment_claimed', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'payment_claim_138', 'claim_source', p_source, 'has_message_id', nullif(btrim(coalesce(p_message_id, '')), '') IS NOT NULL,
                             'evidence_length', char_length(coalesce(btrim(p_evidence), '')), 'by', CASE WHEN v_actor IS NULL THEN 'service' ELSE 'person' END,
                             'replaced', v_inv.payment_claimed_at IS NOT NULL));
END
$$;

-- resolve_payment_claim: an office / admin user of the invoice's company settles the claim: 'confirmed' (the money is there; record it
-- with Record payment) or 'not_received'. Clears the four columns. An invoice with no claim: P0002. Audited (payment_claim_resolved, the
-- outcome and the claim's source).
CREATE OR REPLACE FUNCTION public.resolve_payment_claim(p_invoice UUID, p_outcome TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
BEGIN
  IF p_invoice IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('confirmed', 'not_received') THEN
    RAISE EXCEPTION 'Invalid outcome' USING ERRCODE = '22023';
  END IF;
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) <> 'authenticated' THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_privileged_aal();
  IF auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only office and admin users can resolve a payment claim.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inv FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = public.current_user_organization_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.payment_claimed_at IS NULL THEN
    RAISE EXCEPTION 'There is no payment claim on invoice %.', coalesce(v_inv.invoice_ref, '') USING ERRCODE = 'P0002', HINT = 'no_claim';
  END IF;
  PERFORM set_config('quoteflow.payment_claim', p_invoice::TEXT, TRUE);
  UPDATE public.invoices SET payment_claimed_at = NULL, payment_claim_source = NULL, payment_claim_evidence = NULL, payment_claim_message_id = NULL
  WHERE id = p_invoice;
  PERFORM set_config('quoteflow.payment_claim', '', TRUE);
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_inv.organization_id, auth.uid(), (SELECT u.email FROM public.user_profiles u WHERE u.id = auth.uid()), 'payment_claim_resolved', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'payment_claim_138', 'outcome', p_outcome, 'claim_source', v_inv.payment_claim_source, 'claimed_at', v_inv.payment_claimed_at));
END
$$;
REVOKE ALL ON FUNCTION public.mark_payment_claimed(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_payment_claim(UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.mark_payment_claimed(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_claim(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 7. Self-check: every body is this file's; the chase functions definer, pinned, the service role's only; the claim functions definer,
-- pinned, signed-in (mark: and the service role) only; the three tables are row-secured.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_lock()')) IS DISTINCT FROM 'aa8c9f3ae3035d0ed566723a28edd827'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoices_payment_claim_guard()')) IS DISTINCT FROM '7f540f262f12c85432b5a5172442d005'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)')) IS DISTINCT FROM '1ee5cb529645fd03263bd9e481864b1d'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_payment_claim(uuid,text)')) IS DISTINCT FROM 'd3cbee1ab48f8e29d20fe23f8d8603fd' THEN
    RAISE EXCEPTION '138: invoice_issue_lock or a payment-claim function is not this file''s body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)'), to_regprocedure('public.resolve_payment_claim(uuid,text)'))
             AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('anon', p.oid, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')))
     OR NOT has_function_privilege('service_role', 'public.mark_payment_claimed(uuid,text,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.resolve_payment_claim(uuid,text)', 'EXECUTE')
     OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoices_payment_claim_guard()'))
     OR has_function_privilege('authenticated', 'public.invoices_payment_claim_guard()', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_payment_claim_guard' AND tgrelid = 'public.invoices'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION '138: the payment-claim functions are not definer, pinned and granted as this file sets them';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)'))
       IS DISTINCT FROM '5452f25d1f364e3915e01db2cfed2fee'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)'))
       IS DISTINCT FROM '213c534d5aeb25f0d14f9070396faf76' THEN
    RAISE EXCEPTION '138: chase_create_draft or chase_record_sent is not this file''s body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)'), to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)'))
             AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                  OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                  OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                  OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))) THEN
    RAISE EXCEPTION '138: a chase function is not definer, pinned and the service role''s only';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass, 'public.chase_sends'::regclass) AND NOT c.relrowsecurity)
     OR has_table_privilege('authenticated', 'public.chase_sends', 'INSERT') OR has_table_privilege('authenticated', 'public.chase_sends', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.chase_sends', 'DELETE') OR has_table_privilege('anon', 'public.chase_steps', 'SELECT') THEN
    RAISE EXCEPTION '138: the chase tables are not row-secured as this file sets them';
  END IF;
END
$$;

COMMIT;
