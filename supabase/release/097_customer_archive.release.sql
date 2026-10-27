-- 097_customer_archive.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 097: customers can be archived (never deleted once used). NUMBERING (provisional): 096 is reserved for another job; numbers
-- are settled at merge. Needs 028 (record_archive_state, set_archive_state) and 082 (customers_in_use_guard). Touches none of
-- 083 to 095's objects.
--
-- Admin and office archive a customer the way they archive every other record (028's Archive / Unarchive): the choice is a row
-- in public.record_archive_state, written only through public.set_archive_state, and the customer row itself is never changed.
-- An archived customer is left out of the customer pickers for new documents and out of the default Customers list (the
-- "Archived" filter shows it); documents that already name it keep showing it. Unarchive ('auto') removes the row.
--
-- Hard delete is unchanged and stays refused in the database for any customer that is used: 082's customers_in_use_guard
-- (BEFORE DELETE on public.customers, for signed-in users) refuses a customer named on any quote, RFQ, sales order, job,
-- delivery note, invoice or credit note (22023, hint customer_in_use). The app has no delete button; an unused customer may
-- still be deleted by admin or office through the API (006's row rules), as before.
--
-- WHAT CHANGES. No new table, row, trigger, policy or grant.
--   a. public.record_archive_state: its record_table check also allows 'customers' (028's six tables plus one).
--   b. public.set_archive_state: 028's text with 'customers' added to the tables it accepts. Same signature, definer, search_path,
--      grants; same role rule (admin and office) and same-company rule (another company's customer: P0002 not found).
-- GUARD (section 1): set_archive_state must be 028's (or already 097's), md5 with every whitespace character removed, and the
-- check must be 028's (or already 097's). Safe to run again.
-- SELF-CHECK (section 4). Rollback: supabase/release/097_customer_archive.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: set_archive_state is 028's (or already 097's); the record_table check is 028's (or already 097's).
DO $$
DECLARE
  v_fn  TEXT;
  v_chk TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_archive_state(text,uuid,text)') INTO v_fn;
  -- 4b31a2b95d2c7c52e9c31fe660a7e61b: 028's set_archive_state; 0b3bc80a57f0e0e16e4f0d7f42c5eccf: this file's (section 3); both with every whitespace character removed.
  IF v_fn IS NULL OR v_fn NOT IN ('4b31a2b95d2c7c52e9c31fe660a7e61b', '0b3bc80a57f0e0e16e4f0d7f42c5eccf') THEN
    RAISE EXCEPTION '097: public.set_archive_state is not 028''s (md5 without whitespace %); stop and compare it first', coalesce(v_fn, 'missing');
  END IF;
  SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public.record_archive_state') AND c.conname = 'record_archive_state_record_table_check' INTO v_chk;
  IF v_chk IS NULL OR v_chk NOT IN (
    'CHECK ((record_table = ANY (ARRAY[''jobs''::text, ''quotes''::text, ''invoices''::text, ''purchase_orders''::text, ''sales_orders''::text, ''delivery_notes''::text])))',
    'CHECK ((record_table = ANY (ARRAY[''jobs''::text, ''quotes''::text, ''invoices''::text, ''purchase_orders''::text, ''sales_orders''::text, ''delivery_notes''::text, ''customers''::text])))') THEN
    RAISE EXCEPTION '097: record_archive_state''s record_table check is not 028''s (%); stop and compare it first', coalesce(v_chk, 'missing');
  END IF;
  IF to_regprocedure('public.customers_in_use_guard()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.customers'::regclass AND tgname = 'customers_in_use_guard') THEN
    RAISE EXCEPTION '097: 082''s customers_in_use_guard is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. record_archive_state also holds customers' archive choices.
ALTER TABLE public.record_archive_state DROP CONSTRAINT IF EXISTS record_archive_state_record_table_check;
ALTER TABLE public.record_archive_state ADD CONSTRAINT record_archive_state_record_table_check
  CHECK (record_table IN ('jobs', 'quotes', 'invoices', 'purchase_orders', 'sales_orders', 'delivery_notes', 'customers'));

-- -----------------------------------------------------------------------------------------------------
-- 3. set_archive_state: 028's (supabase/migrations/028_record_archive.sql) with 'customers' added to the tables it accepts.
CREATE OR REPLACE FUNCTION public.set_archive_state(p_table TEXT, p_id UUID, p_state TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_record_org UUID;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin and office can archive records.' USING ERRCODE = '42501';
  END IF;
  IF p_table NOT IN ('jobs', 'quotes', 'invoices', 'purchase_orders', 'sales_orders', 'delivery_notes', 'customers') THEN
    RAISE EXCEPTION 'These records can''t be archived.' USING ERRCODE = '22023';
  END IF;
  IF p_state NOT IN ('archived', 'active', 'auto') THEN
    RAISE EXCEPTION 'Unknown archive state.' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', p_table) INTO v_record_org USING p_id;
  IF v_record_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'That record couldn''t be found.' USING ERRCODE = 'P0002';
  END IF;
  IF p_state = 'auto' THEN
    DELETE FROM public.record_archive_state WHERE record_table = p_table AND record_id = p_id;
  ELSE
    INSERT INTO public.record_archive_state (organization_id, record_table, record_id, state, set_by, set_at)
    VALUES (v_org, p_table, p_id, p_state, auth.uid(), now())
    ON CONFLICT (record_table, record_id) DO UPDATE SET state = EXCLUDED.state, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.set_archive_state(TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_archive_state(TEXT, UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check before COMMIT (the same checks as supabase/verify/customer_archive_097.sql).
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '0b3bc80a57f0e0e16e4f0d7f42c5eccf' OR NOT p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
             OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_archive_state(text,uuid,text)')) THEN
    RAISE EXCEPTION '097: set_archive_state is not 097''s after the replace';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.record_archive_state'::regclass AND c.conname = 'record_archive_state_record_table_check'
                   AND pg_get_constraintdef(c.oid) LIKE '%''customers''::text%') THEN
    RAISE EXCEPTION '097: record_archive_state does not accept customers after the change';
  END IF;
END
$$;

COMMIT;
