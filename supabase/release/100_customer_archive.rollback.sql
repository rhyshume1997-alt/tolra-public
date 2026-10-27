-- 100 rollback: ONLY with Rhys's approval. Puts back 028's public.set_archive_state byte for byte (same signature, security and
-- grants) and 028's record_table check on public.record_archive_state. Customers' archive choices are removed first (028's check
-- can't hold them): every archived customer shows again in the pickers and the Customers list. No customer row is changed; every
-- other record's archive choice is kept. Run the whole text as one transaction, then the release preflight (marker 100 shows
-- "not applied").
BEGIN;
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_archive_state(text,uuid,text)') INTO v_fn;
  -- 0b3bc80a...: 100's body; 4b31a2b9...: 028's (a second run of this rollback).
  IF v_fn IS NULL OR v_fn NOT IN ('0b3bc80a57f0e0e16e4f0d7f42c5eccf', '4b31a2b95d2c7c52e9c31fe660a7e61b') THEN
    RAISE EXCEPTION '100 rollback: set_archive_state (md5 %) is neither 100''s nor 028''s; stop and compare', coalesce(v_fn, 'missing');
  END IF;
END
$$;

DELETE FROM public.record_archive_state WHERE record_table = 'customers';
ALTER TABLE public.record_archive_state DROP CONSTRAINT IF EXISTS record_archive_state_record_table_check;
ALTER TABLE public.record_archive_state ADD CONSTRAINT record_archive_state_record_table_check
  CHECK (record_table IN ('jobs', 'quotes', 'invoices', 'purchase_orders', 'sales_orders', 'delivery_notes'));

-- 028's set_archive_state, verbatim (supabase/migrations/028_record_archive.sql).
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
  IF p_table NOT IN ('jobs', 'quotes', 'invoices', 'purchase_orders', 'sales_orders', 'delivery_notes') THEN
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

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '4b31a2b95d2c7c52e9c31fe660a7e61b' OR NOT p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
             OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_archive_state(text,uuid,text)')) THEN
    RAISE EXCEPTION '100 rollback: set_archive_state is not 028''s afterwards';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.record_archive_state'::regclass AND c.conname = 'record_archive_state_record_table_check'
               AND pg_get_constraintdef(c.oid) LIKE '%''customers''::text%') THEN
    RAISE EXCEPTION '100 rollback: record_archive_state still accepts customers';
  END IF;
END
$$;
COMMIT;
