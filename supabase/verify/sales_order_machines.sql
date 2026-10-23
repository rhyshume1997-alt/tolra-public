-- READ ONLY. Sales-order machines migration (043): run in a read-only transaction AFTER applying it on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 8 are facts about the schema and the data and must be "true". Rows 9 to 11 are informational.
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'sales_order_line_machines exists with the order, the line (nullable), the line position, the machine and the hours' AS check_name,
      ((SELECT count(*) = 5 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_order_line_machines'
          AND column_name IN ('sales_order_id', 'sales_order_line_id', 'line_key', 'machine_id', 'estimated_hours'))
       AND (SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_order_line_machines' AND column_name = 'sales_order_line_id')
       AND (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.sales_order_line_machines'::regclass AND conname = 'sales_order_line_machines_one_per_line'))::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'sales_order_line_machines has row-level security with one select policy plus the restrictive section gate, and authenticated may only select (anon and PUBLIC nothing)',
      ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_order_line_machines'::regclass)
       AND (SELECT count(*) FILTER (WHERE cmd = 'SELECT' AND permissive = 'PERMISSIVE') = 1 AND count(*) FILTER (WHERE permissive = 'RESTRICTIVE') = 1 AND count(*) = 2
            FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sales_order_line_machines')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'sales_order_line_machines' AND grantee IN ('anon', 'PUBLIC'))
       AND (SELECT array_agg(privilege_type::text) = ARRAY['SELECT'] FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'sales_order_line_machines' AND grantee = 'authenticated'))::text, 'true'
  UNION ALL SELECT 3, 'sales_order_line_machines carries the same-company (order, line, machine), audit, read-only-support and admin second-step triggers',
      (SELECT count(*) = 6 FROM pg_trigger WHERE tgrelid = 'public.sales_order_line_machines'::regclass AND NOT tgisinternal
         AND tgname IN ('zz_same_org_sales_order_id', 'zz_same_org_sales_order_line_id', 'zz_same_org_machine_id', 'audit_sales_order_line_machines_changes', 'support_read_only', 'admin_mfa'))::text, 'true'
  UNION ALL SELECT 4, 'job_machines.source_so_line_id exists (uuid, nullable) with its same-company trigger',
      ((SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_machines' AND column_name = 'source_so_line_id' AND data_type = 'uuid' AND is_nullable = 'YES')
       AND (SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = 'public.job_machines'::regclass AND NOT tgisinternal AND tgname = 'zz_same_org_source_so_line_id'))::text, 'true'
  UNION ALL SELECT 5, 'set_sales_order_line_machines, carry_so_machines and set_job_machines exist once each, SECURITY DEFINER with a pinned search_path, executable by authenticated and not by anon',
      (SELECT count(*) = 3 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname IN ('set_sales_order_line_machines', 'carry_so_machines', 'set_job_machines'))::text, 'true'
  UNION ALL SELECT 6, 'convert_sales_order exists once, still SECURITY INVOKER, and carries the plan (calls carry_so_machines)',
      (SELECT count(*) = 1 AND bool_and(NOT prosecdef) AND bool_and(position('carry_so_machines' IN pg_get_functiondef(oid)) > 0)
       FROM fn WHERE proname = 'convert_sales_order')::text, 'true'
  UNION ALL SELECT 7, 'Every plan row is in its order''s and machine''s company, and its line (when attached) belongs to its order',
      (SELECT count(*) = 0 FROM public.sales_order_line_machines m
         JOIN public.sales_orders o ON o.id = m.sales_order_id JOIN public.machines mc ON mc.id = m.machine_id
         LEFT JOIN public.sales_order_lines l ON l.id = m.sales_order_line_id
       WHERE o.organization_id <> m.organization_id OR mc.organization_id <> m.organization_id OR (l.id IS NOT NULL AND l.sales_order_id <> m.sales_order_id))::text, 'true'
  UNION ALL SELECT 8, 'Every carried job machine names a line of the order its job was converted from',
      (SELECT count(*) = 0 FROM public.job_machines jm JOIN public.sales_order_lines l ON l.id = jm.source_so_line_id JOIN public.jobs j ON j.id = jm.job_id
       WHERE j.converted_from_sales_order_id IS DISTINCT FROM l.sales_order_id)::text, 'true'
  UNION ALL SELECT 9, 'Order lines with a machine plan', (SELECT count(DISTINCT (sales_order_id, line_key)) FROM public.sales_order_line_machines)::text, 'informational (0 until the first one)'
  UNION ALL SELECT 10, 'Plan rows detached from their line by a rebuild (re-attached by position on the next write or carry)', (SELECT count(*) FROM public.sales_order_line_machines WHERE sales_order_line_id IS NULL)::text, 'informational'
  UNION ALL SELECT 11, 'Job machines carried from an order', (SELECT count(*) FROM public.job_machines WHERE source_so_line_id IS NOT NULL)::text, 'informational'
) AS t
ORDER BY n;
