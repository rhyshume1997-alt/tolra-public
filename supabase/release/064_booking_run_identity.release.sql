-- 064_booking_run_identity.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- B39: a booking's job and machine become immutable once a run references it.
-- Existing RPCs retain their signatures and lock order. No business rows are rewritten.
-- The run-side SHARE lock conflicts with a booking UPDATE's row lock: whichever wins,
-- the other statement checks the committed identity/history before it can proceed.
CREATE OR REPLACE FUNCTION public.guard_booking_run_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id)
     AND EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.booking_id = OLD.id) THEN
    RAISE EXCEPTION 'This booking has machine run history. Keep its job and machine, or create a separate booking.'
      USING ERRCODE = '23514', HINT = 'booking_has_runs';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_booking_run_identity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ab_booking_run_identity ON public.machine_bookings;
CREATE TRIGGER ab_booking_run_identity BEFORE UPDATE OF job_id, machine_id, organization_id ON public.machine_bookings
  FOR EACH ROW EXECUTE FUNCTION public.guard_booking_run_identity();

CREATE OR REPLACE FUNCTION public.guard_run_booking_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_booking public.machine_bookings%ROWTYPE;
BEGIN
  IF NEW.booking_id IS NULL THEN RETURN NEW; END IF;
  -- Finishing or pausing a historical run does not revalidate or rewrite old mismatches.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.booking_id IS NOT DISTINCT FROM OLD.booking_id
       AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id
       AND NEW.machine_id IS NOT DISTINCT FROM OLD.machine_id
       AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO v_booking FROM public.machine_bookings WHERE id = NEW.booking_id FOR SHARE;
  IF NOT FOUND OR v_booking.job_id IS DISTINCT FROM NEW.job_id
     OR v_booking.machine_id IS DISTINCT FROM NEW.machine_id
     OR v_booking.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'The booking must belong to this run''s job, machine and company.'
      USING ERRCODE = '23514', HINT = 'run_booking_mismatch';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_run_booking_identity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ab_run_booking_identity ON public.machine_runs;
CREATE TRIGGER ab_run_booking_identity BEFORE INSERT OR UPDATE OF booking_id, job_id, machine_id, organization_id ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_run_booking_identity();

COMMIT;
