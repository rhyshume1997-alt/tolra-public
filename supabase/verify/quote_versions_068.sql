-- Migration 068 (quote versions, partial acceptance, part / drawing / revision per line). Read only: every row should be TRUE.
SELECT 'version_columns' AS check_name, (
  SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'quotes'
    AND ((column_name = 'version' AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '1')
      OR (column_name = 'previous_version_id' AND data_type = 'uuid'))
) = 2 AS ok
UNION ALL SELECT 'line_columns', (
  SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'quote_line_items' AND column_name = 'declined' AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false')
      OR (table_name IN ('quote_line_items', 'sales_order_lines') AND column_name IN ('part_number', 'drawing_number', 'drawing_revision') AND data_type = 'text'))
) = 7
UNION ALL SELECT 'constraints', (
  SELECT count(*) FROM pg_constraint
  WHERE (conrelid = 'public.quotes'::regclass AND conname = 'quotes_version_chain')
     OR (conrelid = 'public.quote_line_items'::regclass AND conname = 'quote_line_items_part_details')
     OR (conrelid = 'public.sales_order_lines'::regclass AND conname = 'sales_order_lines_part_details')
) = 3
UNION ALL SELECT 'one_revision_each_index', EXISTS (
  SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.quotes_one_revision_each') AND i.indisunique AND i.indisvalid
)
UNION ALL SELECT 'triggers', (
  SELECT count(*) FROM pg_trigger
  WHERE tgrelid = 'public.quotes'::regclass AND tgenabled = 'O'
    AND tgname IN ('quote_version_guard', 'quote_revision_withdrawn', 'zz_same_org_previous_version_id', 'quote_lifecycle_guard')
) = 4 AND (
  SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.quote_line_items'::regclass AND tgenabled = 'O'
    AND tgname IN ('quote_lines_issue_lock', 'quote_line_part_clean')
) = 2
-- The two signed-in entry points, definer, not for anon; the old three-argument accept_quote is gone (one signature).
UNION ALL SELECT 'entry_points', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
  FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.revise_quote(uuid)'), to_regprocedure('public.accept_quote(uuid, text, date, uuid[])'))
) AND to_regprocedure('public.revise_quote(uuid)') IS NOT NULL AND to_regprocedure('public.accept_quote(uuid, text, date, uuid[])') IS NOT NULL
  AND to_regprocedure('public.accept_quote(uuid, text, date)') IS NULL
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('quote_version_guard', 'quote_revision_withdrawn', 'quote_lines_issue_lock', 'quote_line_part_clean', 'create_sales_order_from_quote',
                      'quote_attachments_customer_po_to_jobs')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
)
-- The two text helpers run as the signed-in user inside convert_sales_order (INVOKER) and 067's customer-PO trigger: authenticated
-- may run them, anon may not.
UNION ALL SELECT 'helpers_for_signed_in', (
  SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT p.prosecdef)
  FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.quote_line_reference(text, text, text)'), to_regprocedure('public.quote_base_ref(text, integer)'))
) AND to_regprocedure('public.quote_line_reference(text, text, text)') IS NOT NULL AND to_regprocedure('public.quote_base_ref(text, integer)') IS NOT NULL
-- 067's customer PO reaches the jobs of every version of its quote (matched on the quote's own number through jobs.quote_id).
UNION ALL SELECT 'customer_po_trigger_on_base_ref', (
  SELECT p.prosrc ILIKE '%quote_base_ref%' AND p.prosrc ILIKE '%j.quote_id%' AND NOT p.prosecdef
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.quote_attachments_customer_po_to_jobs()')
) AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quote_attachments'::regclass AND tgname = 'quote_attachments_customer_po_to_jobs' AND tgenabled = 'O')
-- The functions that build orders and jobs read the ordered lines only, and carry the part details.
UNION ALL SELECT 'readers_skip_declined_lines', (
  SELECT bool_and(p.prosrc ILIKE '%declined%')
  FROM pg_proc p WHERE p.oid IN ('public.create_sales_order_from_quote(uuid, text, date)'::regprocedure, 'public.convert_sales_order(uuid)'::regprocedure,
                                 'public.ensure_sales_order_lines(uuid)'::regprocedure, 'public.accept_quote(uuid, text, date, uuid[])'::regprocedure)
) AND (SELECT prosrc ILIKE '%drawing_revision%' FROM pg_proc WHERE oid = 'public.replace_draft_quote(uuid, timestamp with time zone, jsonb, jsonb)'::regprocedure)
-- Existing data: every chain is well formed (a revision follows its version by one, same company, one revision each).
UNION ALL SELECT 'chains_well_formed', NOT EXISTS (
  SELECT 1 FROM public.quotes v JOIN public.quotes p ON p.id = v.previous_version_id
  WHERE v.version <> p.version + 1 OR v.organization_id <> p.organization_id
)
-- A superseded quote always has a newer version, and only the latest version can be accepted or rejected.
UNION ALL SELECT 'superseded_have_successor', NOT EXISTS (
  SELECT 1 FROM public.quotes q WHERE q.status = 'superseded' AND NOT EXISTS (SELECT 1 FROM public.quotes n WHERE n.previous_version_id = q.id)
) AND NOT EXISTS (
  SELECT 1 FROM public.quotes q WHERE q.status IN ('accepted', 'rejected') AND EXISTS (SELECT 1 FROM public.quotes n WHERE n.previous_version_id = q.id)
)
-- Declined lines only on accepted quotes, and never every line of a quote.
UNION ALL SELECT 'declined_only_on_accepted', NOT EXISTS (
  SELECT 1 FROM public.quote_line_items l JOIN public.quotes q ON q.id = l.quote_id
  WHERE l.declined AND q.status IS DISTINCT FROM 'accepted'
) AND NOT EXISTS (
  SELECT 1 FROM public.quote_line_items l GROUP BY l.quote_id HAVING bool_and(l.declined)
);
