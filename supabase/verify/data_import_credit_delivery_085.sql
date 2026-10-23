-- Migration 085 (data import PR2: credit notes, delivery notes, who sent a PO or an invoice and who signed a delivery note). Read only:
-- every row should be TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH RECURSIVE f(sig, want) AS (
  VALUES ('public.import_check_payload(jsonb)', '7c041eb39e57ee9504308162bc3217c9'),
                  ('public.import_merge_stage(uuid,uuid)', 'b24dbc8ae80269fca5d93345a1d3f50a'),
                  ('public.import_plan(jsonb,integer)', 'ba1637348e59883e1473ee4645875c12'),
                  ('public.import_part_payload(jsonb,jsonb)', 'bcd8bc328cde95cceafefe0ca1b0990b'),
                  ('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)', '0a2fec5746b0b1262cb2af6fe792bd7c'),
                  ('public.import_undo_part(uuid,uuid)', '177d5c7273b79670dd0c3f130b215652')
),
g(sig, want) AS (
  VALUES ('public.credit_note_issue_lock()', '8e0ff460c60a94bb1164dc39dd77aae1'),
                  ('public.credit_note_lines_issue_lock()', '369bbaa5c6979d4bb9d70c5cbf68d9bd'),
                  ('public.delivery_notes_link_guard()', '4c57607b1909f060d689df9ea5a99128'),
                  ('public.delivery_note_items_link_guard()', '612a2bc924a8ea1916ce1a66101ced97')
),
-- 079's static check (supabase/verify/import_safeupdate_079.sql) on every public import_* function: each UPDATE / DELETE has its own WHERE.
fn AS (
  SELECT p.oid, p.prosrc AS src FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'import\_%'
),
stmt AS (
  SELECT fn.oid, s.n, s.t FROM fn, LATERAL regexp_split_to_table(regexp_replace(fn.src, '--[^\n]*', '', 'g'), ';') WITH ORDINALITY AS s(t, n)
),
occ AS (
  SELECT stmt.oid, stmt.n, k,
         substring(stmt.t FROM regexp_instr(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, k, 0, 'i')) AS t
  FROM stmt, LATERAL generate_series(1, regexp_count(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, 'i')) AS k
),
flat(oid, n, k, t, i) AS (
  SELECT oid, n, k, t, 0 FROM occ
  UNION ALL SELECT oid, n, k, regexp_replace(t, '\([^()]*\)', ' ', 'g'), i + 1 FROM flat WHERE t ~ '\([^()]*\)' AND i < 50
),
unqualified AS (
  SELECT x.oid FROM flat x
  WHERE NOT EXISTS (SELECT 1 FROM flat y WHERE y.oid = x.oid AND y.n = x.n AND y.k = x.k AND y.i > x.i)
    AND split_part(x.t, ')', 1) !~* '\mWHERE\M'
)
-- 1. The engine: 079's import_company_data_run and 076's helpers as 085 extends them; same settings, not definer.
SELECT 'import_engine_is_085' AS check_name,
       (SELECT count(*) = 6 FROM f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
        WHERE md5(regexp_replace(p.prosrc, '\s', '', 'g')) = f.want AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) AS ok
-- 2. The four guards: 034's / 037's bodies plus 085's one block each.
UNION ALL SELECT 'guards_are_085',
       (SELECT count(*) = 4 FROM g JOIN pg_proc p ON p.oid = to_regprocedure(g.sig) WHERE md5(regexp_replace(p.prosrc, '\s', '', 'g')) = g.want AND NOT p.prosecdef)
-- 3. The people guard: 085's body, an internal trigger function.
UNION ALL SELECT 'people_guard_is_085',
       coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '513ca1c3542ad19388992a58a8b78cdb' AND NOT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_people_guard()')), FALSE)
