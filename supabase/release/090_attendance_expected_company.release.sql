-- 090_attendance_expected_company.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 090: a clock action is recorded only in the company it was made in (security audit OFFLINE-ORG: Grok round 1, MEDIUM; Astra).
-- Applies after 085 and 084 (in either order); independent of 086 to 089. Needs only 036 (the session's company) and 050
-- (attendance_events, record_attendance_event).
--
-- WHY. switch_organization (036) changes the company of the SESSION (security_audit.session_company, keyed by the JWT session_id),
-- and every open tab of the app shares that session. 050's record_attendance_event takes no company: it files the action in the
-- session's company at the moment it runs (time_caller_org()). A clock action made (or queued offline) in company A and sent after
-- another tab switched the session to company B was therefore recorded in B, and the app counted it as synced. The job actions
-- (labour, machine runs, finish, sign-off, inspection, photos, job edits) already look their job up in the session's company and are
-- refused there; a clock action has no target row, so only the company it was made in can tell.
--
-- WHAT CHANGES. One new function, public.record_attendance_event_in_company(p_client_op_id, p_action, p_at, p_device, p_expected_org)
-- (SECURITY DEFINER, search_path pg_catalog, public; EXECUTE for authenticated, as 050's): refuses (42501, hint wrong_company) unless the
-- session's company is p_expected_org, then runs 050's function unchanged, and refuses again (rolling the insert back) unless the
-- event it answers with is in p_expected_org: a switch committed between the check and 050's own read of the company cannot file the
-- action in the other company. A NULL p_expected_org is refused (22023, hint expected_org_missing). The app sends the company it made
-- the action in and keeps a refused one queued (lib/offline/sync.ts), never dropped.
-- UNCHANGED: 050's four-argument record_attendance_event (body, grants), so an app build from before 090 keeps working exactly as
-- today; every table, policy, trigger and grant. A new name, not an overload of 050's: no two callable functions share a name
-- (tests/db/definer-functions.test.ts), and PostgREST never has to choose between them.
-- GUARD (section 1): 050's function must be there, and 090's, if present, must be 090's (md5 with every whitespace character
-- removed). Safe to run again. Rollback: supabase/release/090_attendance_expected_company.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 090 builds on is there, and its own function, if present, is 090's.
DO $$
BEGIN
  IF to_regprocedure('public.record_attendance_event(uuid,text,timestamp with time zone,text)') IS NULL
     OR to_regclass('public.attendance_events') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL THEN
    RAISE EXCEPTION '090: 050''s record_attendance_event / attendance_events or 036''s current_user_organization_id() is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b27723bfaaf334678d8d23bb1c1f0756') THEN
    RAISE EXCEPTION '090: public.record_attendance_event_in_company() already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The function.
CREATE OR REPLACE FUNCTION public.record_attendance_event_in_company(p_client_op_id UUID, p_action TEXT, p_at TIMESTAMPTZ, p_device TEXT, p_expected_org UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_answer JSONB;
  v_org    UUID;
BEGIN
  IF p_expected_org IS NULL THEN
    RAISE EXCEPTION 'A clock action needs the company it was made in.' USING ERRCODE = '22023', HINT = 'expected_org_missing';
  END IF;
  IF public.current_user_organization_id() IS DISTINCT FROM p_expected_org THEN
    RAISE EXCEPTION 'This clock action was made in another company than the one you are working in now, so it was not recorded.'
      USING ERRCODE = '42501', HINT = 'wrong_company';
  END IF;
  v_answer := public.record_attendance_event(p_client_op_id, p_action, p_at, p_device);
  -- The company may have changed between the check above and 050's own read of it: the row it answers with decides.
  SELECT e.organization_id INTO v_org FROM public.attendance_events e WHERE e.id = (v_answer ->> 'event_id')::UUID;
  IF v_org IS DISTINCT FROM p_expected_org THEN
    RAISE EXCEPTION 'This clock action was made in another company than the one you are working in now, so it was not recorded.'
      USING ERRCODE = '42501', HINT = 'wrong_company';
  END IF;
  RETURN v_answer;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2b. Who may call it: signed-in users, not anon. (Its own section so the upgrade rehearsal's mid-file failure point, the middle
-- "-- -----" break, falls after the function is created: the rehearsal needs an object above that point to prove the rollback with.)
REVOKE ALL ON FUNCTION public.record_attendance_event_in_company(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_attendance_event_in_company(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: the function is 090's, a definer with a fixed search_path, callable by authenticated and not by anon;
-- 050's four-argument function is still there and still callable.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)')) IS DISTINCT FROM 'b27723bfaaf334678d8d23bb1c1f0756'
     OR NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)')) THEN
    RAISE EXCEPTION '090: record_attendance_event_in_company() is not 090''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.record_attendance_event(uuid,text,timestamp with time zone,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '090: the clock action functions do not have the expected grants';
  END IF;
END
$$;

COMMIT;
