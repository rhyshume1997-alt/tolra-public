-- Migration 073 (invoice screen: void_invoice and its guard, £0 text-only invoice lines, invoice note, delivery address, customer
-- mobile). Read only: every row (15) should be TRUE. Pairs with the release text supabase/release/073_invoice_screen.release.sql
-- (sha256 in docs/RELEASE.md "073").
SELECT 'invoice_note_column' AS check_name, EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'invoice_note' AND data_type = 'text' AND is_nullable = 'YES'
) AND EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoices'::regclass AND conname = 'invoices_invoice_note_check'
    AND pg_get_constraintdef(oid) LIKE '%200%'
) AS ok
UNION ALL SELECT 'delivery_address_column', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'delivery_address' AND data_type = 'text' AND is_nullable = 'YES'
) AND EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoices'::regclass AND conname = 'invoices_delivery_address_check'
    AND pg_get_constraintdef(oid) LIKE '%500%'
)
UNION ALL SELECT 'customer_mobile_column', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'mobile' AND data_type = 'text' AND is_nullable = 'YES'
) AND EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.customers'::regclass AND conname = 'customers_mobile_check'
    AND pg_get_constraintdef(oid) LIKE '%40%'
)
-- Invoice lines: quantity above 0, or a £0 text line (quantity 0 AND price 0). Quote and delivery-note lines keep quantity > 0.
UNION ALL SELECT 'invoice_text_line_rule', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoice_line_items'::regclass AND conname = 'invoice_line_items_quantity_positive'
    AND replace(pg_get_constraintdef(oid), ' ', '') LIKE '%(quantity>(0)::numeric)OR((quantity=(0)::numeric)AND(unit_price=(0)::numeric))%'
) AND EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.quote_line_items'::regclass AND conname = 'quote_line_items_quantity_positive'
    AND replace(pg_get_constraintdef(oid), ' ', '') LIKE 'CHECK((quantity>(0)::numeric))%'
) AND EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.delivery_note_items'::regclass AND conname = 'delivery_note_items_quantity_positive'
    AND replace(pg_get_constraintdef(oid), ' ', '') LIKE 'CHECK((quantity>(0)::numeric))%'
)
-- Only a quantity of 0 with a price of 0 may be stored on an invoice line (nothing with a price and no quantity).
UNION ALL SELECT 'no_priced_zero_lines', NOT EXISTS (
  SELECT 1 FROM public.invoice_line_items WHERE quantity = 0 AND unit_price <> 0
)
UNION ALL SELECT 'check_invoice_line', EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.check_invoice_line(jsonb)')
    AND NOT p.prosecdef AND 'search_path=pg_catalog, public' = ANY (p.proconfig)
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND position('check_priced_line' IN pg_get_functiondef(p.oid)) > 0
)
UNION ALL SELECT 'invoice_paths_use_check_invoice_line', (
  SELECT bool_and(position('check_invoice_line' IN pg_get_functiondef(to_regprocedure(f))) > 0)
  FROM unnest(ARRAY['public.create_with_lines(text, jsonb, text, text, jsonb)', 'public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)']) f
) AND position('delivery_address' IN pg_get_functiondef('public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)'::regprocedure)) > 0
  AND position('invoice_note' IN pg_get_functiondef('public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)'::regprocedure)) > 0
-- check_priced_line (021) itself is unchanged: quantity must be above 0.
UNION ALL SELECT 'check_priced_line_unchanged', position('v_qty <= 0' IN pg_get_functiondef('public.check_priced_line(jsonb)'::regprocedure)) > 0
UNION ALL SELECT 'void_invoice_function', EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.void_invoice(uuid, text)')
    AND p.prosecdef AND 'search_path=pg_catalog, public, security_audit' = ANY (p.proconfig)
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND position('assert_privileged_aal' IN pg_get_functiondef(p.oid)) > 0
    AND position('quoteflow.invoice_void' IN pg_get_functiondef(p.oid)) > 0
    AND position('VOID_INVOICE' IN pg_get_functiondef(p.oid)) > 0
)
UNION ALL SELECT 'void_guard_trigger', EXISTS (
  SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoices_void_guard' AND t.tgenabled = 'O' AND NOT t.tgisinternal
    AND p.proname = 'invoices_void_guard' AND NOT p.prosecdef
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
)
-- From 073 a status is written only as one of the exact allowed values (API roles), and the void guard compares exact values.
UNION ALL SELECT 'status_allowlist_trigger', EXISTS (
  SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoices_status_allowlist' AND t.tgenabled = 'O' AND NOT t.tgisinternal
    AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16 -- BEFORE, INSERT, UPDATE
    AND p.proname = 'invoices_status_allowlist' AND NOT p.prosecdef
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND position('''draft'', ''issued'', ''sent'', ''partial'', ''paid'', ''credited'', ''void'', ''cancelled'', ''written_off''' IN pg_get_functiondef(p.oid)) > 0
    AND position('btrim' IN pg_get_functiondef(p.oid)) = 0 AND position('lower(' IN pg_get_functiondef(p.oid)) = 0
) -- void_invoice trims only the reason (one btrim) and folds no case:
  AND coalesce((SELECT (length(d) - length(replace(d, 'btrim', ''))) / 5 = 1 AND position('v_reason TEXT := btrim' IN d) > 0 AND position('lower(' IN d) = 0
       FROM pg_get_functiondef(to_regprocedure('public.void_invoice(uuid, text)')) d), FALSE)
  AND coalesce(position('btrim' IN pg_get_functiondef(to_regprocedure('public.invoices_void_guard()'))) = 0, FALSE)
UNION ALL SELECT 'text_only_invoice_not_issued', EXISTS (
  SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoices_issue_needs_priced_line' AND t.tgenabled = 'O'
)
-- 034's lock on paid/part-paid/credited status changes is still in force.
UNION ALL SELECT 'issue_lock_intact', EXISTS (
  SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoice_issue_lock' AND t.tgenabled = 'O'
) AND position('''paid'', ''partial'', ''credited''' IN pg_get_functiondef('public.invoice_issue_lock()'::regprocedure)) > 0
-- Every void invoice that has a credit or payment against it was there before 073 (a count to review is reported in its name; never a failure).
UNION ALL SELECT 'review_void_with_money=' || (
  SELECT count(*) FROM public.invoices i
  WHERE lower(regexp_replace(coalesce(i.status, ''), '[^[:alpha:]]', '', 'g')) IN ('void', 'voided', 'cancelled', 'canceled')
    AND (i.amount_paid <> 0 OR i.credited_amount <> 0 OR i.refunded_amount <> 0
         OR EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.invoice_id = i.id)
         OR EXISTS (SELECT 1 FROM public.invoice_credit_allocations a WHERE a.invoice_id = i.id))
), TRUE
-- Older rows whose status is not one of the allowed values (a count to review, never a failure): 034's payment steps compare
-- lower(status) without trimming, so an odd spelling of void on an older row is worth a look.
UNION ALL SELECT 'review_status_outside_allowlist=' || (
  SELECT count(*) FROM public.invoices i
  WHERE i.status IS NULL OR NOT (i.status = ANY (ARRAY['draft', 'issued', 'sent', 'partial', 'paid', 'credited', 'void', 'cancelled', 'written_off']))
), TRUE;
