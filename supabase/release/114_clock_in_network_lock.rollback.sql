-- 114 rollback: ONLY with Rhys's approval. Removes the clock-in network lock: the two triggers on attendance_events, the five functions
-- and the three tables. Every company's lock, every off-site exception and every network_unverified mark go with them; clock-in is then unlocked everywhere (as
-- before 114: 075's flag check, if on, keeps working, unchanged). Clock actions themselves are untouched. Audit rows already written stay
-- (the audit log is append-only). Nothing else is touched: 114 replaced no existing object. Run the whole text as one transaction, then
-- the release preflight (marker 114 shows "not applied").
BEGIN;

DROP TRIGGER IF EXISTS clock_in_network_lock ON public.attendance_events;
DROP TRIGGER IF EXISTS zz_clock_in_network_unverified ON public.attendance_events;
DROP FUNCTION IF EXISTS public.set_clock_in_off_site_allowed(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.unlock_clock_in_network();
DROP FUNCTION IF EXISTS public.lock_clock_in_network();
DROP FUNCTION IF EXISTS public.clock_in_network_unverified_record();
DROP FUNCTION IF EXISTS public.clock_in_network_lock_check();
DROP TABLE IF EXISTS public.clock_in_network_unverified;
DROP TABLE IF EXISTS public.clock_in_network_exemptions;
DROP TABLE IF EXISTS public.clock_in_network_locks;

DO $$
BEGIN
  IF to_regclass('public.clock_in_network_locks') IS NOT NULL OR to_regclass('public.clock_in_network_unverified') IS NOT NULL
     OR to_regclass('public.clock_in_network_exemptions') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.attendance_events'::regclass AND tgname IN ('clock_in_network_lock', 'zz_clock_in_network_unverified'))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('lock_clock_in_network', 'unlock_clock_in_network', 'set_clock_in_off_site_allowed', 'clock_in_network_lock_check', 'clock_in_network_unverified_record')) THEN
    RAISE EXCEPTION '114 rollback: a clock-in network lock table, trigger or function is still there';
  END IF;
END
$$;

COMMIT;
