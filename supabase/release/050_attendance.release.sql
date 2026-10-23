-- 050_attendance.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 050: attendance (clock in and out, breaks) and the company's time settings. Time and pay plan, PR 1
-- (docs/plans/time-and-pay.md section 5; John's answers of Sun 18 Oct 2026 in section 7).
--
-- 1. time_settings: one row per company (missing row = the defaults below). Breaks UNPAID and deducted (John, Sun 18 Oct: confirmed),
--    as fixed allowances (30-minute lunch + 15-minute break) on any day with at least `break_min_day_hours` (6) of attendance, unless
--    breaks were clocked that day (then the clocked break time is deducted instead). Overtime: paid hours over `daily_overtime_hours` (8)
--    a day, and every hour on a Saturday, at `overtime_multiplier` (1.5). Sunday and bank holidays (not stated by JNR): all overtime by
--    default, each a setting. Who may approve a week: `approver_roles` (default admin only; office can be added, admin always stays).
--    The arithmetic is done in the app (lib/time-sheet.ts) from the recorded facts below; the database stores facts and settings only.
--    No pay rates and no money: the multiplier is a label for the accountant, never multiplied by anything here.
-- 2. bank_holidays: the published UK bank holidays by region (England and Wales seeded for 2026 and 2027). Read-only to the API.
-- 3. attendance_events: what the person did, never changed or removed. One row per clock action (in, out, break start, break end)
--    sent with the device's key (client_op_id, unique per company): a replay returns the first answer and records nothing new, whichever
--    device sends it, in whatever order. Device time kept (device_at); the time used (at) is the device time unless it is in the
--    future (then now) or older than 14 days (refused, hint time_too_old). Sessions are NOT stored: the app pairs a person's events by
--    their time (lib/time-sheet.ts), so a clock-out that arrives before its clock-in (two devices, one offline) pairs up when the
--    clock-in arrives, nothing is guessed and nothing is overwritten. Corrections are new rows that name the row they replace
--    (supersedes; one replacement per row) or void it (action 'void'), with a reason; the original stays.
-- 4. record_attendance_event(key, action, time, device): the person's own clock action. correct_attendance_event(key, user, supersedes,
--    action, time, reason): add a missing action, replace or void one. The person may correct their own; anyone else's needs an admin.
--    A person can't change a week that has been approved (time_week_locked, replaced by 052); an admin can, and 052 then shows the
--    week as "changed since approval". A clock action of the person's own (not an admin's) is refused when its time falls in an
--    approved week before that approval was made (time_week_locked_at, replaced by 052): a device can't back-date time into hours John
--    has already approved; clocking on after the approval is recorded and the week shows "changed since approval".
-- 5. save_time_settings(settings): admins only.
--
-- Read: each person their own events (admin, office, workshop); admin and office the whole company. Viewer: none. No direct client
-- writes (no insert, update or delete grant): every write goes through the functions, which check the caller's company and role first
-- (SECURITY DEFINER, pinned search_path, assert_privileged_aal()). Support read-only and admin two-step triggers as 044.
-- Lock order (attendance_lock): the company's audit-chain lock (time_company_lock: the key security_audit.set_audit_hash, 006, takes
-- for every audit row and holds to commit), then a per-person advisory lock 'attendance:<org>:<user>'. Every write of hours (050, 051)
-- and approve_time_week (052) takes the company lock BEFORE its per-person lock, and each of them writes an audit row afterwards
-- anyway: one order everywhere, so an approval and a clock or labour write can't deadlock (051 LOCK ORDER). Attendance never takes the
-- company job lock, and labour (051) never takes the attendance lock.
--
-- Additive: three tables, twelve functions (three callable by signed-in members, nine internal); nothing existing changes. Forward only, safe to run
-- more than once.
-- Rollback: docs/RELEASE.md "Migration 050".
-- =====================================================================================================

