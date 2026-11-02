-- Rehearsal checks that need a signed-in user: numbering continues from the import, the imported records are visible only to the
-- imported company, and issued imported invoices cannot be edited. Synthetic tenants from setup-tenants.sql. Runs in ONE
-- transaction that is ROLLED BACK, so it can be repeated and leaves the rehearsal database as the import left it.
--
--   psql -h 127.0.0.1 -U postgres -d sliq_rehearsal -X -At -v ON_ERROR_STOP=1 -f scripts/sliq-import/rehearsal/tenant-checks.sql
--
-- Every result line is "PASS|<check>|<detail>" or "FAIL|<check>|<detail>". A signed-in user is simulated as PostgREST does it:
-- role authenticated plus the token's claims (sub, session_id, aal2) in request.jwt.claims.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
begin;
set local timezone to 'UTC';
select id as org_a from public.organizations where slug = 'rehearsal-a' \gset
select id as org_b from public.organizations where slug = 'rehearsal-b' \gset
\set admin_a '{"sub":"7e570000-0000-4000-8000-0000000000a1","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005a1","aal":"aal2","email":"admin.a@rehearsal.example.test"}'
\set office_a '{"sub":"7e570000-0000-4000-8000-0000000000a2","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005a2","aal":"aal2","email":"office.a@rehearsal.example.test"}'
\set admin_b '{"sub":"7e570000-0000-4000-8000-0000000000b1","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005b1","aal":"aal2","email":"admin.b@rehearsal.example.test"}'

create schema rehearsal_chk;
grant usage on schema rehearsal_chk to authenticated;
create table rehearsal_chk.out (n serial, line text);
grant all on rehearsal_chk.out to authenticated;
grant usage on sequence rehearsal_chk.out_n_seq to authenticated;
create function rehearsal_chk.ok(p_check text, p_ok boolean, p_detail text) returns void language sql as $f$
  insert into rehearsal_chk.out (line) values ((case when p_ok then 'PASS' else 'FAIL' end) || '|' || p_check || '|' || coalesce(p_detail, ''))
$f$;
-- p_sql must be refused (any error). It runs in a subtransaction.
create function rehearsal_chk.refused(p_check text, p_sql text) returns void language plpgsql as $f$
begin
  begin
    execute p_sql;
  exception when others then
    perform rehearsal_chk.ok(p_check, true, 'refused: ' || left(sqlerrm, 100));
    return;
  end;
  perform rehearsal_chk.ok(p_check, false, 'it was ALLOWED');
end
$f$;
-- p_sql must change no row (refused, or filtered to nothing by RLS).
create function rehearsal_chk.no_rows(p_check text, p_sql text) returns void language plpgsql as $f$
declare n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
  exception when others then
    perform rehearsal_chk.ok(p_check, true, 'refused: ' || left(sqlerrm, 100));
    return;
  end;
  perform rehearsal_chk.ok(p_check, n = 0, n || ' row(s) changed');
end
$f$;
grant execute on all functions in schema rehearsal_chk to authenticated;

-- What the import put in A, as the owner sees it (the yardstick for what each user may see).
create table rehearsal_chk.truth as
  select t, n from (values
    ('customers',          (select count(*) from public.customers          where organization_id = :'org_a')),
    ('suppliers',          (select count(*) from public.suppliers          where organization_id = :'org_a')),
    ('invoices',           (select count(*) from public.invoices           where organization_id = :'org_a')),
    ('invoice_line_items', (select count(*) from public.invoice_line_items where organization_id = :'org_a')),
    ('invoice_payments',   (select count(*) from public.invoice_payments   where organization_id = :'org_a')),
    ('quotes',             (select count(*) from public.quotes             where organization_id = :'org_a')),
    ('quote_line_items',   (select count(*) from public.quote_line_items   where organization_id = :'org_a')),
    ('purchase_orders',    (select count(*) from public.purchase_orders    where organization_id = :'org_a'))) v(t, n);
grant select on rehearsal_chk.truth to authenticated;
create table rehearsal_chk.b_before as select (select count(*) from public.customers where organization_id = :'org_b') c,
  (select count(*) from public.invoices where organization_id = :'org_b') i, (select count(*) from public.quotes where organization_id = :'org_b') q,
  (select count(*) from public.purchase_orders where organization_id = :'org_b') p;
