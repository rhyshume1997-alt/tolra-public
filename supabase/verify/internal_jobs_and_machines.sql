-- READ ONLY. Internal jobs and machines migration (042): run in a read-only transaction AFTER applying it on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 14 are facts about the schema and the data and must be "true". Rows 15 to 18 are informational.
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'jobs.is_internal exists, boolean, NOT NULL, default false; jobs.related_job_id exists; jobs.customer may be empty' AS check_name,
      ((SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'is_internal'
          AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false')
       AND (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'related_job_id' AND data_type = 'uuid')
       AND (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'customer' AND is_nullable = 'YES'))::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'The three job checks exist and are validated (customer unless internal, not related to itself, internal never converted)',
      (SELECT count(*) = 3 AND bool_and(convalidated) FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass
         AND conname IN ('jobs_customer_unless_internal', 'jobs_related_not_self', 'jobs_internal_not_converted'))::text, 'true'
  UNION ALL SELECT 3, 'No job breaks them: every customer job has a customer, no internal job came from a sales order, no job is related to itself',
      (SELECT count(*) = 0 FROM public.jobs WHERE (NOT is_internal AND customer IS NULL) OR (is_internal AND converted_from_sales_order_id IS NOT NULL) OR related_job_id = id)::text, 'true'
  UNION ALL SELECT 4, 'Every related job is in the same company',
      (SELECT count(*) = 0 FROM public.jobs j JOIN public.jobs r ON r.id = j.related_job_id WHERE r.organization_id <> j.organization_id)::text, 'true'
  UNION ALL SELECT 5, 'jobs carries the related-job same-company trigger and the is_internal guard',
      (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND NOT tgisinternal AND tgname IN ('zz_same_org_related_job_id', 'jobs_internal_immutable'))::text, 'true'
  UNION ALL SELECT 6, 'job_machines has row-level security with one select policy, and authenticated may only select (anon and PUBLIC nothing)',
      ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_machines'::regclass)
       AND (SELECT count(*) = 1 AND bool_and(cmd = 'SELECT') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_machines')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'job_machines' AND grantee IN ('anon', 'PUBLIC'))
       AND (SELECT array_agg(privilege_type::text) = ARRAY['SELECT'] FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'job_machines' AND grantee = 'authenticated'))::text, 'true'
  UNION ALL SELECT 7, 'job_machines carries the same-company (job, machine, booking), audit, read-only-support and admin second-step triggers',
      (SELECT count(*) = 6 FROM pg_trigger WHERE tgrelid = 'public.job_machines'::regclass AND NOT tgisinternal
         AND tgname IN ('zz_same_org_job_id', 'zz_same_org_machine_id', 'zz_same_org_booking_id', 'audit_job_machines_changes', 'support_read_only', 'admin_mfa'))::text, 'true'
  UNION ALL SELECT 8, 'create_job exists once, is SECURITY DEFINER with a pinned search_path, executable by authenticated and not by anon',
      (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname = 'create_job')::text, 'true'
  UNION ALL SELECT 9, 'Every job_machines row is in its job''s and machine''s company',
      (SELECT count(*) = 0 FROM public.job_machines jm JOIN public.jobs j ON j.id = jm.job_id JOIN public.machines m ON m.id = jm.machine_id
       WHERE j.organization_id <> jm.organization_id OR m.organization_id <> jm.organization_id)::text, 'true'
  UNION ALL SELECT 10, 'The schedule rule is in the database: the eight booking_* functions exist, none SECURITY DEFINER, anon may call none',
      (SELECT count(*) = 8 AND NOT bool_or(prosecdef) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) FROM fn
       WHERE proname IN ('booking_clock_minutes', 'booking_local_moment', 'booking_day_start', 'booking_is_working_day', 'booking_normalise_start',
                         'booking_finish', 'booking_intervals', 'booking_clashes'))::text, 'true'
  UNION ALL SELECT 11, 'save_machine_booking and delete_machine_booking exist once each, SECURITY DEFINER with a pinned search_path, executable by authenticated and not by anon',
      (SELECT count(*) = 2 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname IN ('save_machine_booking', 'delete_machine_booking'))::text, 'true'
  UNION ALL SELECT 12, 'machine_bookings: authenticated may only select (nothing writes the table but the functions); anon and PUBLIC nothing',
      ((SELECT array_agg(DISTINCT privilege_type::text) = ARRAY['SELECT'] FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'machine_bookings' AND grantee = 'authenticated')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'machine_bookings' AND grantee IN ('anon', 'PUBLIC')))::text, 'true'
  UNION ALL SELECT 13, 'a_job_despatch_billing_guard (job_despatch_billing_guard) is on delivery_notes and invoices, SECURITY DEFINER with a pinned search_path',
      ((SELECT count(*) = 2 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'a_job_despatch_billing_guard'
          AND tgrelid IN ('public.delivery_notes'::regclass, 'public.invoices'::regclass))
       AND (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') FROM fn WHERE proname = 'job_despatch_billing_guard'))::text, 'true'
  UNION ALL SELECT 14, 'No delivery note or invoice names an internal job (by link or by typed job number); every delivery note with an order and a job has the job converted from that order (either side of the link)',
      ((SELECT count(*) = 0 FROM public.delivery_notes d JOIN public.jobs j ON j.id = d.job_id WHERE j.is_internal OR (d.sales_order_id IS NOT NULL AND j.converted_from_sales_order_id IS DISTINCT FROM d.sales_order_id AND NOT EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = d.sales_order_id AND so.converted_to_job_id = d.job_id)))
       AND (SELECT count(*) = 0 FROM public.delivery_notes d JOIN public.jobs j ON j.organization_id = d.organization_id AND j.job_no = btrim(d.job_ref) WHERE j.is_internal)
       AND (SELECT count(*) = 0 FROM public.invoices i JOIN public.jobs j ON j.id = i.job_id WHERE j.is_internal))::text, 'true'
  UNION ALL SELECT 15, 'Internal jobs', (SELECT count(*) FROM public.jobs WHERE is_internal)::text, 'informational (0 until the first one)'
  UNION ALL SELECT 16, 'Jobs with a related job', (SELECT count(*) FROM public.jobs WHERE related_job_id IS NOT NULL)::text, 'informational'
  UNION ALL SELECT 17, 'Job machine links', (SELECT count(*) FROM public.job_machines)::text, 'informational'
  UNION ALL SELECT 18, 'Customer jobs whose customer is blank (allowed by the table, refused for new jobs by create_job)',
      (SELECT count(*) FROM public.jobs WHERE NOT is_internal AND btrim(coalesce(customer, '')) = '')::text, 'informational'
) AS t
ORDER BY n;
