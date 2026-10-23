-- READ ONLY. Migration 037 (failed inspection and rework): run in a read-only transaction AFTER applying 037 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 9 and 14 are facts about the schema and the data and must be "true". Rows 10 to 13, 15 and 16 are
-- informational: how many reworks exist and how many are live, how many jobs are in the rework stage, how many hours and material entries are booked,
-- how many jobs have parts held, and how many holds are not tied to an order line (each holds its whole job until it is resolved).
WITH
fn AS (SELECT p.proname, p.prosrc, p.prosecdef, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'security_audit')),
guarded AS (
  SELECT c.table_schema, c.table_name
  FROM information_schema.columns c
  JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
  WHERE c.column_name = 'organization_id' AND c.table_schema IN ('public', 'security_audit')
    AND c.table_name NOT IN ('user_profiles', 'organization_members', 'organization_invites', 'org_entry_log', 'session_company')
)
SELECT * FROM (
  SELECT 1 AS n, 'The three rework tables exist with row-level security on' AS check_name,
      (SELECT count(*) = 3 AND bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN ('job_rework', 'job_rework_entries', 'job_rework_entry_values'))::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'The API roles can only read them (no insert, update or delete privilege for anon or authenticated)',
      (SELECT count(*) = 0 FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'public' AND g.table_name IN ('job_rework', 'job_rework_entries', 'job_rework_entry_values')
         AND g.grantee IN ('anon', 'authenticated', 'PUBLIC') AND g.privilege_type <> 'SELECT')::text, 'true'
  UNION ALL SELECT 3, 'The nine rework functions exist (one of each), are SECURITY DEFINER and are closed to anon',
      (SELECT count(*) = 9 AND bool_and(prosecdef) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) FROM fn
       WHERE proname IN ('fail_job_inspection', 'start_job_rework', 'record_rework_cost', 'scrap_job_quantity', 'finish_job_rework', 'job_rework_summary',
                         'open_replacement_rework', 'job_release_state', 'job_line_release'))::text, 'true'
  UNION ALL SELECT 4, 'record_job_inspection hands a fail to fail_job_inspection',
      (SELECT count(*) = 1 AND bool_and(prosrc ILIKE '%fail_job_inspection%') FROM fn WHERE proname = 'record_job_inspection')::text, 'true'
  UNION ALL SELECT 5, 'Every company table has the read-only support trigger',
      (SELECT (SELECT count(*) FROM guarded) > 0
          AND NOT EXISTS (SELECT 1 FROM guarded g WHERE NOT EXISTS (
                SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE t.tgname = 'support_read_only' AND NOT t.tgisinternal AND n.nspname = g.table_schema AND c.relname = g.table_name)))::text, 'true'
  UNION ALL SELECT 6, 'The rework stage is guarded on jobs, and at most one rework per job and order line is live',
      (SELECT (SELECT count(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'jobs' AND t.tgname = 'jobs_rework_stage_guard' AND NOT t.tgisinternal)
          AND (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_job_rework_one_live'))::text, 'true'
  UNION ALL SELECT 7, 'Every job in the rework stage has an open or started rework',
      (SELECT count(*) = 0 FROM public.jobs j WHERE j.stage = 'rework'
         AND NOT EXISTS (SELECT 1 FROM public.job_rework r WHERE r.job_id = j.id AND r.status IN ('open', 'in_progress')))::text, 'true'
  UNION ALL SELECT 8, 'No job with a live rework has been released',
      (SELECT count(*) = 0 FROM public.job_rework r JOIN public.jobs j ON j.id = r.job_id
       WHERE r.status IN ('open', 'in_progress', 'finished') AND j.inspected_at IS NOT NULL)::text, 'true'
  UNION ALL SELECT 9, 'updated_at moves: the trigger is on the ten document tables',
      (SELECT count(*) = 10 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND t.tgname = 'zzzz_touch_updated_at' AND NOT t.tgisinternal
         AND c.relname IN ('jobs', 'invoices', 'quotes', 'sales_orders', 'purchase_orders', 'delivery_notes', 'credit_notes', 'rfqs', 'customers', 'suppliers'))::text, 'true'
  UNION ALL SELECT 10, 'Reworks recorded', (SELECT count(*) FROM public.job_rework)::text, 'informational (0 until the first failed inspection)'
  UNION ALL SELECT 11, 'Reworks live now (open, started or awaiting re-inspection)', (SELECT count(*) FROM public.job_rework WHERE status IN ('open', 'in_progress', 'finished'))::text, 'informational'
  UNION ALL SELECT 12, 'Jobs in the rework stage', (SELECT count(*) FROM public.jobs WHERE stage = 'rework')::text, 'informational'
  UNION ALL SELECT 13, 'Rework hours, material, scrap and replacement entries', (SELECT count(*) FROM public.job_rework_entries)::text, 'informational'
  UNION ALL SELECT 14, 'Despatch per order line and the second step: create_delivery_note and the delivery note guard read job_release_state and job_line_release under a job lock and refuse what can''t be weighed, despatch_release exists, a failure names its order line and batch, finish records replacements, every rework writer calls assert_privileged_aal, the rework tables carry admin_mfa',
      ((SELECT count(*) = 2 FROM fn WHERE proname IN ('create_delivery_note', 'delivery_notes_link_guard') AND prosrc LIKE '%job_release_state%' AND prosrc LIKE '%job_line_release%'
          AND prosrc LIKE '%blocked%' AND prosrc LIKE '%FOR UPDATE%')
       AND (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'finish_job_rework' AND pronargs = 3)
       AND (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'fail_job_inspection' AND pronargs = 9)
       AND (SELECT count(*) = 2 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_rework' AND column_name IN ('sales_order_line_id', 'batch_ref'))
       AND (SELECT count(*) = 1 FROM fn WHERE proname = 'despatch_release' AND prosecdef)
       AND (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'record_job_inspection')
       AND (SELECT count(*) = 8 FROM fn WHERE proname IN ('fail_job_inspection', 'record_job_inspection', 'start_job_rework', 'record_rework_cost', 'scrap_job_quantity', 'finish_job_rework',
                                                         'open_replacement_rework', 'create_delivery_note')
              AND prosrc LIKE '%assert_privileged_aal()%')
       AND (SELECT count(*) = 3 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'admin_mfa' AND NOT t.tgisinternal
              AND c.relname IN ('job_rework', 'job_rework_entries', 'job_rework_entry_values')))::text, 'true'
  UNION ALL SELECT 15, 'Jobs with parts held (in a live rework, or replacements still to make)',
      (SELECT count(*) FROM public.jobs j WHERE EXISTS (SELECT 1 FROM public.job_rework r WHERE r.job_id = j.id
         AND (r.status IN ('open', 'in_progress', 'finished') OR r.quantity_scrapped > r.quantity_remade + r.quantity_carried)))::text, 'informational'
  UNION ALL SELECT 16, 'Holds not tied to an order line on jobs made from an order (each holds its whole job until inspected again and its replacements made)',
      (SELECT count(*) FROM public.job_rework r JOIN public.jobs j ON j.id = r.job_id
       WHERE j.converted_from_sales_order_id IS NOT NULL AND r.sales_order_line_id IS NULL
         AND (r.status IN ('open', 'in_progress', 'finished') OR r.quantity_scrapped > r.quantity_remade + r.quantity_carried))::text, 'informational (0 expected)'
) AS t
ORDER BY n;