select id as imported_inv, invoice_ref as imported_ref, total::text as imported_total from public.invoices
  where organization_id = :'org_a' and status = 'paid' order by invoice_ref limit 1 \gset
select id as imported_quote from public.quotes where organization_id = :'org_a' order by quote_ref limit 1 \gset
select name as a_supplier from public.suppliers where organization_id = :'org_a' order by name limit 1 \gset

-- ---- 1. Isolation: tenant B sees none of A's imported rows, A's users see all of them ------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'admin_b', true) is not null as c \gset
select rehearsal_chk.ok('rls: tenant B admin sees none of A''s ' || t, n = 0, n || ' visible') from (values
  ('customers',          (select count(*) from public.customers          where organization_id = :'org_a')),
  ('suppliers',          (select count(*) from public.suppliers          where organization_id = :'org_a')),
  ('invoices',           (select count(*) from public.invoices           where organization_id = :'org_a')),
  ('invoice_line_items', (select count(*) from public.invoice_line_items where organization_id = :'org_a')),
  ('invoice_payments',   (select count(*) from public.invoice_payments   where organization_id = :'org_a')),
  ('quotes',             (select count(*) from public.quotes             where organization_id = :'org_a')),
  ('quote_line_items',   (select count(*) from public.quote_line_items   where organization_id = :'org_a')),
  ('purchase_orders',    (select count(*) from public.purchase_orders    where organization_id = :'org_a'))) v(t, n);
select rehearsal_chk.ok('rls: tenant B admin still sees its own invoice INV-1000', (select count(*) from public.invoices where invoice_ref = 'INV-1000') = 1, 'own rows visible');
select rehearsal_chk.no_rows('rls: tenant B cannot update A''s imported invoice', format('update public.invoices set customer = %L where id = %L', 'x', :'imported_inv'));
select rehearsal_chk.no_rows('rls: tenant B cannot delete A''s imported quote', format('delete from public.quotes where id = %L', :'imported_quote'));
select rehearsal_chk.refused('rls: tenant B cannot add a payment to A''s invoice', format(
  'insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, method) values (%L, %L, 1, current_date, %L)', :'org_b', :'imported_inv', 'BACS'));
select rehearsal_chk.refused('rls: no signed-in user can read the import map', 'select count(*) from public.legacy_import_map');
select rehearsal_chk.refused('rls: no signed-in user can read the rehearsal identity', 'select count(*) from public.rehearsal_identity');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'office_a', true) is not null as c \gset
select rehearsal_chk.ok('rls: tenant A office user sees every imported ' || v.t, v.n = tr.n, v.n || ' of ' || tr.n) from (values
  ('customers',          (select count(*) from public.customers          where organization_id = :'org_a')),
  ('suppliers',          (select count(*) from public.suppliers          where organization_id = :'org_a')),
  ('invoices',           (select count(*) from public.invoices           where organization_id = :'org_a')),
  ('invoice_line_items', (select count(*) from public.invoice_line_items where organization_id = :'org_a')),
  ('invoice_payments',   (select count(*) from public.invoice_payments   where organization_id = :'org_a')),
  ('quotes',             (select count(*) from public.quotes             where organization_id = :'org_a')),
  ('quote_line_items',   (select count(*) from public.quote_line_items   where organization_id = :'org_a')),
  ('purchase_orders',    (select count(*) from public.purchase_orders    where organization_id = :'org_a'))) v(t, n) join rehearsal_chk.truth tr using (t);
select rehearsal_chk.ok('rls: tenant A office user sees none of B''s invoices', (select count(*) from public.invoices where organization_id = :'org_b') = 0, 'B rows hidden');

-- ---- 2. Imported issued invoices are read only (as the office user, then the admin) -------------------------------------------
select rehearsal_chk.no_rows('read-only: office cannot change an imported paid invoice''s total', format(
  'update public.invoices set total = total + 1 where id = %L and total = %L::numeric', :'imported_inv', :'imported_total'));
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'admin_a', true) is not null as c \gset
select rehearsal_chk.no_rows('read-only: admin cannot change an imported paid invoice''s total', format(
  'update public.invoices set total = total + 1 where id = %L', :'imported_inv'));
