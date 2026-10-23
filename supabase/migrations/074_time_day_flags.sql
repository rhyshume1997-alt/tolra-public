-- =====================================================================================================
-- 074: day flags on the daily job sheet (John, Sun 18 Oct 2026). The overtime rate for Sundays and bank holidays is not known yet, so
-- each person's day carries four tick boxes, "Overtime", "Saturday", "Sunday", "Bank holiday", ticked by the person or the office and
-- shown on the weekly approval with totals per type. FLAGS ONLY: no pay, no money, no multiplier is applied to anything here.
--
-- 1. time_day_flags: one row per company, person and day (local date, Europe/London) with the four booleans and who changed them last
--    and when. No row = nothing saved for that day (the app shows suggestions: Saturday, Sunday and Bank holiday from the date and the
--    company's bank holiday region (050); Overtime is never suggested, it is ticked by hand (John's pay rules); they are
--    stored only when someone saves them). Every change is in the audit log twice: the row change (log_row_change: old and new values,
--    who) and TIME_DAY_FLAGS_SET (person, day, before and after).
-- 2. time_day_flag_ops: the durable answer of every keyed save (client_op_id, unique per company): a retry or replay of the same key
--    answers the first result and changes nothing; the same key with a different request is refused (client_op_reused). No API role
--    reads or writes it.
-- 3. set_time_day_flags(key, person, day, overtime, saturday, sunday, bank_holiday): the person for their OWN days (admin, office,
--    workshop); office or admin for anyone in their company; workshop never for someone else; viewer never (050's time_caller_org).
--    The day: not in the future (London), not before 2020. The person must be a member of the caller's company (P0002 not_member: so
--    another company's person is refused). The approved-week lock is 052's, exactly as for times: once the person's week has an
--    approval nobody but an admin may change its flags (42501, hint week_approved); an admin may, and the week then shows
--    'changed_since_approval' (below). LOCK ORDER as every other write of hours (050, 051 LOCK ORDER): 050's attendance_lock (the
--    company's audit-chain lock, time_company_lock, then the person's 'attendance:<org>:<user>' lock), the same locks approve_time_week
--    holds; the key's replay and whether the week is approved are asked only once they are held. So a save and an approval of the same
--    person never cross and never deadlock: either the approval commits first and the save is refused (week_approved), or the save
--    commits first and the approval's revision includes it (the approver's older revision is stale_revision).
-- 4. time_week_revision (052's, replaced): the same fingerprint plus the saved flags of the week's seven days. A week with no saved
--    flags has exactly 052's revision (nothing is appended), so approvals made before 074 stay 'approved'; saving flags afterwards
--    changes the revision, so an approved week shows 'changed_since_approval' until it is approved again.
--
-- Read: each person their own rows (admin, office, workshop); admin and office the company's; viewer none. No direct client writes.
-- SECURITY DEFINER, pinned search_path, assert_privileged_aal() (two-step sign-in where the company requires it), the caller's company
-- and role checked first. Support read-only and admin two-step triggers as 050. Additive: two tables, two functions (one callable by
-- signed-in members, one internal replaced: time_week_revision, 052's). Forward only, safe to run more than once. Needs 050, 051, 052.
-- Rollback: docs/RELEASE.md "Migration 074".
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.time_day_flags (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  day             DATE NOT NULL CHECK (day >= DATE '2020-01-01'),
  id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  overtime        BOOLEAN NOT NULL DEFAULT FALSE,
  saturday        BOOLEAN NOT NULL DEFAULT FALSE,
  sunday          BOOLEAN NOT NULL DEFAULT FALSE,
  bank_holiday    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_time_day_flags_org_day ON public.time_day_flags (organization_id, day);

ALTER TABLE public.time_day_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "time_day_flags rbac select" ON public.time_day_flags;
CREATE POLICY "time_day_flags rbac select" ON public.time_day_flags FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.time_day_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.time_day_flags TO authenticated;

DROP TRIGGER IF EXISTS audit_time_day_flags_changes ON public.time_day_flags;
CREATE TRIGGER audit_time_day_flags_changes AFTER INSERT OR UPDATE OR DELETE ON public.time_day_flags
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.time_day_flags;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.time_day_flags
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.time_day_flags;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.time_day_flags
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- The durable answer of every keyed save. No API role reads or writes it.
CREATE TABLE IF NOT EXISTS public.time_day_flag_ops (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  client_op_id    UUID NOT NULL,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  day             DATE NOT NULL,
  request         JSONB NOT NULL,
  result          JSONB NOT NULL,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, client_op_id)
);
ALTER TABLE public.time_day_flag_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.time_day_flag_ops FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS support_read_only ON public.time_day_flag_ops;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.time_day_flag_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.time_day_flag_ops;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.time_day_flag_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- ---- The revision of a person's week (052's, plus the saved day flags) -------------------------------------------------------------
-- As 052: a fingerprint of the person's clock records and job time around the week and the company's settings that change the figures.
-- 074 appends the saved flags of the week's seven days ('#flags:' and one entry per saved day) ONLY when there are any, so a week with
-- none has 052's revision unchanged. Internal.
CREATE OR REPLACE FUNCTION public.time_week_revision(p_org UUID, p_user UUID, p_week DATE)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH w AS (
    SELECT (p_week::TIMESTAMP AT TIME ZONE 'Europe/London') - INTERVAL '24 hours' AS lo,
           ((p_week + 7)::TIMESTAMP AT TIME ZONE 'Europe/London') + INTERVAL '24 hours' AS hi
  )
  SELECT md5(
    coalesce((SELECT string_agg(concat_ws('|', e.id, e.action, e.at, e.supersedes), ';' ORDER BY e.id)
              FROM public.attendance_events e, w
              WHERE e.organization_id = p_org AND e.user_id = p_user AND e.at >= w.lo AND e.at < w.hi), '')
    || '#' ||
    coalesce((SELECT string_agg(concat_ws('|', s.id, s.job_id, s.started_at, s.ended_at, s.voided_at), ';' ORDER BY s.id)
              FROM public.operator_sessions s, w
              WHERE s.organization_id = p_org AND s.user_id = p_user AND s.started_at < w.hi AND (s.ended_at IS NULL OR s.ended_at > w.lo)), '')
    || '#' ||
    -- A company with no settings row yet has the defaults (050's column defaults): the same text, so saving them changes nothing.
    (SELECT concat_ws('|', coalesce(t.breaks_paid, FALSE), coalesce(t.lunch_minutes, 30), coalesce(t.break_minutes, 15),
                      coalesce(t.break_min_day_hours, 6::NUMERIC(4,2)), coalesce(t.daily_overtime_hours, 8::NUMERIC(4,2)),
                      coalesce(t.saturday_overtime, TRUE), coalesce(t.sunday_overtime, TRUE), coalesce(t.bank_holiday_overtime, TRUE),
                      coalesce(t.overtime_multiplier, 1.5::NUMERIC(3,2)), coalesce(t.bank_holiday_region, 'england-and-wales'))
     FROM (SELECT 1) d LEFT JOIN public.time_settings t ON t.organization_id = p_org)
    -- 074: the saved day flags of the week (none saved: nothing appended, 052's revision).
    || coalesce('#flags:' || (SELECT string_agg(concat_ws('|', f.day, f.overtime, f.saturday, f.sunday, f.bank_holiday), ';' ORDER BY f.day)
                              FROM public.time_day_flags f
                              WHERE f.organization_id = p_org AND f.user_id = p_user AND f.day >= p_week AND f.day < p_week + 7), ''))
$$;
REVOKE ALL ON FUNCTION public.time_week_revision(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ---- Save a day's flags -------------------------------------------------------------------------------------------------------------
-- p_user: whose day (NULL = the caller). p_day: the local date. The four flags: each TRUE or FALSE (all four are saved together, as
-- shown on the sheet). Same key, same request = the first answer (replayed TRUE).
CREATE OR REPLACE FUNCTION public.set_time_day_flags(p_client_op_id UUID, p_user UUID, p_day DATE, p_overtime BOOLEAN, p_saturday BOOLEAN,
                                                     p_sunday BOOLEAN, p_bank_holiday BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_org     UUID;
  v_user    UUID := coalesce(p_user, auth.uid());
  v_admin   BOOLEAN;
  v_request JSONB;
  v_op      public.time_day_flag_ops%ROWTYPE;
  v_old     public.time_day_flags%ROWTYPE;
  v_row     public.time_day_flags%ROWTYPE;
  v_changed BOOLEAN;
  v_result  JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  v_admin := public.has_org_role(ARRAY['admin']);
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'Saving the day''s ticks needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF v_user <> v_uid AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'You can only tick your own days.' USING ERRCODE = '42501', HINT = 'own_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_org AND m.user_id = v_user AND NOT m.support) THEN
    RAISE EXCEPTION 'That person is not in this company.' USING ERRCODE = 'P0002', HINT = 'not_member';
  END IF;
  IF p_overtime IS NULL OR p_saturday IS NULL OR p_sunday IS NULL OR p_bank_holiday IS NULL THEN
    RAISE EXCEPTION 'Each tick box needs a yes or no.' USING ERRCODE = '22023', HINT = 'bad_flags';
  END IF;
  IF p_day IS NULL OR p_day < DATE '2020-01-01' OR p_day > (now() AT TIME ZONE 'Europe/London')::DATE THEN
    RAISE EXCEPTION 'Choose a day that is not in the future.' USING ERRCODE = '22023', HINT = 'bad_day';
  END IF;
  v_request := jsonb_build_object('user_id', v_user, 'day', p_day, 'overtime', p_overtime, 'saturday', p_saturday, 'sunday', p_sunday,
                                  'bank_holiday', p_bank_holiday);
  -- 050's attendance_lock: the company's audit-chain lock, then the person's lock, the order every write of hours and approve_time_week
  -- take them in. Everything below (the replay, the approved-week check, the write and its audit rows) happens while they are held.
  PERFORM public.attendance_lock(v_org, v_user);
  SELECT * INTO v_op FROM public.time_day_flag_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_op.request = v_request THEN
      RETURN v_op.result || jsonb_build_object('replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'This save''s key was already used for something else. Try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  -- 052's lock, as for times, asked after the locks are held: an approved week is changed by an admin only (it then shows "changed since
  -- approval"). An approval that committed while this waited is seen here.
  IF NOT v_admin AND public.time_week_locked(v_org, v_user, p_day - (extract(isodow FROM p_day)::INT - 1)) THEN
    RAISE EXCEPTION 'That week has been approved. Ask an admin to change it.' USING ERRCODE = '42501', HINT = 'week_approved';
  END IF;
  SELECT * INTO v_old FROM public.time_day_flags f WHERE f.organization_id = v_org AND f.user_id = v_user AND f.day = p_day FOR UPDATE;
  v_changed := v_old.id IS NULL OR (v_old.overtime, v_old.saturday, v_old.sunday, v_old.bank_holiday) IS DISTINCT FROM (p_overtime, p_saturday, p_sunday, p_bank_holiday);
  IF v_old.id IS NULL THEN
    INSERT INTO public.time_day_flags (organization_id, user_id, day, overtime, saturday, sunday, bank_holiday, updated_by)
    VALUES (v_org, v_user, p_day, p_overtime, p_saturday, p_sunday, p_bank_holiday, v_uid)
    RETURNING * INTO v_row;
  ELSIF v_changed THEN
    UPDATE public.time_day_flags SET overtime = p_overtime, saturday = p_saturday, sunday = p_sunday, bank_holiday = p_bank_holiday,
                                     updated_by = v_uid, updated_at = clock_timestamp()
    WHERE organization_id = v_org AND user_id = v_user AND day = p_day
    RETURNING * INTO v_row;
  ELSE
    v_row := v_old;
  END IF;
  v_result := jsonb_build_object('user_id', v_row.user_id, 'day', v_row.day, 'overtime', v_row.overtime, 'saturday', v_row.saturday,
                                 'sunday', v_row.sunday, 'bank_holiday', v_row.bank_holiday, 'updated_by', v_row.updated_by,
                                 'updated_at', v_row.updated_at, 'changed', v_changed);
  INSERT INTO public.time_day_flag_ops (organization_id, client_op_id, user_id, day, request, result, created_by)
  VALUES (v_org, p_client_op_id, v_user, p_day, v_request, v_result, v_uid);
  IF v_changed THEN
    PERFORM security_audit.log_named_event(v_org, 'TIME_DAY_FLAGS_SET', 'time_day_flags', v_row.id::TEXT,
      jsonb_build_object('user_id', v_user, 'day', p_day,
                         'before', CASE WHEN v_old.id IS NULL THEN NULL
                                        ELSE jsonb_build_object('overtime', v_old.overtime, 'saturday', v_old.saturday, 'sunday', v_old.sunday, 'bank_holiday', v_old.bank_holiday) END,
                         'after', jsonb_build_object('overtime', p_overtime, 'saturday', p_saturday, 'sunday', p_sunday, 'bank_holiday', p_bank_holiday)));
  END IF;
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.set_time_day_flags(UUID, UUID, DATE, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_time_day_flags(UUID, UUID, DATE, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated;
