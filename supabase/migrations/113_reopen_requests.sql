-- =====================================================================================================
-- 113: reopen sign-off (Rhys, 30 Oct, D30-5: "Reopening needs a confirmation and counts as signed off with admin approval. If no
-- admin is available it can be a tick box that notifies the admin for later, so staff are never blamed either way."). Needs 033
-- (assert_privileged_aal, require_admin_mfa_guard), 036 (_session_membership, support_readonly_guard), 081 (reopen_job: every rule of
-- who may reopen what stays there, untouched), the audit log (000/035). Replaces NO existing object. Safe to run again.
--
-- WHAT IT ADDS. One table and three functions the app calls (one internal helper).
--   a. public.reopen_requests: one row per reopen sign-off: the record (record_type 'job'; 'quote' is reserved: quotes have no reopen
--      today, 020 keeps a decision final), who asked, when and why (10 to 500 characters), how it was approved (approval_mode
--      'admin_present' or 'tick_box_notify'), when the admin was told (notified_at), the decision (status pending / approved / rejected,
--      approved_by and approved_at, or rejected_by and rejected_at with an optional note), when the record was actually reopened
--      (reopened_at) and reopen_job's own answer (result).
--   b. reopen_record(record_type, record_id, reason, mode): the reopen and its request row in ONE transaction.
--        admin_present, the caller is an admin: reopen_job runs now; the row is approved by the caller.
--        admin_present, the caller is not an admin: nothing is reopened yet. reopen_job's rules are tried for the caller (inside a
--          savepoint that is always rolled back, so nothing of it is kept) and, if they pass, a pending row waits for an admin to
--          approve it with their OWN session (Approval Queue), as the early release (081 release_job_early) is an admin's own action.
--        tick_box_notify ("No admin available"), the caller is not an admin: reopen_job runs now; the row is pending with notified_at
--          set, for the admin to approve or reject after the fact (a rejection records the decision, it does not undo the reopen).
--      Every refusal of reopen_job (not finished, in rework, someone else's finish, passed inspection for the workshop, gone out on a
--      delivery note, invoiced) is reopen_job's own, unchanged: an issued invoice still refuses the reopen, so it is never changed.
--   c. reopen_preview(record_type, record_id): what the dialog shows before anything is done: the job number, issued invoice numbers,
--      whether a draft invoice is kept, delivery notes gone out, whether the caller is an admin, a request already waiting, and whether
--      reopen_job would accept the caller now (tried and rolled back, as above). Changes nothing.
--   d. decide_reopen_request(request, decision, note): an admin only, never their own request. approve: a waiting admin_present
--      request is reopened now by reopen_job under the admin's session (its rules checked again at that moment); a tick-box one is
--      just signed off. reject: the decision is recorded; a reopen already done is NOT undone (the work stays as it is).
--   Internal, no grant: _reopen_audit (one security_audit.audit_log row).
-- AUDIT. reopen_job writes the job's own REOPEN (job_flow_events, 035's activity) as before. These functions add, in the same
-- transaction, reopen_requested / reopen_approved / reopen_rejected to security_audit.audit_log (ids, mode, record type: no reason
-- text, no names). write_audit (the app's own path) is not changed, so a client can't write these names.
-- RLS. SELECT for every member of the company (organization_id = the caller's company). No INSERT, UPDATE or DELETE grant: only the
-- functions write, so a request row can never exist without reopen_job's rules having passed for the person who asked, and only an
-- admin's own session can approve. support_read_only and admin_mfa guard the table, as 101's do.
-- Verify: supabase/verify/reopen_requests_113.sql (every row TRUE). Rollback: supabase/release/113_reopen_requests.rollback.sql.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists.
DO $$
BEGIN
  IF to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public._session_membership()') IS NULL
     OR to_regprocedure('public.reopen_job(uuid,text)') IS NULL OR to_regclass('security_audit.audit_log') IS NULL
     OR to_regclass('public.jobs') IS NULL OR to_regclass('public.invoices') IS NULL OR to_regclass('public.delivery_notes') IS NULL THEN
    RAISE EXCEPTION '113: a function or table it needs (033, 036, 081 reopen_job, the audit log) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The table, row level security, grants and guards.
CREATE TABLE IF NOT EXISTS public.reopen_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  record_type     TEXT NOT NULL CONSTRAINT reopen_requests_record_type CHECK (record_type IN ('job', 'quote')),
  record_id       UUID NOT NULL,
  record_ref      TEXT CONSTRAINT reopen_requests_record_ref CHECK (record_ref IS NULL OR length(record_ref) <= 100),
  requested_by    UUID NOT NULL,
  reason          TEXT NOT NULL CONSTRAINT reopen_requests_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approval_mode   TEXT NOT NULL CONSTRAINT reopen_requests_mode CHECK (approval_mode IN ('admin_present', 'tick_box_notify')),
  notified_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending' CONSTRAINT reopen_requests_status CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  rejected_by     UUID,
  rejected_at     TIMESTAMPTZ,
  decision_note   TEXT CONSTRAINT reopen_requests_note CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  reopened_at     TIMESTAMPTZ,
  result          JSONB CONSTRAINT reopen_requests_result CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::TEXT) <= 4096)),
  -- The decision is whole: approved has its approver and time and no rejection; rejected the reverse; pending neither.
  CONSTRAINT reopen_requests_decision CHECK (
    (status = 'pending' AND approved_by IS NULL AND approved_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (status = 'rejected' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND approved_by IS NULL AND approved_at IS NULL)),
  -- A tick-box reopen is done at once and the admin is told; an approved request has always been reopened.
  CONSTRAINT reopen_requests_tick_box CHECK (approval_mode <> 'tick_box_notify' OR (reopened_at IS NOT NULL AND notified_at IS NOT NULL)),
  CONSTRAINT reopen_requests_approved_reopened CHECK (status <> 'approved' OR reopened_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_reopen_requests_org ON public.reopen_requests (organization_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_reopen_requests_pending ON public.reopen_requests (organization_id, requested_at) WHERE status = 'pending';
-- One request at a time waiting for an admin before anything is reopened, per record.
CREATE UNIQUE INDEX IF NOT EXISTS reopen_requests_one_waiting ON public.reopen_requests (record_type, record_id) WHERE status = 'pending' AND reopened_at IS NULL;

ALTER TABLE public.reopen_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reopen_requests member select" ON public.reopen_requests;
CREATE POLICY "reopen_requests member select" ON public.reopen_requests FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id());

REVOKE ALL ON public.reopen_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reopen_requests TO authenticated;

DROP TRIGGER IF EXISTS support_read_only ON public.reopen_requests;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.reopen_requests FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.reopen_requests;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.reopen_requests FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. The internal audit helper: one row in the caller's company, with the caller's id and e-mail; ids and mode only.
CREATE OR REPLACE FUNCTION public._reopen_audit(p_org UUID, p_action TEXT, p_request UUID, p_metadata JSONB)
RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (p_org, auth.uid(),
          coalesce(nullif(auth.jwt() ->> 'email', ''), (SELECT p.email FROM public.user_profiles p WHERE p.id = auth.uid())),
          p_action, 'reopen_requests', p_request::TEXT, coalesce(p_metadata, '{}'::JSONB) || jsonb_build_object('source', 'reopen_113'));
$$;
REVOKE ALL ON FUNCTION public._reopen_audit(UUID, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. The functions the app calls (each as the signed-in person, through their own session).

-- What the Reopen dialog shows first. Nothing is kept: reopen_job is tried for the caller inside a savepoint that is always rolled back.
CREATE OR REPLACE FUNCTION public.reopen_preview(p_record_type TEXT, p_record_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_job     RECORD;
  v_issued  TEXT[];
  v_draft   BOOLEAN;
  v_dn      TEXT[];
  v_allowed BOOLEAN := TRUE;
  v_message TEXT;
  v_hint    TEXT;
  v_waiting UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_record_type IS DISTINCT FROM 'job' THEN
    RAISE EXCEPTION 'Only a job can be reopened.' USING ERRCODE = '22023', HINT = 'not_reopenable';
  END IF;
  SELECT j.id, j.job_no INTO v_job FROM public.jobs j WHERE j.id = p_record_id AND j.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT coalesce(array_agg(coalesce(i.invoice_ref, 'an invoice') ORDER BY i.invoice_ref) FILTER (WHERE lower(coalesce(i.status, 'draft')) NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled')), '{}'),
         coalesce(bool_or(lower(coalesce(i.status, 'draft')) = 'draft'), FALSE)
    INTO v_issued, v_draft
  FROM public.invoices i WHERE i.job_id = p_record_id AND i.organization_id = v_org;
  SELECT coalesce(array_agg(d.dn_number ORDER BY d.dn_number), '{}') INTO v_dn FROM public.delivery_notes d
  WHERE d.organization_id = v_org AND d.status IN ('despatched', 'delivered', 'signed')
    AND (d.job_id = p_record_id OR (d.job_id IS NULL AND nullif(btrim(d.job_ref), '') = v_job.job_no));
  SELECT r.id INTO v_waiting FROM public.reopen_requests r
  WHERE r.organization_id = v_org AND r.record_type = 'job' AND r.record_id = p_record_id AND r.status = 'pending' AND r.reopened_at IS NULL;
  BEGIN
    PERFORM public.reopen_job(p_record_id, 'Reopen preview (rolled back)');
    RAISE EXCEPTION 'reopen preview' USING ERRCODE = 'RQ113';
  EXCEPTION
    WHEN SQLSTATE 'RQ113' THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
      v_allowed := FALSE;
  END;
  RETURN jsonb_build_object('record_type', 'job', 'record_id', p_record_id, 'record_ref', v_job.job_no,
    'issued_invoices', to_jsonb(v_issued), 'draft_invoice', v_draft, 'delivery_notes_out', to_jsonb(v_dn),
    'is_admin', public.has_org_role(ARRAY['admin']), 'waiting_request_id', v_waiting,
    'allowed', v_allowed AND v_waiting IS NULL,
    'refusal', CASE WHEN v_waiting IS NOT NULL THEN 'A reopen of ' || v_job.job_no || ' is already waiting for an admin to approve it.'
                    WHEN NOT v_allowed THEN left(v_message, 300) END,
    'refusal_hint', CASE WHEN v_waiting IS NOT NULL THEN 'reopen_waiting' WHEN NOT v_allowed THEN nullif(v_hint, '') END);
END
$$;

-- The reopen and its sign-off row, in one transaction. p_mode 'admin_present' or 'tick_box_notify' (see the header).
CREATE OR REPLACE FUNCTION public.reopen_record(p_record_type TEXT, p_record_id UUID, p_reason TEXT, p_mode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_reason TEXT := nullif(btrim(p_reason), '');
  v_admin  BOOLEAN;
  v_job    RECORD;
  v_result JSONB;
  v_id     UUID;
  v_status TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_record_type IS DISTINCT FROM 'job' THEN
    RAISE EXCEPTION 'Only a job can be reopened.' USING ERRCODE = '22023', HINT = 'not_reopenable';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('admin_present', 'tick_box_notify') THEN
    RAISE EXCEPTION 'Choose how the reopen is approved: an admin is here, or no admin is available.' USING ERRCODE = '22023', HINT = 'mode_required';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Say why the job is reopened (10 to 500 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  v_admin := public.has_org_role(ARRAY['admin']);
  IF p_mode = 'tick_box_notify' AND v_admin THEN
    RAISE EXCEPTION 'You are an admin: approve the reopen now.' USING ERRCODE = '22023', HINT = 'admin_approves_now';
  END IF;
  -- The job is locked first (reopen_job locks it again, in the same transaction), so two reopens of one job never interleave.
  SELECT j.id, j.job_no INTO v_job FROM public.jobs j WHERE j.id = p_record_id AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reopen_requests r WHERE r.organization_id = v_org AND r.record_type = 'job' AND r.record_id = p_record_id
             AND r.status = 'pending' AND r.reopened_at IS NULL) THEN
    RAISE EXCEPTION 'A reopen of % is already waiting for an admin to approve it.', v_job.job_no USING ERRCODE = '22023', HINT = 'reopen_waiting';
  END IF;

  IF p_mode = 'admin_present' AND NOT v_admin THEN
    -- Nothing is reopened until an admin approves with their own session; reopen_job's rules are checked for the caller now (rolled back).
    BEGIN
      PERFORM public.reopen_job(p_record_id, v_reason);
      RAISE EXCEPTION 'reopen check' USING ERRCODE = 'RQ113';
    EXCEPTION WHEN SQLSTATE 'RQ113' THEN NULL;
    END;
    INSERT INTO public.reopen_requests (organization_id, record_type, record_id, record_ref, requested_by, reason, approval_mode, notified_at, status)
    VALUES (v_org, 'job', p_record_id, v_job.job_no, v_user, v_reason, 'admin_present', now(), 'pending')
    RETURNING id INTO v_id;
    v_status := 'pending';
  ELSE
    v_result := public.reopen_job(p_record_id, v_reason);
    IF p_mode = 'admin_present' THEN
      INSERT INTO public.reopen_requests (organization_id, record_type, record_id, record_ref, requested_by, reason, approval_mode, status, approved_by, approved_at, reopened_at, result)
      VALUES (v_org, 'job', p_record_id, v_job.job_no, v_user, v_reason, 'admin_present', 'approved', v_user, now(), now(), v_result)
      RETURNING id INTO v_id;
      v_status := 'approved';
    ELSE
      INSERT INTO public.reopen_requests (organization_id, record_type, record_id, record_ref, requested_by, reason, approval_mode, notified_at, status, reopened_at, result)
      VALUES (v_org, 'job', p_record_id, v_job.job_no, v_user, v_reason, 'tick_box_notify', now(), 'pending', now(), v_result)
      RETURNING id INTO v_id;
      v_status := 'pending';
    END IF;
  END IF;
  PERFORM public._reopen_audit(v_org, CASE WHEN v_status = 'approved' THEN 'reopen_approved' ELSE 'reopen_requested' END, v_id,
    jsonb_build_object('record_type', 'job', 'record_id', p_record_id, 'approval_mode', p_mode, 'reopened', v_result IS NOT NULL));
  RETURN jsonb_build_object('request_id', v_id, 'status', v_status, 'approval_mode', p_mode, 'record_ref', v_job.job_no,
    'reopened', v_result IS NOT NULL, 'result', v_result);
END
$$;

-- An admin's decision on a pending request, with their own session (never their own request). See the header.
CREATE OR REPLACE FUNCTION public.decide_reopen_request(p_request UUID, p_decision TEXT, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_note   TEXT := nullif(btrim(p_note), '');
  v_req    public.reopen_requests%ROWTYPE;
  v_result JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can approve or reject a reopen.' USING ERRCODE = '42501', HINT = 'reopen_admin_only';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Choose approve or reject.' USING ERRCODE = '22023', HINT = 'decision_required';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note to 500 characters.' USING ERRCODE = '22023', HINT = 'note_too_long';
  END IF;
  SELECT * INTO v_req FROM public.reopen_requests r WHERE r.id = p_request AND r.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reopen request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'This reopen has already been %.', v_req.status USING ERRCODE = '22023', HINT = 'already_decided';
  END IF;
  IF v_req.requested_by = v_user THEN
    RAISE EXCEPTION 'Another admin has to decide on your own reopen.' USING ERRCODE = '42501', HINT = 'own_request';
  END IF;

  IF p_decision = 'approve' THEN
    IF v_req.reopened_at IS NULL THEN
      -- Waiting for this approval: reopen_job runs now under the admin's session, with its rules checked again at this moment.
      v_result := public.reopen_job(v_req.record_id, v_req.reason);
    END IF;
    UPDATE public.reopen_requests SET status = 'approved', approved_by = v_user, approved_at = now(), decision_note = v_note,
           reopened_at = coalesce(reopened_at, now()), result = coalesce(v_result, result)
    WHERE id = v_req.id;
  ELSE
    UPDATE public.reopen_requests SET status = 'rejected', rejected_by = v_user, rejected_at = now(), decision_note = v_note WHERE id = v_req.id;
  END IF;
  PERFORM public._reopen_audit(v_org, CASE WHEN p_decision = 'approve' THEN 'reopen_approved' ELSE 'reopen_rejected' END, v_req.id,
    jsonb_build_object('record_type', v_req.record_type, 'record_id', v_req.record_id, 'approval_mode', v_req.approval_mode,
                       'reopened_now', v_result IS NOT NULL, 'was_reopened', v_req.reopened_at IS NOT NULL));
  RETURN jsonb_build_object('request_id', v_req.id, 'status', CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
    'record_ref', v_req.record_ref, 'reopened_now', v_result IS NOT NULL,
    -- A rejection never undoes a reopen that was already done (the tick box): it records the decision only.
    'reopen_kept', p_decision = 'reject' AND v_req.reopened_at IS NOT NULL);
END
$$;

REVOKE ALL ON FUNCTION public.reopen_preview(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_record(TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_reopen_request(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_preview(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_record(TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_reopen_request(UUID, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check: RLS on, SELECT only, the three app functions definer, pinned and signed-in only, the audit helper callable by no one.
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.reopen_requests'::regclass) THEN
    RAISE EXCEPTION '113: row level security is off on reopen_requests';
  END IF;
  IF has_table_privilege('anon', 'public.reopen_requests', 'SELECT') OR has_table_privilege('authenticated', 'public.reopen_requests', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reopen_requests', 'UPDATE') OR has_table_privilege('authenticated', 'public.reopen_requests', 'DELETE') THEN
    RAISE EXCEPTION '113: reopen_requests grants more than SELECT';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.reopen_preview(text,uuid)', 'public.reopen_record(text,uuid,text,text)', 'public.decide_reopen_request(uuid,text,text)'] LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn))
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '113: % is not definer, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._reopen_audit(uuid,text,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '113: the internal reopen audit helper is callable';
  END IF;
END
$$;