select rehearsal_chk.no_rows('read-only: admin cannot delete an imported invoice', format('delete from public.invoices where id = %L', :'imported_inv'));
select rehearsal_chk.no_rows('read-only: admin cannot change an imported invoice''s lines', format(
  'update public.invoice_line_items set unit_price = unit_price + 1 where invoice_id = %L', :'imported_inv'));
select rehearsal_chk.no_rows('read-only: admin cannot change an imported legacy payment', format(
  'update public.invoice_payments set amount = amount + 1 where invoice_id = %L', :'imported_inv'));
reset role;
select rehearsal_chk.ok('read-only: the imported invoice is unchanged', (select total::text from public.invoices where id = :'imported_inv') = :'imported_total', :'imported_ref' || ' total ' || :'imported_total');

-- ---- 3. Numbering continues: one new quote, invoice and purchase order through the app's RPCs, as tenant A's office user --------
set local role authenticated;
select set_config('request.jwt.claims', :'office_a', true) is not null as c \gset
select public.next_doc_number('QUO') as q_ref \gset
select public.create_with_lines('quotes',
  jsonb_build_object('quote_ref', :'q_ref', 'customer', 'Harbour Fabrication Ltd', 'description', 'Rehearsal quote', 'total_value', 120, 'vat_enabled', true, 'status', 'draft'),
  'quote_line_items', 'quote_id', '[{"position":0,"description":"Rehearsal part","quantity":1,"unit_price":100,"vat_pct":20}]'::jsonb) as q_id \gset
select rehearsal_chk.ok('numbering: the next quote after the import is QUO-1483', :'q_ref' = 'QUO-1483', :'q_ref');
select public.create_with_lines('invoices',
  jsonb_build_object('customer', 'Harbour Fabrication Ltd', 'description', 'Rehearsal part', 'quantity', 1, 'unit_price', 100, 'subtotal', 100, 'carriage', 0,
    'vat', 20, 'total', 120, 'vat_enabled', true, 'carriage_vat', true, 'invoice_date', '2026-11-02', 'due_date', '2026-12-02', 'terms', '30 days', 'status', 'draft', 'amount_paid', 0),
  'invoice_line_items', 'invoice_id', '[{"position":0,"description":"Rehearsal part","quantity":1,"unit_price":100,"vat_pct":20,"vat_exempt":false}]'::jsonb) as inv_id \gset
select public.issue_invoice(:'inv_id') as inv_ref \gset
select rehearsal_chk.ok('numbering: the first invoice issued after the import is INV-2315', :'inv_ref' = 'INV-2315', :'inv_ref');
select public.next_doc_number('PO') as po_ref \gset
insert into public.purchase_orders (organization_id, po_ref, po_number, supplier, order_date, items, total_value, vat_enabled, status)
  values (:'org_a', :'po_ref', :'po_ref', :'a_supplier', '2026-11-02', '[{"description":"Bar","qty":1,"unit_price":10,"vat_pct":20,"vat_exempt":false}]', 10, true, 'draft');
select rehearsal_chk.ok('numbering: the next purchase order after the import is PO-0159', :'po_ref' = 'PO-0159', :'po_ref');
reset role;
select rehearsal_chk.ok('numbering: tenant B''s counters were not touched by A''s import',
  not exists (select 1 from public.doc_counters where organization_id = :'org_b' and last in (1482, 2314, 158)),
  coalesce((select string_agg(prefix || '=' || last, ',' order by prefix) from public.doc_counters where organization_id = :'org_b'), 'no counters'));
select rehearsal_chk.ok('isolation: tenant B''s own rows are unchanged', (select (c, i, q, p) = (1, 1, 1, 1) from rehearsal_chk.b_before)
  and (select count(*) from public.customers where organization_id = :'org_b') = 1 and (select count(*) from public.invoices where organization_id = :'org_b') = 1, 'B: 1 customer, 1 invoice, 1 quote, 1 PO');

select line from rehearsal_chk.out order by n;
rollback;
