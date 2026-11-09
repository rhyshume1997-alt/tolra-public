-- Migration 138 (late-payer chasing: steps, pauses, drafts for approval). Read only: every row should be TRUE (12). Bodies are compared with
-- every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)'), to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)'))
), t AS (
  SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('chase_steps', 'chase_pauses', 'chase_sends')
)
-- The two server-only functions are 138's bodies.
SELECT 'chase_functions_are_138' AS check_name,
  (SELECT count(*) = 2 FROM fn WHERE (proname, body) IN (('chase_create_draft', '5452f25d1f364e3915e01db2cfed2fee'), ('chase_record_sent', '213c534d5aeb25f0d14f9070396faf76'))) AS ok
-- Definer, search_path pinned, the service role only (not authenticated, anon or PUBLIC).
UNION ALL SELECT 'chase_functions_definer_pinned_service_only',
  (SELECT count(*) = 2 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
            AND has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
            AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) FROM fn)
-- The three tables, each row-secured.
UNION ALL SELECT 'chase_tables_row_secured', (SELECT count(*) = 3 AND bool_and(relrowsecurity) FROM t)
-- Policies: steps (members read; admin/office write: 4), pauses (admin/office: 4), sends (admin/office read only: 1).
UNION ALL SELECT 'chase_policies',
  (SELECT count(*) FILTER (WHERE tablename = 'chase_steps') = 4 AND count(*) FILTER (WHERE tablename = 'chase_pauses') = 4
          AND count(*) FILTER (WHERE tablename = 'chase_sends') = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chase_steps', 'chase_pauses', 'chase_sends'))
-- chase_sends: the API can read it only; nobody signed in writes it.
UNION ALL SELECT 'chase_sends_server_written',
  has_table_privilege('authenticated', 'public.chase_sends', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.chase_sends', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.chase_sends', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.chase_sends', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.chase_sends', 'SELECT') AND NOT has_table_privilege('anon', 'public.chase_steps', 'SELECT') AND NOT has_table_privilege('anon', 'public.chase_pauses', 'SELECT')
-- At most once per invoice per step.
UNION ALL SELECT 'chase_sends_one_per_step',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.chase_sends') AND conname = 'chase_sends_one_per_step' AND pg_get_constraintdef(oid) = 'UNIQUE (invoice_id, step_id)')
-- support_read_only and admin_mfa on all three tables.
UNION ALL SELECT 'chase_guards',
  (SELECT count(*) = 6 FROM pg_trigger g JOIN t ON t.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgname IN ('support_read_only', 'admin_mfa'))
-- 106's template keys plus the three chase texts.
UNION ALL SELECT 'email_templates_key_138',
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.email_templates'::regclass AND c.conname = 'email_templates_key')
    = 'CHECK ((key = ANY (ARRAY[''quote''::text, ''invoice''::text, ''purchase_order''::text, ''delivery_note''::text, ''invoice_reminder''::text, ''timesheet''::text, ''job_to_workshop''::text, ''rfq_clarify''::text, ''chase_before_due''::text, ''chase_firm''::text, ''chase_final''::text])))'
-- 076's invoice_issue_lock with the four claim columns open (138's body), and the claim guard trigger.
UNION ALL SELECT 'invoice_issue_lock_is_138',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'aa8c9f3ae3035d0ed566723a28edd827' FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_lock()')), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid WHERE g.tgrelid = 'public.invoices'::regclass AND g.tgname = 'invoices_payment_claim_guard' AND NOT g.tgisinternal
              AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '7f540f262f12c85432b5a5172442d005' AND NOT p.prosecdef)
-- The payment-claim functions are 138's bodies.
UNION ALL SELECT 'payment_claim_functions_are_138',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '1ee5cb529645fd03263bd9e481864b1d' FROM pg_proc p WHERE p.oid = to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)')), FALSE)
  AND coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'd3cbee1ab48f8e29d20fe23f8d8603fd' FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_payment_claim(uuid,text)')), FALSE)
-- Definer, pinned; mark: signed-in and the service role; resolve: signed-in only; never anon or PUBLIC.
UNION ALL SELECT 'payment_claim_definer_pinned_granted',
  (SELECT count(*) = 2 AND bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)'), to_regprocedure('public.resolve_payment_claim(uuid,text)')))
  AND has_function_privilege('service_role', 'public.mark_payment_claimed(uuid,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.resolve_payment_claim(uuid,text)', 'EXECUTE')
-- The four columns, and the source's two values.
UNION ALL SELECT 'payment_claim_columns',
  (SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'
     AND (column_name, data_type) IN (('payment_claimed_at', 'timestamp with time zone'), ('payment_claim_source', 'text'), ('payment_claim_evidence', 'text'), ('payment_claim_message_id', 'text')))
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoices'::regclass AND conname = 'invoices_payment_claim_source'
              AND pg_get_constraintdef(oid) = 'CHECK ((payment_claim_source = ANY (ARRAY[''email''::text, ''manual''::text])))');
