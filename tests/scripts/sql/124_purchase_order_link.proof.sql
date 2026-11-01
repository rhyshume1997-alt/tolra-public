-- Local proof for migration 124 (a supplier purchase order linked to the customer quote or job it was bought for). Run on a COPY of a
-- database with the chain applied plus 124:
--   createdb e_124 -T base; psql -d e_124 -f supabase/release/124_purchase_order_link.release.sql; psql -X -d e_124 -f this
-- Everything runs in one transaction that is rolled back. Prints one PASS or FAIL line per check, then TOTAL n/m.
-- The same rules through the API: tests/db/purchase-order-link-124.test.ts.
\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE r(n serial, name text, ok boolean);
GRANT ALL ON r TO PUBLIC; GRANT ALL ON SEQUENCE r_n_seq TO PUBLIC;
INSERT INTO public.organizations(id, name, slug) VALUES ('a0000000-0000-0000-0000-000000000124', 'Alpha 124', 'alpha-124'), ('b0000000-0000-0000-0000-000000000124', 'Beta 124', 'beta-124');
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-0000-0000-0000000001a1', 'office.a124@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES ('a0000000-0000-0000-0000-0000000001a1', 'office.a124@example.test', 'office', 'a0000000-0000-0000-0000-000000000124')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections) VALUES ('a0000000-0000-0000-0000-0000000001a1', 'a0000000-0000-0000-0000-000000000124', 'office', '{}');
INSERT INTO public.suppliers(organization_id, name) VALUES ('a0000000-0000-0000-0000-000000000124', 'Steel Co'), ('a0000000-0000-0000-0000-000000000124', 'Other Co');
INSERT INTO public.quotes(id, organization_id, quote_ref, customer) VALUES
  ('a1000000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000124', 'Q-A1', 'Acme'),
  ('a1100000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000124', 'Q-A2', 'Acme'),
  ('b1000000-0000-0000-0000-000000000124', 'b0000000-0000-0000-0000-000000000124', 'Q-B1', 'Other');
INSERT INTO public.jobs(id, organization_id, job_no, customer) VALUES
  ('a2000000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000124', 'J-A1', 'Acme'),
  ('a2200000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000124', 'J-A2', 'Acme'),
  ('b2000000-0000-0000-0000-000000000124', 'b0000000-0000-0000-0000-000000000124', 'J-B1', 'Other');
INSERT INTO public.purchase_orders(id, organization_id, po_ref, po_number, supplier, status, total_value, items) VALUES
  ('a3000000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000124', 'PO-A1', 'PO-A1', 'Steel Co', 'draft', 100.00, '[{"description":"Bar","qty":1,"unit_price":100}]'),
  ('a3300000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000124', 'PO-A2', 'PO-A2', 'Steel Co', 'draft', 100.00, '[{"description":"Bar","qty":1,"unit_price":100}]');

