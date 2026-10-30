-- =====================================================================================================================================
-- Issued invoice immutability proof (S5a). Plain SQL, runnable with psql against any database that has the migration chain applied
-- (the plain PostgreSQL stand-in, or the CI stack's database as the owner). Everything runs in ONE transaction that is ROLLED BACK at the
-- end: nothing is left behind, so it can be run again and again.
--
--   PGPASSWORD=... psql -h 127.0.0.1 -U postgres -d <db> -v ON_ERROR_STOP=1 -f tests/scripts/invoice-immutability-proof.sql
--
-- It exits non-zero (ON_ERROR_STOP) at the first property that does not hold, printing "FAIL <what>". Every check that holds prints
-- "ok ...". Known, deliberate exemptions print "GAP ..." (they are reported, not hidden, and do not fail the run).
--
-- As PostgREST runs a request: role authenticated with request.jwt.claims (sub, session_id, aal2), for an office member and an admin of
-- one synthetic company; the service role where it says so. Proves, for an ISSUED invoice:
--   1. no UPDATE changes its number, customer, description, quantity, price, VAT, carriage, totals, dates, terms, snapshots, issue
--      stamp or organization_id; nor amount paid / paid date / credited / refunded / the unverified flag by editing them;
--   2. its status can't go back to draft, or to paid / partial / credited / void by editing it;
--   3. its lines can't be inserted, changed, deleted or moved in or out;
--   4. it can't be deleted (nor a void one);
--   5. payments: only record_invoice_payment moves it to partial / paid; a payment can't exceed the balance due (no overpayment);
--      the payment rows can't be written directly;
--   6. void only via void_invoice, with a reason; refused with a payment or a credit note against it; a void invoice stays void and
--      immutable; the VOID_INVOICE audit row is written with the reason;
--   7. the INV number series never reuses a number (a void invoice keeps its number; a draft can't take one; the counter only rises);
--   8. the service role is held to the same lock (amounts, lines, delete, back to draft);
--   9. the lock triggers are plain (no WHEN clause), enabled in origin mode, and neither API role can set session_replication_role;
--  10. no integration (Xero) function writes invoices; the company's audit chain still verifies (links and hashes).
-- =====================================================================================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
begin;
set local timezone to 'UTC';            -- security_audit.set_audit_hash hashes created_at::text
set local client_min_messages to notice;

-- ---- fixture: one synthetic company (S5 Proof Alpha), an admin and an office member, each with a live aal2 session -----------------
insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('5e5e0000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'admin.s5proof@example.test', '{"full_name":"S5 Admin"}'),
  ('5e5e0000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'office.s5proof@example.test', '{"full_name":"S5 Office"}');
insert into auth.sessions (id, user_id, aal) values
  ('5e5e0000-0000-4000-8000-0000000000b1', '5e5e0000-0000-4000-8000-0000000000a1', 'aal2'),
  ('5e5e0000-0000-4000-8000-0000000000b2', '5e5e0000-0000-4000-8000-0000000000a2', 'aal2');
set local role service_role;
select public.create_organization('S5 Proof Alpha Ltd', 's5-proof-alpha', 'admin.s5proof@example.test',
  '{"documentName":"S5 Proof Alpha Ltd","addressLines":["Unit 1, Test Estate","Testtown","TE1 1ST"],"phone":"01000 000000","email":"office.s5proof@example.test","vatRegistered":true,"vatNumber":"GB 000 0000 00","defaultVatRate":20}'::jsonb) as org \gset
select public.add_member(:'org', 'office.s5proof@example.test', 'office') as added \gset
select public.create_organization('S5 Proof Beta Ltd', 's5-proof-beta', 'admin.s5proof@example.test',
  '{"documentName":"S5 Proof Beta Ltd","addressLines":["Unit 2"],"phone":"01000 000001","email":"beta.s5proof@example.test","vatRegistered":true,"vatNumber":"GB 000 0000 01","defaultVatRate":20}'::jsonb) as beta \gset
reset role;

-- ---- helpers (a scratch schema, rolled back with the rest) --------------------------------------------------------------------------
create schema s5proof;
grant usage on schema s5proof to authenticated, service_role;
create table s5proof.snap (k text primary key, v jsonb);
grant all on s5proof.snap to authenticated, service_role;

-- The statement must be refused (any error, or exactly p_code). It runs in a subtransaction, so nothing it did survives.
create function s5proof.refused(p_label text, p_sql text, p_code text default null, p_hint text default null) returns void
language plpgsql as $f$
declare v_state text; v_msg text; v_hint text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    if p_code is not null and v_state <> p_code then
      raise exception 'FAIL % : refused, but with % (%), expected %', p_label, v_state, v_msg, p_code;
    end if;
    if p_hint is not null and coalesce(v_hint, '') <> p_hint then
      raise exception 'FAIL % : refused, but with hint "%" (%), expected hint %', p_label, v_hint, v_msg, p_hint;
    end if;
    raise notice 'ok   refused  %  [% %]', p_label, v_state, left(v_msg, 110);
    return;
  end;
  raise exception 'FAIL % : it was ALLOWED', p_label;
end
$f$;
-- The statement must run and touch at least one row (an UPDATE that RLS filters to nothing is not "allowed").
create function s5proof.allowed(p_label text, p_sql text) returns void
language plpgsql as $f$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  if n < 1 then raise exception 'FAIL % : ran but changed no row', p_label; end if;
  raise notice 'ok   allowed  %', p_label;
end
$f$;
-- The statement must have no effect (no error, but no row: RLS has no policy for that command).
create function s5proof.no_effect(p_label text, p_sql text) returns void
language plpgsql as $f$
declare n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
  exception when others then
    raise notice 'ok   refused  %  [% %]', p_label, sqlstate, left(sqlerrm, 110);
    return;
  end;
  if n <> 0 then raise exception 'FAIL % : % row(s) changed', p_label, n; end if;
  raise notice 'ok   no rows  %', p_label;
end
$f$;
-- The statement must leave the invoice as it was: refused, or (for the actor stamps that 038's actor_keep puts back) run with no
-- effect on any stored value other than updated_at / updated_by.
create function s5proof.immutable(p_label text, p_sql text, p_inv uuid) returns void
language plpgsql as $f$
declare v_before jsonb := s5proof.state(p_inv); v_after jsonb;
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok   refused  %  [% %]', p_label, sqlstate, left(sqlerrm, 110);
    return;
  end;
  v_after := s5proof.state(p_inv);
  if (v_after #- '{invoice,updated_at}' #- '{invoice,updated_by}') is distinct from (v_before #- '{invoice,updated_at}' #- '{invoice,updated_by}') then
    raise exception 'FAIL % : it was ALLOWED and changed the stored invoice', p_label;
  end if;
  raise notice 'ok   kept     %  (ran, but the trigger put the stored value back)', p_label;
end
$f$;
create function s5proof.check(p_label text, p_ok boolean) returns void
language plpgsql as $f$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
  raise notice 'ok   holds    %', p_label;
end
$f$;
-- The whole stored invoice (every column) and its lines, as one value: compared before and after the refusals.
create function s5proof.state(p_inv uuid) returns jsonb
language sql security definer set search_path = pg_catalog, public as $f$
  select jsonb_build_object(
    'invoice', (select to_jsonb(i) from public.invoices i where i.id = p_inv),
    'lines', (select coalesce(jsonb_agg(to_jsonb(l) order by l.position, l.id), '[]') from public.invoice_line_items l where l.invoice_id = p_inv),
    'payments', (select count(*) from public.invoice_payments p where p.invoice_id = p_inv))
$f$;
grant execute on all functions in schema s5proof to authenticated, service_role;

\set office_claims '{"sub":"5e5e0000-0000-4000-8000-0000000000a2","role":"authenticated","aud":"authenticated","session_id":"5e5e0000-0000-4000-8000-0000000000b2","aal":"aal2","email":"office.s5proof@example.test"}'
\set admin_claims '{"sub":"5e5e0000-0000-4000-8000-0000000000a1","role":"authenticated","aud":"authenticated","session_id":"5e5e0000-0000-4000-8000-0000000000b1","aal":"aal2","email":"admin.s5proof@example.test"}'

-- The admin is in two companies: this session works in alpha (as switch_organization records it).
insert into security_audit.session_company (session_id, user_id, organization_id) values ('5e5e0000-0000-4000-8000-0000000000b1', '5e5e0000-0000-4000-8000-0000000000a1', :'org');

-- =====================================================================================================================================
-- As the office member: three drafts, as the app makes them (create_with_lines), two lines each (1 x 100 @20% + 2 x 25 @20% = 150 + 30).
set local role authenticated;
select set_config('request.jwt.claims', :'office_claims', true) is not null as claims \gset
select s5proof.check('the office session works in the proof company', public.current_user_organization_id() = :'org'::uuid);

\set header '{"customer":"Proof Customer Ltd","description":"Machined flange","subtotal":150,"carriage":0,"vat":30,"total":180,"vat_enabled":true,"carriage_vat":true,"status":"draft","amount_paid":0,"invoice_date":"2026-10-22","due_date":"2099-01-31","terms":"30 days"}'
\set lines '[{"position":0,"description":"Machined flange","quantity":1,"unit_price":100,"vat_pct":20,"vat_exempt":false},{"position":1,"description":"Bolt set","quantity":2,"unit_price":25,"vat_pct":20,"vat_exempt":false}]'
select public.create_with_lines('invoices', :'header'::jsonb, 'invoice_line_items', 'invoice_id', :'lines'::jsonb) as inv \gset
select public.create_with_lines('invoices', :'header'::jsonb, 'invoice_line_items', 'invoice_id', :'lines'::jsonb) as inv2 \gset
select public.create_with_lines('invoices', :'header'::jsonb, 'invoice_line_items', 'invoice_id', :'lines'::jsonb) as draft \gset
select id as line from public.invoice_line_items where invoice_id = :'inv' order by position limit 1 \gset
select id as draftline from public.invoice_line_items where invoice_id = :'draft' order by position limit 1 \gset

-- A draft can't take a number of its own (it would collide with the series later).
select s5proof.refused('a draft sets its own invoice_ref', format($$update public.invoices set invoice_ref = 'INV-9001' where id = %L$$, :'draft'), '42501', 'invoice_issue_direct');
select s5proof.refused('a new invoice is inserted with a number', format($$insert into public.invoices (organization_id, customer, invoice_ref) values (%L, 'X', 'INV-9002')$$, :'org'), '42501');

select public.issue_invoice(:'inv') as ref \gset
select public.issue_invoice(:'inv2') as ref2 \gset
select s5proof.check('issue_invoice gave two different INV numbers, in order', :'ref' ~ '^INV-\d{4,}$' and :'ref2' ~ '^INV-\d{4,}$' and :'ref' <> :'ref2'
  and substring(:'ref2' from '\d+$')::int > substring(:'ref' from '\d+$')::int);
select s5proof.check('issuing again returns the same number and changes nothing', public.issue_invoice(:'inv') = :'ref');
insert into s5proof.snap values ('inv', s5proof.state(:'inv'));

-- ---- 1. no field of an issued invoice changes by UPDATE ------------------------------------------------------------------------------
select s5proof.refused('issued: change ' || c, format('update public.invoices set %s where id = %L', c, :'inv'), '42501')
from unnest(array[
  $$invoice_ref = 'INV-7777'$$, $$customer = 'Someone Else Ltd'$$, $$description = 'Changed'$$, $$quantity = 9$$, $$unit_price = 1$$,
  $$subtotal = 1$$, $$vat = 0$$, $$total = 1$$, $$carriage = 50$$, $$vat_enabled = false$$, $$carriage_vat = false$$,
  $$invoice_date = '2020-01-01'$$, $$due_date = '2020-01-01'$$, $$tax_point = '2020-01-01'$$, $$terms = 'Never'$$,
  $$quote_ref = 'QUO-1'$$, $$customer_po = 'PO-1'$$, $$invoice_note = 'Changed note'$$, $$delivery_address = 'Elsewhere'$$,
  $$issuer_snapshot = '{"documentName":"Forged"}'$$, $$customer_snapshot = '{"name":"Forged"}'$$,
  $$amount_paid = 180$$, $$paid_at = now()$$, $$credited_amount = 10$$, $$refunded_amount = 10$$, $$payment_unverified = true$$,
  $$sent_by_name = 'Forged'$$]) c;
-- The issue stamp and the creator: either refused or put back by the actor triggers; never changed.
select s5proof.immutable('issued: change ' || c, format('update public.invoices set %s where id = %L', c, :'inv'), :'inv')
from unnest(array[$$issued_at = now() - interval '1 year'$$, $$issued_by = null$$, $$created_by = null$$, $$created_at = now() - interval '1 year'$$,
  $$paid_by = '5e5e0000-0000-4000-8000-0000000000a2'$$, $$emailed_by = '5e5e0000-0000-4000-8000-0000000000a2'$$]) c;
-- organization_id: refused (the lock, and RLS's WITH CHECK behind it); for the service role, which skips RLS, in section 8.
select s5proof.refused('issued: move it to another company', format('update public.invoices set organization_id = %L where id = %L', :'beta', :'inv'), '42501');

-- ---- 2. status: never back to draft, never paid / partial / credited / void by editing --------------------------------------------
select s5proof.refused('issued -> draft', format($$update public.invoices set status = 'draft' where id = %L$$, :'inv'), '42501');
select s5proof.refused('issued -> null status', format($$update public.invoices set status = null where id = %L$$, :'inv'));
select s5proof.refused('issued -> paid by editing', format($$update public.invoices set status = 'paid' where id = %L$$, :'inv'), '42501');
select s5proof.refused('issued -> partial by editing', format($$update public.invoices set status = 'partial' where id = %L$$, :'inv'), '42501');
select s5proof.refused('issued -> credited by editing', format($$update public.invoices set status = 'credited' where id = %L$$, :'inv'), '42501');
select s5proof.refused('issued -> paid with amount_paid = total, by editing', format($$update public.invoices set status = 'paid', amount_paid = total, paid_at = now() where id = %L$$, :'inv'), '42501');
select s5proof.refused('issued -> void by editing', format($$update public.invoices set status = 'void' where id = %L$$, :'inv'), '42501', 'invoice_void_direct');
select s5proof.refused('issued -> cancelled by editing', format($$update public.invoices set status = 'cancelled' where id = %L$$, :'inv'), '42501', 'invoice_void_direct');
select s5proof.refused('issued -> ' || quote_literal(s) || ' (spelling bypass)', format('update public.invoices set status = %L where id = %L', s, :'inv'))
from unnest(array['Void', 'void ', E'void\n', 'VOID', 'Paid', 'draft ']) s;

-- ---- 3. lines: none inserted, changed, deleted or moved ------------------------------------------------------------------------------
select s5proof.refused('issued: add a line', format($$insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values (%L, %L, 9, 'Extra', 1, 1, 20)$$, :'org', :'inv'), '42501');
select s5proof.refused('issued: change a line ' || c, format('update public.invoice_line_items set %s where id = %L', c, :'line'), '42501')
from unnest(array[$$quantity = 5$$, $$unit_price = 1$$, $$vat_pct = 0$$, $$vat_exempt = true$$, $$description = 'Changed'$$, $$position = 7$$]) c;
select s5proof.refused('issued: delete a line', format('delete from public.invoice_line_items where id = %L', :'line'), '42501');
select s5proof.refused('issued: delete all its lines', format('delete from public.invoice_line_items where invoice_id = %L', :'inv'), '42501');
select s5proof.refused('issued: move its line to a draft', format('update public.invoice_line_items set invoice_id = %L where id = %L', :'draft', :'line'), '42501');
select s5proof.refused('issued: move a draft''s line onto it', format('update public.invoice_line_items set invoice_id = %L where id = %L', :'inv', :'draftline'), '42501');

-- ---- 4. not deleted ---------------------------------------------------------------------------------------------------------------
select s5proof.refused('issued: delete it', format('delete from public.invoices where id = %L', :'inv'), '42501');

select s5proof.check('after every refusal the issued invoice, its lines and payments are exactly as issued',
  s5proof.state(:'inv') = (select v from s5proof.snap where k = 'inv'));

-- What stays open on an issued invoice (076's list): the sent date and the job link. Proven so the list is known, then undone.
savepoint open_fields;
select s5proof.allowed('issued: record the sent date (open field)', format('update public.invoices set sent_date = now() where id = %L', :'inv'));
select s5proof.allowed('issued -> sent (emailed; open status)', format($$update public.invoices set status = 'sent' where id = %L$$, :'inv'));
rollback to savepoint open_fields;

-- GAP (reported, not fixed here: needs a migration): written_off is reachable from issued / sent by a plain PATCH, and back again,
-- with no function, no reason and no named audit event (the row-change audit still records it). It changes no amount or number; it
-- takes the invoice out of the debtors list and makes it refuse payments and void.
savepoint wo;
select set_config('s5.inv', :'inv', true) is not null as s5 \gset
do $$ begin
  begin
    execute format($q$update public.invoices set status = 'written_off' where id = %L$q$, current_setting('s5.inv'));
    raise notice 'GAP  office can PATCH an issued invoice to written_off directly (no function, no reason)';
  exception when others then raise notice 'ok   refused  issued -> written_off by editing [% %]', sqlstate, sqlerrm;
  end;
end $$;
rollback to savepoint wo;

-- ---- 5. payments: only record_invoice_payment; never more than the balance due -----------------------------------------------------
select s5proof.refused('a payment row written directly', format($$insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, source) values (%L, %L, 180, current_date, 'recorded')$$, :'org', :'inv'), '42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'admin_claims', true) is not null as claims \gset
select s5proof.check('the admin session works in the proof company', public.current_user_organization_id() = :'org'::uuid);
select s5proof.refused('a payment of more than the total (overpayment)', format($$select public.record_invoice_payment(%L, 180.01, current_date, 'BACS', null, gen_random_uuid())$$, :'inv'), '22023');
select s5proof.refused('a payment of zero', format($$select public.record_invoice_payment(%L, 0, current_date, 'BACS', null, gen_random_uuid())$$, :'inv'), '22023');
select s5proof.refused('a payment of a fraction of a penny', format($$select public.record_invoice_payment(%L, 10.005, current_date, 'BACS', null, gen_random_uuid())$$, :'inv'), '22023');
select public.record_invoice_payment(:'inv', 80, current_date, 'BACS', 'S5-1', gen_random_uuid()) is not null as paid1 \gset
select s5proof.check('a part payment makes it partial with amount_paid 80 and no paid date',
  (select status = 'partial' and amount_paid = 80 and paid_at is null from public.invoices where id = :'inv'));
select s5proof.refused('a second payment over the balance due (100.01 of 100)', format($$select public.record_invoice_payment(%L, 100.01, current_date, 'BACS', null, gen_random_uuid())$$, :'inv'), '22023');
select s5proof.refused('part paid -> issued by editing', format($$update public.invoices set status = 'issued' where id = %L$$, :'inv'), '42501');
select s5proof.refused('part paid: void it', format($$select public.void_invoice(%L, 'Wrong customer')$$, :'inv'), '22023', 'invoice_paid');
select public.record_invoice_payment(:'inv', 100, current_date, 'BACS', 'S5-2', gen_random_uuid()) is not null as paid2 \gset
select s5proof.check('the balance paid makes it paid, amount_paid = total, with a paid date',
  (select status = 'paid' and amount_paid = total and paid_at is not null from public.invoices where id = :'inv'));
select s5proof.check('the invoice''s own figures and lines did not move with the payments',
  (s5proof.state(:'inv') -> 'invoice') - array['status', 'amount_paid', 'paid_at', 'updated_at', 'updated_by', 'paid_by']
  = ((select v from s5proof.snap where k = 'inv') -> 'invoice') - array['status', 'amount_paid', 'paid_at', 'updated_at', 'updated_by', 'paid_by']
  and s5proof.state(:'inv') -> 'lines' = (select v from s5proof.snap where k = 'inv') -> 'lines');
select s5proof.refused('paid in full: another payment', format($$select public.record_invoice_payment(%L, 1, current_date, 'BACS', null, gen_random_uuid())$$, :'inv'), '22023');
select s5proof.refused('paid -> issued by editing', format($$update public.invoices set status = 'issued' where id = %L$$, :'inv'), '42501');
select s5proof.refused('paid: change the total', format('update public.invoices set total = 1 where id = %L', :'inv'), '42501');
select s5proof.refused('paid: void it', format($$select public.void_invoice(%L, 'Wrong customer')$$, :'inv'), '22023', 'invoice_paid');
select s5proof.refused('paid: delete it', format('delete from public.invoices where id = %L', :'inv'), '42501');
select s5proof.no_effect('a payment row deleted directly', format('delete from public.invoice_payments where invoice_id = %L', :'inv'));
select s5proof.no_effect('a payment row changed directly', format('update public.invoice_payments set amount = 1 where invoice_id = %L', :'inv'));
select s5proof.check('both payments are still recorded, adding up to the total',
  (select sum(p.amount) = 180 and count(*) = 2 from public.invoice_payments p where p.invoice_id = :'inv'));

-- ---- 6. void: only void_invoice, with a reason, nothing against it -----------------------------------------------------------------
-- A credit note (even a draft one) against inv2 stops its void.
select s5proof.check('a draft credit note is made against the second invoice', public.create_credit_note(:'inv2', 'Returned',
  current_date, jsonb_build_array(jsonb_build_object('invoice_line_id', (select id from public.invoice_line_items where invoice_id = :'inv2' order by position limit 1), 'quantity', 1))) is not null);
select s5proof.refused('void with a credit note against it', format($$select public.void_invoice(%L, 'Wrong customer')$$, :'inv2'), '22023', 'invoice_has_credit_notes');
-- A third invoice, issued clean, for the void itself.
select public.create_with_lines('invoices', :'header'::jsonb, 'invoice_line_items', 'invoice_id', :'lines'::jsonb) as inv3 \gset
select public.issue_invoice(:'inv3') as ref3 \gset
select s5proof.refused('void with no reason', format($$select public.void_invoice(%L, null)$$, :'inv3'), '22023', 'void_reason_required');
select s5proof.refused('void with a blank reason', format($$select public.void_invoice(%L, '   ')$$, :'inv3'), '22023', 'void_reason_required');
select s5proof.refused('void a draft', format($$select public.void_invoice(%L, 'x')$$, :'draft'), '22023', 'invoice_draft');
reset role;
select count(*) as audit_before from security_audit.audit_log where organization_id = :'org' and action = 'VOID_INVOICE' \gset
set local role authenticated;
select set_config('request.jwt.claims', :'admin_claims', true) is not null as claims \gset
select s5proof.check('void_invoice voids the clean issued invoice', public.void_invoice(:'inv3', '  Raised against the wrong customer  ') ->> 'status' = 'void');
insert into s5proof.snap values ('inv3', s5proof.state(:'inv3'));
reset role;
select s5proof.check('one VOID_INVOICE audit row, with the trimmed reason, the number and the status it left',
  (select count(*) = :audit_before + 1 from security_audit.audit_log where organization_id = :'org' and action = 'VOID_INVOICE')
  and exists (select 1 from security_audit.audit_log a where a.organization_id = :'org' and a.action = 'VOID_INVOICE' and a.entity_id = :'inv3'
                and a.actor_user_id = '5e5e0000-0000-4000-8000-0000000000a1' and a.metadata ->> 'reason' = 'Raised against the wrong customer'
                and a.metadata ->> 'invoice_ref' = :'ref3' and a.metadata ->> 'from_status' = 'issued'));
select s5proof.check('a void invoice keeps its number', (select invoice_ref = :'ref3' and status = 'void' from public.invoices where id = :'inv3'));
set local role authenticated;
select set_config('request.jwt.claims', :'office_claims', true) is not null as claims \gset
select s5proof.refused('void -> ' || s, format('update public.invoices set status = %L where id = %L', s, :'inv3'), '42501')
from unnest(array['issued', 'sent', 'draft', 'paid', 'written_off']) s;
select s5proof.refused('void: change ' || c, format('update public.invoices set %s where id = %L', c, :'inv3'), '42501')
from unnest(array[$$total = 1$$, $$customer = 'Someone Else Ltd'$$, $$invoice_ref = 'INV-7778'$$, $$due_date = '2020-01-01'$$]) c;
select s5proof.refused('void: add a line', format($$insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values (%L, %L, 9, 'Extra', 1, 1, 20)$$, :'org', :'inv3'), '42501');
select s5proof.refused('void: change a line', format('update public.invoice_line_items set unit_price = 1 where invoice_id = %L', :'inv3'), '42501');
select s5proof.refused('void: delete a line', format('delete from public.invoice_line_items where invoice_id = %L', :'inv3'), '42501');
select s5proof.refused('void: delete it', format('delete from public.invoices where id = %L', :'inv3'), '42501');
select s5proof.refused('void: void it again', format($$select public.void_invoice(%L, 'again')$$, :'inv3'), '22023', 'invoice_already_void');
select s5proof.refused('void: take a payment', format($$select public.record_invoice_payment(%L, 1, current_date, 'BACS', null, gen_random_uuid())$$, :'inv3'));
select s5proof.check('the void invoice is exactly as it was voided', s5proof.state(:'inv3') = (select v from s5proof.snap where k = 'inv3'));

-- ---- 7. the INV series never reuses a number --------------------------------------------------------------------------------------
select public.issue_invoice(:'draft') as ref4 \gset
select s5proof.check('the next issue after a void takes a NEW number, above every earlier one',
  :'ref4' not in (:'ref', :'ref2', :'ref3') and substring(:'ref4' from '\d+$')::int > greatest(substring(:'ref' from '\d+$')::int, substring(:'ref2' from '\d+$')::int, substring(:'ref3' from '\d+$')::int));
reset role;
select s5proof.check('every INV number in the company is unique, and the counter is at (or past) the highest',
  (select count(*) = count(distinct invoice_ref) from public.invoices where organization_id = :'org' and invoice_ref is not null)
  and (select last from public.doc_counters where organization_id = :'org' and prefix = 'INV')
      >= (select max(substring(invoice_ref from '\d+$')::int) from public.invoices where organization_id = :'org'));

-- ---- 8. the service role (bypasses RLS, not triggers) is held to the same lock -----------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) is not null as claims \gset
select s5proof.refused('service role: change ' || c, format('update public.invoices set %s where id = %L', c, :'inv'), '42501')
from unnest(array[$$total = 1$$, $$subtotal = 1$$, $$vat = 0$$, $$customer = 'Someone Else Ltd'$$, $$invoice_ref = 'INV-7779'$$,
  $$invoice_date = '2020-01-01'$$, $$amount_paid = 0$$, $$paid_at = null$$]) c;
select s5proof.refused('service role: move it to another company', format('update public.invoices set organization_id = %L where id = %L', :'beta', :'inv'), '42501');
select s5proof.refused('service role: back to draft', format($$update public.invoices set status = 'draft' where id = %L$$, :'inv'), '42501');
select s5proof.refused('service role: paid -> issued', format($$update public.invoices set status = 'issued' where id = %L$$, :'inv'), '42501');
select s5proof.refused('service role: delete an issued invoice', format('delete from public.invoices where id = %L', :'inv'), '42501');
select s5proof.refused('service role: delete a void invoice', format('delete from public.invoices where id = %L', :'inv3'), '42501');
select s5proof.refused('service role: add a line', format($$insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values (%L, %L, 9, 'Extra', 1, 1, 20)$$, :'org', :'inv'), '42501');
select s5proof.refused('service role: change a line', format('update public.invoice_line_items set unit_price = 1 where invoice_id = %L', :'inv'), '42501');
select s5proof.refused('service role: delete a line', format('delete from public.invoice_line_items where invoice_id = %L', :'inv'), '42501');
select s5proof.refused('service role: change a void invoice''s total', format('update public.invoices set total = 1 where id = %L', :'inv3'), '42501');
-- GAP (by design, documented in 073 / 089 / 091 and tested in tests/db/invoice-screen.test.ts "the service role (importer) still writes
-- finished records"): the void guard, the issue guard and the receipts guard exempt every role but anon / authenticated, so the service
-- role can set or clear void (and written_off) by a direct status update. Amounts, lines, number and delete stay locked (above). No app
-- code path writes invoices with the service role (app/api/** and lib/server/** touch only integration_* tables and auth/admin rows).
savepoint sr;
select set_config('s5.inv3', :'inv3', true) is not null as s5 \gset
do $$ begin
  begin
    execute format($q$update public.invoices set status = 'issued' where id = %L$q$, current_setting('s5.inv3'));
    raise notice 'GAP  service role can un-void a void invoice by a direct status update (073''s guard exempts it by design)';
  exception when others then raise notice 'ok   refused  service role: void -> issued [% %]', sqlstate, sqlerrm;
  end;
end $$;
rollback to savepoint sr;
reset role;

-- ---- 9. the triggers can't be skipped ----------------------------------------------------------------------------------------------
select s5proof.check('the lock triggers exist on invoices / invoice_line_items, with no WHEN clause, enabled in origin mode (O)',
  (select count(*) = 5 from pg_trigger t
   where not t.tgisinternal and t.tgenabled = 'O' and t.tgqual is null
     and (t.tgrelid, t.tgname::text) in (('public.invoices'::regclass, 'invoice_issue_lock'), ('public.invoices'::regclass, 'invoices_void_guard'),
                                         ('public.invoices'::regclass, 'zz_invoice_via_issue'), ('public.invoices'::regclass, 'zz_invoice_receipts'),
                                         ('public.invoice_line_items'::regclass, 'invoice_lines_issue_lock'))));
select s5proof.check('the lock functions treat the service role as an API role (is_api_role), not as an exemption',
  position('service_role' in pg_get_functiondef('public.is_api_role()'::regprocedure)) > 0
  and position('is_api_role()' in pg_get_functiondef('public.invoice_issue_lock()'::regprocedure)) > 0
  and position('is_api_role()' in pg_get_functiondef('public.invoice_lines_issue_lock()'::regprocedure)) > 0);
set local role authenticated;
select s5proof.refused('authenticated sets session_replication_role = replica', 'set local session_replication_role = replica', '42501');
reset role;
set local role service_role;
select s5proof.refused('service role sets session_replication_role = replica', 'set local session_replication_role = replica', '42501');
select s5proof.refused('service role disables the invoice lock trigger', 'alter table public.invoices disable trigger invoice_issue_lock', '42501');
reset role;
select s5proof.check('no API role is a superuser or a member of the invoice tables'' owner (so none can disable a trigger)',
  not exists (select 1 from pg_roles where rolname in ('authenticated', 'service_role', 'anon') and rolsuper)
  and not pg_has_role('authenticated', (select relowner from pg_class where oid = 'public.invoices'::regclass), 'MEMBER')
  and not pg_has_role('service_role', (select relowner from pg_class where oid = 'public.invoices'::regclass), 'MEMBER'));

-- ---- 10. integrations don't write invoices; the audit chain verifies ---------------------------------------------------------------
select s5proof.check('no integration_* function (the Xero after-issue / send path) updates, inserts into or deletes from invoices or their lines',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'integration%'
                and p.prosrc ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?(invoices|invoice_line_items)\M'));
select s5proof.check('the company''s audit chain verifies: every row links to the previous one and its hash recomputes',
  (with r as (select a.*, lag(a.hash) over (order by a.created_at) as expected_previous from security_audit.audit_log a where a.organization_id = :'org')
   select count(*) > 5
      and count(*) filter (where previous_hash is distinct from expected_previous) = 0
      and count(*) filter (where hash is distinct from encode(extensions.digest(
            coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table ||
            coalesce(entity_id, '') || coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text,
            'sha256'), 'hex')) = 0
   from r));

\echo 'PASS invoice immutability proof: every property above holds (GAP lines are reported exemptions, not failures).'
rollback;