-- 4. Nothing internal can be called from the API.
UNION ALL SELECT 'internal_functions_internal',
       (SELECT count(*) = 7 AND bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                         AND NOT has_function_privilege('public', p.oid, 'EXECUTE'))
        FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure(sig) FROM f UNION ALL SELECT to_regprocedure('public.import_people_guard()')))
-- 5. The five API entry points as 076 left them: definer, signed-in only.
UNION ALL SELECT 'entry_points_unchanged',
       (SELECT count(*) = 5 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.import_company_data(jsonb,boolean,uuid)'), to_regprocedure('public.import_stage_part(uuid,integer,jsonb)'),
          to_regprocedure('public.import_validate(uuid,integer,uuid)'), to_regprocedure('public.import_commit_part(uuid,uuid)'), to_regprocedure('public.import_undo(uuid,uuid)'))
          AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
-- 6. The people columns: nullable, the user ids referencing auth.users (set to null when a user is removed), names 200 at most.
UNION ALL SELECT 'people_columns',
       (SELECT count(*) = 5 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.is_nullable = 'YES'
          AND (c.table_name, c.column_name, c.data_type) IN (('invoices', 'sent_by_name', 'text'), ('invoices', 'sent_by_user_id', 'uuid'), ('purchase_orders', 'sent_by_name', 'text'),
                                                           ('purchase_orders', 'sent_by_user_id', 'uuid'), ('delivery_notes', 'signed_by_user_id', 'uuid')))
       AND (SELECT count(*) = 3 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
            WHERE k.contype = 'f' AND k.confrelid = 'auth.users'::regclass AND k.confdeltype = 'n'
              AND (k.conrelid::regclass::TEXT, a.attname) IN (('invoices', 'sent_by_user_id'), ('purchase_orders', 'sent_by_user_id'), ('delivery_notes', 'signed_by_user_id')))
       AND (SELECT count(*) = 2 FROM pg_constraint k WHERE k.conname IN ('invoices_sent_by_name_length', 'purchase_orders_sent_by_name_length') AND k.convalidated)
-- 7. Written by the import only: the guard on all three tables.
UNION ALL SELECT 'people_triggers',
       (SELECT count(*) = 3 FROM pg_trigger t WHERE t.tgname = 'import_people_guard' AND NOT t.tgisinternal AND t.tgenabled = 'O'
          AND t.tgfoid = to_regprocedure('public.import_people_guard()')
          AND t.tgrelid IN ('public.invoices'::regclass, 'public.purchase_orders'::regclass, 'public.delivery_notes'::regclass))
-- 8. The record keys and saved mappings take credit_notes and delivery_notes.
UNION ALL SELECT 'kinds_accepted',
       (SELECT count(*) = 2 FROM pg_constraint k WHERE k.conname IN ('import_mappings_kind_check', 'import_record_keys_kind_check') AND k.convalidated
          AND pg_get_constraintdef(k.oid) LIKE '%credit_notes%' AND pg_get_constraintdef(k.oid) LIKE '%delivery_notes%')
-- 9. The tables 085 writes keep their guards: row audit, support read-only, admin two-step, RLS (none of them is new).
UNION ALL SELECT 'written_tables_guarded',
       (SELECT count(*) = 5 FROM pg_class c WHERE c.oid IN ('public.credit_notes'::regclass, 'public.credit_note_lines'::regclass, 'public.delivery_notes'::regclass,
                                                           'public.delivery_note_items'::regclass, 'public.invoice_credit_allocations'::regclass)
          AND c.relrowsecurity
          AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only')
          AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'admin_mfa')
          AND (c.relname = 'invoice_credit_allocations' OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_' || c.relname || '_changes')))
-- 10. Under pg-safeupdate (Supabase's API sessions): no import function has an UPDATE or DELETE without its own WHERE.
UNION ALL SELECT 'import_functions_where_qualified', (SELECT count(*) >= 19 FROM fn) AND NOT EXISTS (SELECT 1 FROM unqualified);