CREATE FUNCTION pg_temp.refused(sql text, code text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN EXECUTE sql; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE = code; END;
  RETURN FALSE;
END $f$;
-- One statement as p_role ('service_role', or a user id: signed in as that user, aal2); 'ok' or the SQLSTATE. Nothing it did is kept
-- when it fails (its own subtransaction).
CREATE FUNCTION pg_temp.try(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_state text;
BEGIN
  IF p_role = 'service_role' THEN
    SET LOCAL ROLE service_role;
  ELSE
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_role, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_role, true);
    SET LOCAL ROLE authenticated;
  END IF;
  BEGIN
    EXECUTE p_sql;
    RESET ROLE;
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RESET ROLE;
    RETURN v_state;
  END;
END $f$;
GRANT EXECUTE ON FUNCTION pg_temp.try(text, text) TO PUBLIC;
-- The order's row without the columns the clock and the actor stamp move on every update.
CREATE FUNCTION pg_temp.po_row(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT to_jsonb(p) - 'updated_at' - 'updated_by' FROM public.purchase_orders p WHERE p.id = p_id
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.po_row(uuid) TO PUBLIC;

-- Every column of purchase_orders except the ones open after issue, each with a changed value. 076's open list: status, sent_at,
-- received_at, expected_delivery, notes, updated_at, updated_by; 124 adds quote_id, job_id, linked_net and nothing else.
CREATE TEMP TABLE locked(col text PRIMARY KEY, val text);
INSERT INTO locked VALUES
  ('id', 'gen_random_uuid()'), ('organization_id', '''b0000000-0000-0000-0000-000000000124'''), ('po_ref', '''PO-OTHER'''),
  ('po_number', '''PO-OTHER'''), ('supplier', '''Other Co'''), ('order_date', 'order_date + 1'), ('items', '''[]'''),
  ('total_value', '1'), ('created_by', '''a0000000-0000-0000-0000-0000000001a1'''), ('created_at', 'created_at - interval ''1 day'''),
  ('vat_enabled', 'NOT vat_enabled'), ('received_by', '''a0000000-0000-0000-0000-0000000001a1'''), ('sent_by_name', '''Someone Else'''),
  ('sent_by_user_id', '''a0000000-0000-0000-0000-0000000001a1''');
GRANT SELECT ON locked TO PUBLIC;
-- p_po issued: each locked column, changed alone as p_role, is refused (42501) or (see below) not kept. 'col:outcome' for every leak.
CREATE FUNCTION pg_temp.locked_leaks(p_role text, p_po uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE c record; v_before jsonb; v_out text; v_leaks text[] := '{}';
BEGIN
  FOR c IN SELECT col, val FROM locked ORDER BY col LOOP
    v_before := pg_temp.po_row(p_po);
    v_out := pg_temp.try(p_role, format('UPDATE public.purchase_orders SET %I = %s WHERE id = %L', c.col, c.val, p_po));
    -- refused by the issue lock (42501); or, for a signed-in user, created_by and received_by only: accepted with nothing changed, because
    -- actor_keep (aa_actor_keep, which runs before the lock) has already put the old value back. Any other outcome is a leak.
    IF NOT (v_out = '42501' OR (v_out = 'ok' AND p_role <> 'service_role' AND c.col IN ('created_by', 'received_by') AND pg_temp.po_row(p_po) = v_before)) THEN
      v_leaks := v_leaks || (c.col || ':' || v_out);
    END IF;
    IF pg_temp.po_row(p_po) IS DISTINCT FROM v_before THEN v_leaks := v_leaks || (c.col || ':changed'); END IF;
  END LOOP;
  RETURN array_to_string(v_leaks, ', ');
END $f$;
GRANT EXECUTE ON FUNCTION pg_temp.locked_leaks(text, uuid) TO PUBLIC;
-- The open columns 124 adds, each changed alone on an issued p_po as p_role: 'ok' for each, comma separated.
CREATE FUNCTION pg_temp.links_open(p_role text, p_po uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.try(p_role, format('UPDATE public.purchase_orders SET quote_id = %L WHERE id = %L', 'a1100000-0000-0000-0000-000000000124', p_po))
    || ',' || pg_temp.try(p_role, format('UPDATE public.purchase_orders SET job_id = %L WHERE id = %L', 'a2200000-0000-0000-0000-000000000124', p_po))
    || ',' || pg_temp.try(p_role, format('UPDATE public.purchase_orders SET linked_net = 12.34 WHERE id = %L', p_po))
$f$;

-- 0. The list above covers every column of purchase_orders that is not open after issue.
INSERT INTO r(name, ok) SELECT 'locked list = every column except 076''s open list and 124''s three (' || count(*) || ' columns)',
  array_agg(column_name::text ORDER BY column_name) = (SELECT array_agg(col ORDER BY col) FROM locked)
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'purchase_orders'
    AND column_name NOT IN ('status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by', 'quote_id', 'job_id', 'linked_net');

-- 1. Cross-company links refused (as postgres: the trigger fires for everyone), on UPDATE and INSERT; same company accepted.
INSERT INTO r(name, ok) SELECT 'cross-company quote link refused (update)', pg_temp.refused($$UPDATE public.purchase_orders SET quote_id = 'b1000000-0000-0000-0000-000000000124' WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '23514');
INSERT INTO r(name, ok) SELECT 'cross-company job link refused (update)', pg_temp.refused($$UPDATE public.purchase_orders SET job_id = 'b2000000-0000-0000-0000-000000000124' WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '23514');
INSERT INTO r(name, ok) SELECT 'cross-company quote link refused (insert)', pg_temp.refused($$INSERT INTO public.purchase_orders(organization_id, po_ref, supplier, status, quote_id) VALUES ('a0000000-0000-0000-0000-000000000124', 'PO-X', 'Steel Co', 'draft', 'b1000000-0000-0000-0000-000000000124')$$, '23514');
INSERT INTO r(name, ok) SELECT 'cross-company job link refused (insert)', pg_temp.refused($$INSERT INTO public.purchase_orders(organization_id, po_ref, supplier, status, job_id) VALUES ('a0000000-0000-0000-0000-000000000124', 'PO-X', 'Steel Co', 'draft', 'b2000000-0000-0000-0000-000000000124')$$, '23514');
INSERT INTO r(name, ok) SELECT 'negative allocated amount refused', pg_temp.refused($$UPDATE public.purchase_orders SET linked_net = -0.01 WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '23514');
UPDATE public.purchase_orders SET quote_id = 'a1000000-0000-0000-0000-000000000124', job_id = 'a2000000-0000-0000-0000-000000000124', linked_net = 40.00 WHERE id = 'a3000000-0000-0000-0000-000000000124';
INSERT INTO r(name, ok) SELECT 'same-company links accepted', quote_id IS NOT NULL AND job_id IS NOT NULL AND linked_net = 40.00 FROM public.purchase_orders WHERE id = 'a3000000-0000-0000-0000-000000000124';
-- Moving the PO to the other company while it is linked: refused (the trigger also fires on organization_id).
INSERT INTO r(name, ok) SELECT 'moving a linked PO to another company refused', pg_temp.refused($$UPDATE public.purchase_orders SET organization_id = 'b0000000-0000-0000-0000-000000000124' WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '23514');

-- 2. Issued: as an API role (service_role: is_api_role true, past row rules), the links and amount still change; supplier and value do not.
SET LOCAL ROLE service_role;
UPDATE public.purchase_orders SET status = 'issued' WHERE id = 'a3000000-0000-0000-0000-000000000124';
UPDATE public.purchase_orders SET quote_id = 'a1100000-0000-0000-0000-000000000124', linked_net = NULL WHERE id = 'a3000000-0000-0000-0000-000000000124';
UPDATE public.purchase_orders SET quote_id = 'a1000000-0000-0000-0000-000000000124', linked_net = 25.50 WHERE id = 'a3000000-0000-0000-0000-000000000124';
INSERT INTO r(name, ok) SELECT 'issued PO: link and amount still change', quote_id = 'a1000000-0000-0000-0000-000000000124' AND linked_net = 25.50 FROM public.purchase_orders WHERE id = 'a3000000-0000-0000-0000-000000000124';
INSERT INTO r(name, ok) SELECT 'issued PO: value still fixed (42501)', pg_temp.refused($$UPDATE public.purchase_orders SET total_value = 1 WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '42501');
INSERT INTO r(name, ok) SELECT 'issued PO: supplier/items still fixed (42501)', pg_temp.refused($$UPDATE public.purchase_orders SET items = '[]' WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '42501');
INSERT INTO r(name, ok) SELECT 'issued PO: still cannot be deleted (42501)', pg_temp.refused($$DELETE FROM public.purchase_orders WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '42501');
INSERT INTO r(name, ok) SELECT 'issued PO: still cannot go back to draft (42501)', pg_temp.refused($$UPDATE public.purchase_orders SET status = 'draft' WHERE id = 'a3000000-0000-0000-0000-000000000124'$$, '42501');
RESET ROLE;

-- 2b. ONLY quote_id, job_id and linked_net open up after issue. On the second order, issued and linked: as service_role and as a signed-in
-- office user, every locked column changed alone is refused (42501), each of the three changes alone, and 076's open columns still do.
UPDATE public.purchase_orders SET quote_id = 'a1000000-0000-0000-0000-000000000124', job_id = 'a2000000-0000-0000-0000-000000000124', linked_net = 10 WHERE id = 'a3300000-0000-0000-0000-000000000124';
SELECT pg_temp.try('service_role', $$UPDATE public.purchase_orders SET status = 'issued' WHERE id = 'a3300000-0000-0000-0000-000000000124'$$) AS issued \gset
INSERT INTO r(name, ok) VALUES ('2b: second order issued', :'issued' = 'ok');
SELECT pg_temp.locked_leaks('service_role', 'a3300000-0000-0000-0000-000000000124') AS leaks_sr \gset
INSERT INTO r(name, ok) VALUES ('2b service_role: every locked column refused (42501) [' || :'leaks_sr' || ']', :'leaks_sr' = '');
SELECT pg_temp.locked_leaks('a0000000-0000-0000-0000-0000000001a1', 'a3300000-0000-0000-0000-000000000124') AS leaks_office \gset
INSERT INTO r(name, ok) VALUES ('2b office user: every locked column refused (42501; created_by, received_by kept by actor_keep) [' || :'leaks_office' || ']', :'leaks_office' = '');
SELECT pg_temp.links_open('service_role', 'a3300000-0000-0000-0000-000000000124') AS open_sr \gset
INSERT INTO r(name, ok) SELECT '2b service_role: quote_id, job_id, linked_net each change alone [' || :'open_sr' || ']',
  :'open_sr' = 'ok,ok,ok' AND quote_id = 'a1100000-0000-0000-0000-000000000124' AND job_id = 'a2200000-0000-0000-0000-000000000124' AND linked_net = 12.34
  FROM public.purchase_orders WHERE id = 'a3300000-0000-0000-0000-000000000124';
UPDATE public.purchase_orders SET quote_id = 'a1000000-0000-0000-0000-000000000124', job_id = 'a2000000-0000-0000-0000-000000000124', linked_net = 10 WHERE id = 'a3300000-0000-0000-0000-000000000124';
SELECT pg_temp.links_open('a0000000-0000-0000-0000-0000000001a1', 'a3300000-0000-0000-0000-000000000124') AS open_office \gset
INSERT INTO r(name, ok) SELECT '2b office user: quote_id, job_id, linked_net each change alone [' || :'open_office' || ']',
  :'open_office' = 'ok,ok,ok' AND quote_id = 'a1100000-0000-0000-0000-000000000124' AND job_id = 'a2200000-0000-0000-0000-000000000124' AND linked_net = 12.34
  FROM public.purchase_orders WHERE id = 'a3300000-0000-0000-0000-000000000124';
SELECT pg_temp.try('a0000000-0000-0000-0000-0000000001a1', $$UPDATE public.purchase_orders SET expected_delivery = '2099-02-01', notes = 'moved', sent_at = now() WHERE id = 'a3300000-0000-0000-0000-000000000124'$$) AS open076 \gset
INSERT INTO r(name, ok) VALUES ('2b office user: 076''s open columns (delivery date, notes, sent) still change', :'open076' = 'ok');
SELECT pg_temp.try('a0000000-0000-0000-0000-0000000001a1', $$UPDATE public.purchase_orders SET quote_id = 'b1000000-0000-0000-0000-000000000124' WHERE id = 'a3300000-0000-0000-0000-000000000124'$$) AS cross_issued \gset
INSERT INTO r(name, ok) VALUES ('2b office user: issued PO linked to another company''s quote refused (23514)', :'cross_issued' = '23514');
SELECT pg_temp.try('a0000000-0000-0000-0000-0000000001a1', $$UPDATE public.purchase_orders SET linked_net = -1 WHERE id = 'a3300000-0000-0000-0000-000000000124'$$) AS neg_issued \gset
INSERT INTO r(name, ok) VALUES ('2b office user: issued PO negative amount refused (23514)', :'neg_issued' = '23514');
-- A link and a locked column in one statement: refused whole (the link does not slip through on its own).
SELECT pg_temp.try('a0000000-0000-0000-0000-0000000001a1', $$UPDATE public.purchase_orders SET job_id = NULL, total_value = 1 WHERE id = 'a3300000-0000-0000-0000-000000000124'$$) AS mixed \gset
INSERT INTO r(name, ok) SELECT '2b office user: link plus value in one update refused whole (42501)', :'mixed' = '42501' AND job_id IS NOT NULL AND total_value = 100.00
  FROM public.purchase_orders WHERE id = 'a3300000-0000-0000-0000-000000000124';

-- 3. ON DELETE SET NULL on an issued PO, deleting as the API role: the quote, then the job, go; the PO stays, unlinked, value unchanged.
SET LOCAL ROLE service_role;
DELETE FROM public.quotes WHERE id = 'a1000000-0000-0000-0000-000000000124';
INSERT INTO r(name, ok) SELECT 'quote deleted: PO quote_id set null, PO kept', quote_id IS NULL AND job_id IS NOT NULL AND total_value = 100.00 AND status = 'issued' FROM public.purchase_orders WHERE id = 'a3000000-0000-0000-0000-000000000124';
DELETE FROM public.jobs WHERE id = 'a2000000-0000-0000-0000-000000000124';
INSERT INTO r(name, ok) SELECT 'job deleted: PO job_id set null, PO kept', quote_id IS NULL AND job_id IS NULL AND total_value = 100.00 FROM public.purchase_orders WHERE id = 'a3000000-0000-0000-0000-000000000124';
RESET ROLE;

-- 4. The control: with 076's lock put back (inside a savepoint, its md5 checked), the three link columns are locked after issue too and
-- the delete of a quote an issued PO points at is refused; the locked columns are locked exactly the same. So 124 opens those three only.
UPDATE public.purchase_orders SET quote_id = 'a1100000-0000-0000-0000-000000000124' WHERE id = 'a3000000-0000-0000-0000-000000000124';
-- (as postgres, past the lock) the second order unlinked again, so each change the control tries is a real change
UPDATE public.purchase_orders SET quote_id = NULL, job_id = NULL, linked_net = NULL WHERE id = 'a3300000-0000-0000-0000-000000000124';
SAVEPOINT old_lock;
CREATE OR REPLACE FUNCTION public.purchase_order_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- Still open after issue: progress (status, sent/received times), the supplier's delivery date and notes.
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by'];
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t be deleted.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t go back to draft.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Purchase order % has been issued: its supplier, items and value can''t be changed (delivery date, notes and progress can).', OLD.po_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '27924815917836092f18d3dd58d87c23' AS is076 FROM pg_proc WHERE oid = 'public.purchase_order_issue_lock()'::regprocedure \gset
SET LOCAL ROLE service_role;
SELECT pg_temp.refused($$DELETE FROM public.quotes WHERE id = 'a1100000-0000-0000-0000-000000000124'$$, '42501') AS ctl \gset
RESET ROLE;
SELECT pg_temp.links_open('service_role', 'a3300000-0000-0000-0000-000000000124') AS ctl_open \gset
SELECT pg_temp.locked_leaks('service_role', 'a3300000-0000-0000-0000-000000000124') AS ctl_leaks \gset
ROLLBACK TO SAVEPOINT old_lock;
INSERT INTO r(name, ok) VALUES ('control: the lock put back is 076''s (md5)', :'is076'::boolean);
INSERT INTO r(name, ok) VALUES ('control: with 076''s lock, the cascade from deleting the quote is refused (42501)', :'ctl'::boolean);
INSERT INTO r(name, ok) VALUES ('control: with 076''s lock, quote_id, job_id, linked_net are each refused [' || :'ctl_open' || ']', :'ctl_open' = '42501,42501,42501');
INSERT INTO r(name, ok) VALUES ('control: with 076''s lock, the locked columns are locked the same [' || :'ctl_leaks' || ']', :'ctl_leaks' = '');
INSERT INTO r(name, ok) SELECT 'after the control: 124''s lock is back', md5(regexp_replace(prosrc, '\s', '', 'g')) = '9f903e888bca6d55322cc877488c1019' FROM pg_proc WHERE oid = 'public.purchase_order_issue_lock()'::regprocedure;

SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || name FROM r ORDER BY n;
SELECT 'TOTAL ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM r;
ROLLBACK;
