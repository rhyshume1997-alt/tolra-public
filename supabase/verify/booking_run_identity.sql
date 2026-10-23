-- Read only: all readiness rows should be TRUE. Historical mismatches are reported, never repaired here.
SELECT 'booking_guard' AS check_name, EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.machine_bookings'::regclass
    AND tgname = 'ab_booking_run_identity' AND tgenabled = 'O'
) AS ok
UNION ALL SELECT 'run_guard', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.machine_runs'::regclass
    AND tgname = 'ab_run_booking_identity' AND tgenabled = 'O'
)
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('guard_booking_run_identity', 'guard_run_booking_identity')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
)
UNION ALL SELECT 'existing_links_match', NOT EXISTS (
  SELECT 1 FROM public.machine_runs r JOIN public.machine_bookings b ON b.id = r.booking_id
  WHERE r.organization_id IS DISTINCT FROM b.organization_id OR r.job_id IS DISTINCT FROM b.job_id
    OR r.machine_id IS DISTINCT FROM b.machine_id
)
-- A plan row (job_machines) whose booking_id names another job's, machine's or company's booking: 049's Start runs against that
-- booking, and 064's run guard refuses the Start. Reported for triage (row 2 below lists them), never repaired here.
UNION ALL SELECT 'plan_links_match', NOT EXISTS (
  SELECT 1 FROM public.job_machines jm JOIN public.machine_bookings b ON b.id = jm.booking_id
  WHERE jm.organization_id IS DISTINCT FROM b.organization_id OR jm.job_id IS DISTINCT FROM b.job_id
    OR jm.machine_id IS DISTINCT FROM b.machine_id
);

SELECT r.id AS run_id, r.booking_id, r.organization_id AS run_company, b.organization_id AS booking_company,
       r.job_id AS run_job, b.job_id AS booking_job, r.machine_id AS run_machine, b.machine_id AS booking_machine, r.ended_at
FROM public.machine_runs r JOIN public.machine_bookings b ON b.id = r.booking_id
WHERE r.organization_id IS DISTINCT FROM b.organization_id OR r.job_id IS DISTINCT FROM b.job_id
   OR r.machine_id IS DISTINCT FROM b.machine_id;

SELECT jm.id AS plan_row_id, jm.booking_id, jm.organization_id AS plan_company, b.organization_id AS booking_company,
       jm.job_id AS plan_job, b.job_id AS booking_job, jm.machine_id AS plan_machine, b.machine_id AS booking_machine
FROM public.job_machines jm JOIN public.machine_bookings b ON b.id = jm.booking_id
WHERE jm.organization_id IS DISTINCT FROM b.organization_id OR jm.job_id IS DISTINCT FROM b.job_id
   OR jm.machine_id IS DISTINCT FROM b.machine_id;