-- ---- 1. Settings --------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.time_settings (
  organization_id       UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  id                    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  breaks_paid           BOOLEAN NOT NULL DEFAULT FALSE,
  lunch_minutes         INTEGER NOT NULL DEFAULT 30 CHECK (lunch_minutes BETWEEN 0 AND 240),
  break_minutes         INTEGER NOT NULL DEFAULT 15 CHECK (break_minutes BETWEEN 0 AND 240),
  break_min_day_hours   NUMERIC(4,2) NOT NULL DEFAULT 6 CHECK (break_min_day_hours BETWEEN 0 AND 24),
  daily_overtime_hours  NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (daily_overtime_hours BETWEEN 0 AND 24),
  saturday_overtime     BOOLEAN NOT NULL DEFAULT TRUE,
  sunday_overtime       BOOLEAN NOT NULL DEFAULT TRUE,
  bank_holiday_overtime BOOLEAN NOT NULL DEFAULT TRUE,
  overtime_multiplier   NUMERIC(3,2) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier BETWEEN 1 AND 3),
  bank_holiday_region   TEXT NOT NULL DEFAULT 'england-and-wales' CHECK (bank_holiday_region IN ('england-and-wales', 'scotland', 'northern-ireland')),
  approver_roles        TEXT[] NOT NULL DEFAULT ARRAY['admin']::TEXT[]
                        CHECK (approver_roles <@ ARRAY['admin', 'office']::TEXT[] AND 'admin' = ANY (approver_roles)),
  long_session_hours    NUMERIC(4,2) NOT NULL DEFAULT 14 CHECK (long_session_hours BETWEEN 4 AND 48),
  time_zone             TEXT NOT NULL DEFAULT 'Europe/London' CHECK (time_zone = 'Europe/London'),
  updated_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.time_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "time_settings rbac select" ON public.time_settings;
CREATE POLICY "time_settings rbac select" ON public.time_settings FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));
REVOKE ALL ON public.time_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.time_settings TO authenticated;
DROP TRIGGER IF EXISTS audit_time_settings_changes ON public.time_settings;
CREATE TRIGGER audit_time_settings_changes AFTER INSERT OR UPDATE OR DELETE ON public.time_settings
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.time_settings;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.time_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.time_settings;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.time_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- ---- 2. Bank holidays (published dates; not company data) -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_holidays (
  region TEXT NOT NULL CHECK (region IN ('england-and-wales', 'scotland', 'northern-ireland')),
  day    DATE NOT NULL,
  name   TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  PRIMARY KEY (region, day)
);
ALTER TABLE public.bank_holidays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bank_holidays read" ON public.bank_holidays;
CREATE POLICY "bank_holidays read" ON public.bank_holidays FOR SELECT TO authenticated USING (TRUE);
REVOKE ALL ON public.bank_holidays FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bank_holidays TO authenticated;
-- England and Wales, 2026 and 2027 (gov.uk/bank-holidays). Later years: a later migration adds them.
INSERT INTO public.bank_holidays (region, day, name) VALUES
  ('england-and-wales', DATE '2026-01-01', 'New Year''s Day'),
  ('england-and-wales', DATE '2026-04-03', 'Good Friday'),
  ('england-and-wales', DATE '2026-04-06', 'Easter Monday'),
  ('england-and-wales', DATE '2026-05-04', 'Early May bank holiday'),
  ('england-and-wales', DATE '2026-05-25', 'Spring bank holiday'),
  ('england-and-wales', DATE '2026-08-31', 'Summer bank holiday'),
  ('england-and-wales', DATE '2026-12-25', 'Christmas Day'),
  ('england-and-wales', DATE '2026-12-28', 'Boxing Day (substitute day)'),
  ('england-and-wales', DATE '2027-01-01', 'New Year''s Day'),
  ('england-and-wales', DATE '2027-03-26', 'Good Friday'),
  ('england-and-wales', DATE '2027-03-29', 'Easter Monday'),
  ('england-and-wales', DATE '2027-05-03', 'Early May bank holiday'),
  ('england-and-wales', DATE '2027-05-31', 'Spring bank holiday'),
  ('england-and-wales', DATE '2027-08-30', 'Summer bank holiday'),
  ('england-and-wales', DATE '2027-12-27', 'Christmas Day (substitute day)'),
  ('england-and-wales', DATE '2027-12-28', 'Boxing Day (substitute day)')
