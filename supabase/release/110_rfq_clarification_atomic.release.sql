-- 110_rfq_clarification_atomic.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 110: logging an RFQ clarification e-mail is all-or-nothing (backlog E4 "RFQ atomic RPC"; private-repo note 091).
-- Needs 006 (email_history, rfqs and their row rules), 012 (section_allowed), 036 (_session_membership: has_org_role,
-- current_user_organization_id). Touches no existing object.
--
-- Before: RFQ Control's "I sent it" inserted the email_history row, then moved the RFQ to Awaiting clarification in a second
-- request (only a New or Ready RFQ with no quote). If the second request failed, the history said the e-mail went but the RFQ
-- still read New or Ready ("The email was recorded in email history, but the RFQ status didn't change").
-- Now public.log_rfq_clarification(rfq, subject, body) does both in one transaction and returns the RFQ row:
--   * the e-mail is logged as sent manually (sent_at now, drafted by the caller), to the RFQ's own address and customer;
--   * the RFQ moves to 'clarification' only while it is outstanding: status New or Ready and no quote made from it (an RFQ that
--     is already awaiting clarification, quoted, won or lost is never moved); `moved` says whether it did.
-- SECURITY DEFINER with the row rules re-checked inside, exactly as the two requests needed them (006/012): the caller's current
-- company (another company's RFQ reads as not found), role admin or office, the RFQ section and the E-mail or Approval section
-- not hidden for them. The tables' triggers still run as before (support read-only, admin MFA on email_history, the
-- created_by/updated_by stamps and the RFQ change trail). Refusals carry a hint the app shows as written (lib/friendly-error.ts):
--   rfq_not_allowed (42501), rfq_not_found (P0002), rfq_no_email (22023), rfq_email_subject (22023).
-- WHAT CHANGES. One new function; EXECUTE for signed-in users only. No table, row, trigger, policy or grant otherwise.
-- GUARD (section 1): an existing public.log_rfq_clarification must be 110's (a second run). Safe to run again.
-- SELF-CHECK (section 3). Rollback: supabase/release/110_rfq_clarification_atomic.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: a function of this name must be 110's (definer, returns jsonb) or absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'log_rfq_clarification'
             AND (p.oid <> coalesce(to_regprocedure('public.log_rfq_clarification(uuid,text,text)')::oid, 0::oid) OR NOT p.prosecdef
                  OR p.prorettype <> 'jsonb'::regtype)) THEN
    RAISE EXCEPTION '110: public.log_rfq_clarification already exists and is not 110''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The function.
CREATE OR REPLACE FUNCTION public.log_rfq_clarification(p_rfq_id UUID, p_subject TEXT, p_body TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_rfq     public.rfqs%ROWTYPE;
  v_history UUID;
  v_moved   BOOLEAN := FALSE;
BEGIN
  -- The row rules the two requests met (006 rbac + 012 section access on rfqs and email_history), checked here.
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office'])
     OR NOT public.section_allowed('rfq') OR NOT (public.section_allowed('email') OR public.section_allowed('approval')) THEN
    RAISE EXCEPTION 'Only admin and office staff can log RFQ e-mails.' USING ERRCODE = '42501', HINT = 'rfq_not_allowed';
  END IF;
  SELECT * INTO v_rfq FROM public.rfqs r WHERE r.id = p_rfq_id AND r.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That RFQ couldn''t be found. Refresh the page and try again.' USING ERRCODE = 'P0002', HINT = 'rfq_not_found';
  END IF;
  IF nullif(btrim(coalesce(v_rfq.email, '')), '') IS NULL THEN
    RAISE EXCEPTION 'This RFQ has no email address. Add one before sending.' USING ERRCODE = '22023', HINT = 'rfq_no_email';
  END IF;
  IF nullif(btrim(coalesce(p_subject, '')), '') IS NULL THEN
    RAISE EXCEPTION 'The e-mail needs a subject.' USING ERRCODE = '22023', HINT = 'rfq_email_subject';
  END IF;

  INSERT INTO public.email_history (organization_id, to_email, to_name, subject, body, status, related_to_type, related_to_id, drafted_by, sent_at)
  VALUES (v_org, btrim(v_rfq.email), v_rfq.customer, p_subject, p_body, 'sent_manually', 'rfq', v_rfq.id::TEXT, v_user, now())
  RETURNING id INTO v_history;

  -- Outstanding only (lib/rfq-stage.ts shouldMarkClarification): New or Ready, and no quote made from it.
  IF v_rfq.status IN ('new', 'ready')
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.rfq_id = v_rfq.id AND q.organization_id = v_org) THEN
    UPDATE public.rfqs SET status = 'clarification' WHERE id = v_rfq.id AND organization_id = v_org RETURNING * INTO v_rfq;
    v_moved := TRUE;
  END IF;

  RETURN jsonb_build_object('rfq', to_jsonb(v_rfq), 'moved', v_moved, 'email_history_id', v_history);
END
$$;
REVOKE ALL ON FUNCTION public.log_rfq_clarification(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_rfq_clarification(UUID, TEXT, TEXT) TO authenticated;
COMMENT ON FUNCTION public.log_rfq_clarification(UUID, TEXT, TEXT) IS
  '110: logs an RFQ clarification e-mail as sent manually and moves an outstanding RFQ to clarification, in one transaction.';

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: anything unexpected stops the release and nothing of 110 is kept.
DO $$
DECLARE
  v_fn REGPROCEDURE := to_regprocedure('public.log_rfq_clarification(uuid,text,text)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '110: log_rfq_clarification is missing';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION '110: log_rfq_clarification is not definer with search_path pg_catalog, public';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '110: log_rfq_clarification must be callable by signed-in users only';
  END IF;
END
$$;

COMMIT;
