-- READ ONLY. Migration 061 (a machine picked on a job is booked at its next free slot; a finished job comes off the schedule): run in a
-- read-only transaction AFTER applying 061 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Every row is a fact about the schema or the data and must be "true".
WITH
fn AS (SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
d AS (
  SELECT pg_get_functiondef(to_regprocedure('public.machine_next_free_start(uuid,uuid,numeric,timestamp with time zone,timestamp with time zone)')) AS nfs,
         pg_get_functiondef(to_regprocedure('public.set_job_machines(uuid,jsonb,boolean,jsonb,text)')) AS sjm,
         pg_get_functiondef(to_regprocedure('public.carry_so_machines(uuid,uuid)')) AS cso,
         pg_get_functiondef(to_regprocedure('public.finish_job(uuid,uuid,timestamp with time zone)')) AS fin,
         pg_get_functiondef(to_regprocedure('public.convert_sales_order(uuid)')) AS conv
)
SELECT * FROM (
  SELECT 1 AS n, 'machine_next_free_start: exists, STABLE, invoker rights, pinned search_path; no API role (anon, authenticated, service_role) may run it' AS check_name,
      (SELECT NOT prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=pg_catalog, public']
              AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
              AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
       FROM fn WHERE oid = to_regprocedure('public.machine_next_free_start(uuid,uuid,numeric,timestamp with time zone,timestamp with time zone)'))::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'machine_next_free_start uses the schedule''s own rule: after every active booking (booking_intervals), into working hours (booking_normalise_start), proven free (booking_clashes)',
      (SELECT position('booking_intervals' IN nfs) > 0 AND position('booking_normalise_start' IN nfs) > 0 AND position('booking_clashes' IN nfs) > 0
              AND position('b.status <> ''complete''' IN nfs) > 0 AND position('organization_id = p_org' IN nfs) > 0 FROM d)::text, 'true'
  UNION ALL SELECT 3, 'set_job_machines: same signature and jsonb result, SECURITY DEFINER, pinned search_path, second step, admin/office/workshop; authenticated may run it, anon not',
      (SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public'] AND pg_get_function_result(oid) = 'jsonb'
              AND position('assert_privileged_aal' IN (SELECT sjm FROM d)) > 0 AND position('ARRAY[''admin'', ''office'', ''workshop'']' IN (SELECT sjm FROM d)) > 0
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
       FROM fn WHERE oid = to_regprocedure('public.set_job_machines(uuid,jsonb,boolean,jsonb,text)'))::text, 'true'
  UNION ALL SELECT 4, 'set_job_machines: the company lock before the job row; books through save_machine_booking at machine_next_free_start; never a second booking; no override on an automatic booking',
      (SELECT position('pg_advisory_xact_lock' IN sjm) > 0 AND position('pg_advisory_xact_lock' IN sjm) < position('FOR UPDATE' IN sjm)
              AND position('machine_next_free_start' IN sjm) > 0 AND position('save_machine_booking' IN sjm) > 0
              AND position('b.job_id = p_job AND b.machine_id = v_machine' IN sjm) > 0 AND position('CASE WHEN v_auto THEN FALSE ELSE p_clash_override END' IN sjm) > 0 FROM d)::text, 'true'
  UNION ALL SELECT 5, 'carry_so_machines: SECURITY DEFINER, pinned search_path, second step, admin/office; order row, then company lock, then job row; books through save_machine_booking',
      (SELECT f.prosecdef AND f.proconfig @> ARRAY['search_path=pg_catalog, public'] AND position('assert_privileged_aal' IN cso) > 0
              AND position('ARRAY[''admin'', ''office'']' IN cso) > 0
              AND position('FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE' IN cso) < position('pg_advisory_xact_lock' IN cso)
              AND position('pg_advisory_xact_lock' IN cso) < position('j.organization_id = v_org FOR UPDATE' IN cso)
              AND position('machine_next_free_start' IN cso) > 0 AND position('save_machine_booking' IN cso) > 0
              AND has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
       FROM fn f, d WHERE f.oid = to_regprocedure('public.carry_so_machines(uuid,uuid)'))::text, 'true'
  UNION ALL SELECT 6, 'convert_sales_order still carries the order''s machines (carry_so_machines) and keeps its jsonb result',
      (SELECT position('carry_so_machines' IN conv) > 0 AND pg_get_function_result(to_regprocedure('public.convert_sales_order(uuid)')) = 'jsonb' FROM d)::text, 'true'
  UNION ALL SELECT 7, 'finish_job: same signature, SECURITY DEFINER, pinned search_path, second step; company lock then job row; completes this job''s remaining bookings through machine_booking_mirror',
      (SELECT f.prosecdef AND f.proconfig @> ARRAY['search_path=pg_catalog, public'] AND pg_get_function_result(f.oid) = 'jsonb'
              AND position('assert_privileged_aal' IN fin) > 0 AND position('pg_advisory_xact_lock' IN fin) < position('FOR UPDATE' IN fin)
              AND position('machine_booking_mirror(v_b.id, v_org, ''complete'', 0)' IN fin) > 0 AND position('b.job_id = p_job' IN fin) > 0
              AND position('FINISH_COMPLETES_BOOKINGS' IN fin) > 0
              AND has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
       FROM fn f, d WHERE f.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamp with time zone)'))::text, 'true'
  UNION ALL SELECT 8, 'The schedule''s rule and its only writers are in place (042/044): booking_intervals, booking_clashes, save_machine_booking, delete_machine_booking, machine_booking_mirror',
      (to_regproc('public.booking_intervals') IS NOT NULL AND to_regproc('public.booking_clashes') IS NOT NULL AND to_regproc('public.save_machine_booking') IS NOT NULL
       AND to_regproc('public.delete_machine_booking') IS NOT NULL AND to_regproc('public.machine_booking_mirror') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 9, 'authenticated still has no INSERT, UPDATE or DELETE on machine_bookings (every booking write goes through the functions)',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'machine_bookings'
                     AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')))::text, 'true'
  UNION ALL SELECT 10, 'Every booking on a job belongs to the job''s company (no cross-company booking)',
      (NOT EXISTS (SELECT 1 FROM public.machine_bookings b JOIN public.jobs j ON j.id = b.job_id WHERE j.organization_id IS DISTINCT FROM b.organization_id)
       AND NOT EXISTS (SELECT 1 FROM public.machine_bookings b JOIN public.machines m ON m.id = b.machine_id WHERE m.organization_id IS DISTINCT FROM b.organization_id))::text, 'true'
  UNION ALL SELECT 11, 'Every plan row linked to a booking names a booking of the same job and machine',
      (NOT EXISTS (SELECT 1 FROM public.job_machines jm JOIN public.machine_bookings b ON b.id = jm.booking_id
                   WHERE b.job_id IS DISTINCT FROM jm.job_id OR b.machine_id IS DISTINCT FROM jm.machine_id))::text, 'true'
) rows
ORDER BY n;