ON CONFLICT (region, day) DO NOTHING;

-- ---- 3. Attendance events -----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_op_id    UUID NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('in', 'out', 'break_start', 'break_end', 'void')),
  at              TIMESTAMPTZ NOT NULL,
  device_at       TIMESTAMPTZ,
  source          TEXT NOT NULL CHECK (source IN ('clock', 'correction')),
  supersedes      UUID REFERENCES public.attendance_events(id) ON DELETE RESTRICT,
  reason          TEXT,
  device_label    TEXT CHECK (device_label IS NULL OR length(device_label) <= 80),
  recorded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT attendance_events_client_op UNIQUE (organization_id, client_op_id),
  CONSTRAINT attendance_events_void_names_row CHECK (action <> 'void' OR supersedes IS NOT NULL),
  CONSTRAINT attendance_events_correction_reason CHECK (source = 'clock' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 3 AND 500)),
  CONSTRAINT attendance_events_clock_shape CHECK (source = 'correction' OR (supersedes IS NULL AND action <> 'void'))
);
-- One replacement per row: a second correction of the same action must correct the replacement.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_events_one_replacement ON public.attendance_events (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_events_person_at ON public.attendance_events (organization_id, user_id, at);
CREATE INDEX IF NOT EXISTS idx_attendance_events_org_at ON public.attendance_events (organization_id, at);

ALTER TABLE public.attendance_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance_events rbac select" ON public.attendance_events;
CREATE POLICY "attendance_events rbac select" ON public.attendance_events FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.attendance_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.attendance_events TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_supersedes ON public.attendance_events;
CREATE TRIGGER zz_same_org_supersedes BEFORE INSERT OR UPDATE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('attendance_events', 'supersedes');
DROP TRIGGER IF EXISTS audit_attendance_events_changes ON public.attendance_events;
CREATE TRIGGER audit_attendance_events_changes AFTER INSERT OR UPDATE OR DELETE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.attendance_events;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.attendance_events;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- A recorded action is never changed or removed, by anyone (the API has no grant; this also stops definer code and the SQL editor).
-- A correction is a new row. (Disposable test databases are cleared in replica mode, where this trigger does not fire.)
CREATE OR REPLACE FUNCTION public.attendance_events_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'A clock record is never changed or removed. Record a correction instead.' USING ERRCODE = '42501', HINT = 'attendance_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.attendance_events_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS attendance_events_immutable ON public.attendance_events;
CREATE TRIGGER attendance_events_immutable BEFORE UPDATE OR DELETE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.attendance_events_immutable();
DROP TRIGGER IF EXISTS attendance_events_no_truncate ON public.attendance_events;
CREATE TRIGGER attendance_events_no_truncate BEFORE TRUNCATE ON public.attendance_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.attendance_events_immutable();

-- ---- 4. Shared pieces ---------------------------------------------------------------------------------------------------------
-- The Monday (local date, Europe/London) of the week an instant falls in. Weeks run Monday 00:00 to Monday 00:00 local time.
CREATE OR REPLACE FUNCTION public.time_week_of(p_at TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'Europe/London'))::DATE
$$;
REVOKE ALL ON FUNCTION public.time_week_of(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- TRUE when that person's week may no longer be changed by the person themselves (approved). 050 has no approvals yet: never locked.
-- Replaced by 052 (time_week_approvals). Internal.
CREATE OR REPLACE FUNCTION public.time_week_locked(p_org UUID, p_user UUID, p_week DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT FALSE
$$;
REVOKE ALL ON FUNCTION public.time_week_locked(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- TRUE when an instant falls in that person's approved week AND before the approval (time already reviewed): a live clock action or job
-- Start/Stop of the person's own may not be recorded there. 050: never. Replaced by 052. Internal.
CREATE OR REPLACE FUNCTION public.time_week_locked_at(p_org UUID, p_user UUID, p_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT FALSE
$$;
REVOKE ALL ON FUNCTION public.time_week_locked_at(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- A time sent by a device for a clock action: now when missing or in the future; refused when older than 14 days (a pay record should
-- not arrive weeks late without someone looking at it: an admin can still record it as a correction).
CREATE OR REPLACE FUNCTION public.attendance_client_time(p_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_at IS NULL OR p_at > now() THEN
    RETURN now();
  END IF;
  IF p_at < now() - INTERVAL '14 days' THEN
    RAISE EXCEPTION 'That time is more than 14 days ago. Check the device''s clock, or ask an admin to record it as a correction.'
      USING ERRCODE = '22023', HINT = 'time_too_old';
  END IF;
  RETURN p_at;
END
$$;
REVOKE ALL ON FUNCTION public.attendance_client_time(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- The company's audit-chain lock: security_audit.set_audit_hash (006) takes this key for every audit row a company writes and holds it
-- to commit. Every write of hours and approve_time_week take it FIRST, before any per-person lock, because each of them writes an audit
-- row later on: taking it first keeps one lock order (company, then person) and no two of them can deadlock. Internal.
CREATE OR REPLACE FUNCTION public.time_company_lock(p_org UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  SELECT pg_advisory_xact_lock(hashtext(coalesce(p_org::TEXT, '')))
$$;
REVOKE ALL ON FUNCTION public.time_company_lock(UUID) FROM PUBLIC, anon, authenticated;

-- A person's clock records can't change while this is held (record_attendance_event, correct_attendance_event, approve_time_week):
-- the company lock, then 'attendance:<org>:<user>'. Internal.
CREATE OR REPLACE FUNCTION public.attendance_lock(p_org UUID, p_user UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  SELECT public.time_company_lock(p_org);
  SELECT pg_advisory_xact_lock(hashtextextended('attendance:' || p_org::TEXT || ':' || p_user::TEXT, 0));
$$;
REVOKE ALL ON FUNCTION public.attendance_lock(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- The caller's company and role, checked the same way by every time function: signed in, a current company, not a viewer. Returns
-- the company. Internal.
CREATE OR REPLACE FUNCTION public.time_caller_org()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'You don''t have access to time records.' USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public.time_caller_org() FROM PUBLIC, anon, authenticated;

-- The answer a clock action gives (and gives again on a replay): the stored row, not the request.
CREATE OR REPLACE FUNCTION public.attendance_answer(p_event public.attendance_events, p_replayed BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('event_id', p_event.id, 'user_id', p_event.user_id, 'action', p_event.action, 'at', p_event.at,
                            'device_at', p_event.device_at, 'time_adjusted', p_event.device_at IS DISTINCT FROM p_event.at,
                            'source', p_event.source, 'supersedes', p_event.supersedes, 'received_at', p_event.received_at,
                            'replayed', p_replayed)
$$;
REVOKE ALL ON FUNCTION public.attendance_answer(public.attendance_events, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ---- 5. Clock in, clock out, breaks (the person's own) --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_attendance_event(p_client_op_id UUID, p_action TEXT, p_at TIMESTAMPTZ, p_device TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_row public.attendance_events%ROWTYPE;
  v_at  TIMESTAMPTZ;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'A clock action needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('in', 'out', 'break_start', 'break_end') THEN
    RAISE EXCEPTION 'Unknown clock action.' USING ERRCODE = '22023', HINT = 'bad_action';
  END IF;
  PERFORM public.attendance_lock(v_org, v_uid);
  SELECT * INTO v_row FROM public.attendance_events e WHERE e.organization_id = v_org AND e.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_row.user_id = v_uid AND v_row.action = p_action AND v_row.source = 'clock' THEN
      RETURN public.attendance_answer(v_row, TRUE);
    END IF;
    RAISE EXCEPTION 'This clock action''s key was already used for something else. Try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  v_at := public.attendance_client_time(p_at);
  -- Not into hours already approved (an admin may: they can correct anything).
  IF NOT public.has_org_role(ARRAY['admin']) AND public.time_week_locked_at(v_org, v_uid, v_at) THEN
    RAISE EXCEPTION 'That time is in a week that has already been approved. Ask an admin to add it.' USING ERRCODE = '42501', HINT = 'week_approved';
  END IF;
  INSERT INTO public.attendance_events (organization_id, user_id, client_op_id, action, at, device_at, source, device_label, recorded_by)
  VALUES (v_org, v_uid, p_client_op_id, p_action, v_at, p_at, 'clock', left(nullif(btrim(p_device), ''), 80), v_uid)
  RETURNING * INTO v_row;
  RETURN public.attendance_answer(v_row, FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.record_attendance_event(UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_attendance_event(UUID, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;

-- ---- 6. Corrections: add a missing action, replace one, or void one --------------------------------------------------------------
-- p_user: whose record (NULL = the caller). Someone else's needs an admin. The person themselves may correct their own record until
-- the week is approved (time_week_locked); after that only an admin. p_supersedes: the row replaced (or voided, p_action 'void');
-- NULL adds a missing action. p_at: not in the future. p_reason: 3 to 500 characters. Same key = same answer.
CREATE OR REPLACE FUNCTION public.correct_attendance_event(p_client_op_id UUID, p_user UUID, p_supersedes UUID, p_action TEXT, p_at TIMESTAMPTZ, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID;
  v_user   UUID := coalesce(p_user, auth.uid());
  v_admin  BOOLEAN;
  v_old    public.attendance_events%ROWTYPE;
  v_row    public.attendance_events%ROWTYPE;
  v_at     TIMESTAMPTZ;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  v_admin := public.has_org_role(ARRAY['admin']);
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'A correction needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF v_user <> v_uid AND NOT v_admin THEN
    RAISE EXCEPTION 'Only an admin can correct someone else''s hours.' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_org AND m.user_id = v_user AND NOT m.support) THEN
    RAISE EXCEPTION 'That person is not in this company.' USING ERRCODE = 'P0002', HINT = 'not_member';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('in', 'out', 'break_start', 'break_end', 'void') THEN
    RAISE EXCEPTION 'Unknown clock action.' USING ERRCODE = '22023', HINT = 'bad_action';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Give a reason for the correction (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  PERFORM public.attendance_lock(v_org, v_user);
  SELECT * INTO v_row FROM public.attendance_events e WHERE e.organization_id = v_org AND e.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_row.user_id = v_user AND v_row.action = p_action AND v_row.source = 'correction' AND v_row.supersedes IS NOT DISTINCT FROM p_supersedes THEN
      RETURN public.attendance_answer(v_row, TRUE);
    END IF;
    RAISE EXCEPTION 'This correction''s key was already used for something else. Try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  IF p_supersedes IS NOT NULL THEN
    SELECT * INTO v_old FROM public.attendance_events e WHERE e.id = p_supersedes AND e.organization_id = v_org AND e.user_id = v_user;
    IF NOT FOUND OR v_old.action = 'void' THEN
      RAISE EXCEPTION 'That clock record was not found.' USING ERRCODE = 'P0002', HINT = 'event_missing';
    END IF;
    IF EXISTS (SELECT 1 FROM public.attendance_events e WHERE e.supersedes = v_old.id) THEN
      RAISE EXCEPTION 'That clock record has already been corrected. Correct the newer record instead.' USING ERRCODE = '23505', HINT = 'already_corrected';
    END IF;
  ELSIF p_action = 'void' THEN
    RAISE EXCEPTION 'Say which clock record to remove.' USING ERRCODE = '22023', HINT = 'bad_action';
  END IF;
  v_at := CASE WHEN p_action = 'void' THEN v_old.at ELSE p_at END;
  IF v_at IS NULL OR v_at > now() + INTERVAL '1 minute' OR v_at < TIMESTAMPTZ '2020-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'Give a time that is not in the future.' USING ERRCODE = '22023', HINT = 'bad_time';
  END IF;
  -- The person's own week (the new time's, and the replaced record's) must still be open; an admin may change any week.
  IF NOT v_admin AND (public.time_week_locked(v_org, v_user, public.time_week_of(v_at))
                      OR (v_old.id IS NOT NULL AND public.time_week_locked(v_org, v_user, public.time_week_of(v_old.at)))) THEN
    RAISE EXCEPTION 'That week has been approved. Ask an admin to correct it.' USING ERRCODE = '42501', HINT = 'week_approved';
  END IF;
  INSERT INTO public.attendance_events (organization_id, user_id, client_op_id, action, at, device_at, source, supersedes, reason, recorded_by)
  VALUES (v_org, v_user, p_client_op_id, p_action, v_at, NULL, 'correction', p_supersedes, btrim(p_reason), v_uid)
  RETURNING * INTO v_row;
  PERFORM security_audit.log_named_event(v_org, 'ATTENDANCE_CORRECTED', 'attendance_events', v_row.id::TEXT,
    jsonb_build_object('user_id', v_user, 'action', p_action, 'at', v_at, 'supersedes', p_supersedes,
                       'replaced_action', v_old.action, 'replaced_at', v_old.at, 'reason', btrim(p_reason)));
  RETURN public.attendance_answer(v_row, FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.correct_attendance_event(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_attendance_event(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;

-- ---- 7. Settings (admins) ---------------------------------------------------------------------------------------------------------
-- p_settings: any of the time_settings fields above (others are ignored); missing fields keep their current value (or the default).
CREATE OR REPLACE FUNCTION public.save_time_settings(p_settings JSONB)
RETURNS public.time_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
  v_cur public.time_settings%ROWTYPE;
  v_row public.time_settings%ROWTYPE;
  s     JSONB := coalesce(p_settings, '{}'::JSONB);
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can change the time settings.' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  IF jsonb_typeof(s) <> 'object' THEN
    RAISE EXCEPTION 'Settings must be an object.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.time_settings (organization_id) VALUES (v_org) ON CONFLICT (organization_id) DO NOTHING;
  SELECT * INTO v_cur FROM public.time_settings WHERE organization_id = v_org FOR UPDATE;
  UPDATE public.time_settings SET
    breaks_paid           = coalesce((s ->> 'breaks_paid')::BOOLEAN, v_cur.breaks_paid),
    lunch_minutes         = coalesce((s ->> 'lunch_minutes')::INTEGER, v_cur.lunch_minutes),
    break_minutes         = coalesce((s ->> 'break_minutes')::INTEGER, v_cur.break_minutes),
    break_min_day_hours   = coalesce((s ->> 'break_min_day_hours')::NUMERIC, v_cur.break_min_day_hours),
    daily_overtime_hours  = coalesce((s ->> 'daily_overtime_hours')::NUMERIC, v_cur.daily_overtime_hours),
    saturday_overtime     = coalesce((s ->> 'saturday_overtime')::BOOLEAN, v_cur.saturday_overtime),
    sunday_overtime       = coalesce((s ->> 'sunday_overtime')::BOOLEAN, v_cur.sunday_overtime),
    bank_holiday_overtime = coalesce((s ->> 'bank_holiday_overtime')::BOOLEAN, v_cur.bank_holiday_overtime),
    overtime_multiplier   = coalesce((s ->> 'overtime_multiplier')::NUMERIC, v_cur.overtime_multiplier),
    bank_holiday_region   = coalesce(s ->> 'bank_holiday_region', v_cur.bank_holiday_region),
    approver_roles        = coalesce(CASE WHEN jsonb_typeof(s -> 'approver_roles') = 'array'
                                          THEN ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(s -> 'approver_roles') x ORDER BY 1) END, v_cur.approver_roles),
    long_session_hours    = coalesce((s ->> 'long_session_hours')::NUMERIC, v_cur.long_session_hours),
    updated_by = auth.uid(),
    updated_at = now()
  WHERE organization_id = v_org
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.save_time_settings(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_time_settings(JSONB) TO authenticated;

COMMIT;
