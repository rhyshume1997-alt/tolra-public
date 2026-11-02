-- Rehearsal tenants (synthetic). Run once as postgres on the disposable rehearsal database, after build-db.sh:
--   psql -h 127.0.0.1 -U postgres -d sliq_rehearsal -v ON_ERROR_STOP=1 -f scripts/sliq-import/rehearsal/setup-tenants.sql
-- Tenant A "Rehearsal Engineering Ltd" stands in for the company being imported; tenant B "Rehearsal Other Co Ltd" is a second
-- company for the isolation checks. Each has an admin; A also has an office user. Every user has a live aal2 session, as the
-- RLS helpers require. Ids are fixed so the check scripts can name them. Prints the two organisation ids.
\set ON_ERROR_STOP 1
begin;
insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('7e570000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'admin.a@rehearsal.example.test', '{"full_name":"Rehearsal Admin A"}'),
  ('7e570000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'office.a@rehearsal.example.test', '{"full_name":"Rehearsal Office A"}'),
  ('7e570000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'admin.b@rehearsal.example.test', '{"full_name":"Rehearsal Admin B"}');
insert into auth.sessions (id, user_id, aal) values
  ('7e570000-0000-4000-8000-0000000005a1', '7e570000-0000-4000-8000-0000000000a1', 'aal2'),
  ('7e570000-0000-4000-8000-0000000005a2', '7e570000-0000-4000-8000-0000000000a2', 'aal2'),
  ('7e570000-0000-4000-8000-0000000005b1', '7e570000-0000-4000-8000-0000000000b1', 'aal2');
set local role service_role;
select public.create_organization('Rehearsal Engineering Ltd', 'rehearsal-a', 'admin.a@rehearsal.example.test',
  '{"documentName":"Rehearsal Engineering Ltd","addressLines":["Unit 1, Test Estate","Testbury","TB1 1ST"],"phone":"01110 000001","email":"office.a@rehearsal.example.test","vatRegistered":true,"vatNumber":"GB 000 0000 00","defaultVatRate":20}'::jsonb) as org_a \gset
select public.add_member(:'org_a', 'office.a@rehearsal.example.test', 'office') is not null as added \gset
select public.create_organization('Rehearsal Other Co Ltd', 'rehearsal-b', 'admin.b@rehearsal.example.test',
  '{"documentName":"Rehearsal Other Co Ltd","addressLines":["Unit 2"],"phone":"01110 000002","email":"admin.b@rehearsal.example.test","vatRegistered":true,"vatNumber":"GB 000 0000 01","defaultVatRate":20}'::jsonb) as org_b \gset
reset role;
-- Tenant B already has its own records, including numbers the import also uses (INV-1000, QUO-1000, PO-0100): the collision
-- check is per company, so these must NOT hold anything back in A, and B's rows must be untouched by A's import.
insert into public.customers (organization_id, name, status) values (:'org_b', 'Harbour Fabrication Ltd', 'active');
insert into public.quotes (organization_id, quote_ref, customer, total_value, status) values (:'org_b', 'QUO-1000', 'Harbour Fabrication Ltd', 120.00, 'sent');
insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, invoice_date, due_date, amount_paid)
  values (:'org_b', 'INV-1000', 'Harbour Fabrication Ltd', 100.00, 20.00, 120.00, 'sent', '2026-01-05', '2026-02-04', 0);
insert into public.purchase_orders (organization_id, po_ref, po_number, supplier, total_value, status) values (:'org_b', 'PO-0100', 'PO-0100', 'B Supplier', 50.00, 'draft');
commit;
\echo org_a=:org_a
\echo org_b=:org_b
