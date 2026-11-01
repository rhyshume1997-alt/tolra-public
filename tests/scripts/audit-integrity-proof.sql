-- =====================================================================================================================================
-- Audit log integrity proof (S10). Plain SQL (no psql meta-commands, so tests/db/audit-integrity.test.ts runs this same file through
-- node-postgres on the CI stack). Runnable with psql against a DISPOSABLE database that has the migration chain applied (never production):
--
--   PGPASSWORD=... psql -X -q -v ON_ERROR_STOP=1 -o /dev/null -h 127.0.0.1 -U postgres -d s10 -f tests/scripts/audit-integrity-proof.sql
--   (with `create database s10 template sec_base;` on the local stand-in). The -o /dev/null drops the empty result rows; the NOTICE lines
--   (one "ok" per property, "GAP" per reported exemption) go to stderr and the last one is "PASS audit integrity proof ...".
--
-- Everything runs in ONE transaction that is ROLLED BACK at the end: it leaves no company, user, invoice or audit row behind. It stops at
-- the first property that does not hold ("FAIL <what>"). Known, deliberate exemptions print "GAP ..." and do not fail the run.
--
-- What it proves about security_audit.audit_log (000 table + append-only trigger + hash trigger; 006 grants, chain function, write_audit;
-- 023/035/095 the write_audit guard; 077 the chain lookup; 073 VOID_INVOICE):
--   1. Catalogue: RLS on; the only policy is a SELECT for admins of the row's company; no INSERT/UPDATE/DELETE/TRUNCATE privilege for anon,
--      authenticated or service_role (table or any column); none of them owns the table, is a superuser, or is a member of the owner's
--      role; the append-only trigger and the chain trigger are plain and enabled; the view is security_invoker and read-only.
--   2. Attempts, as anon / authenticated (admin and office) / service_role: INSERT, UPDATE, DELETE, TRUNCATE (also through the view,
--      and with ON CONFLICT / WHERE true) are refused; set session_replication_role (which would switch the triggers off) is refused.
--   3. Second lock: even if an API role is GIVEN every privilege and an open policy (done inside this transaction), UPDATE and DELETE are
--      still refused by the append-only trigger, and an INSERT is re-chained by the hash trigger (a forged hash / previous_hash /
--      created_at is overwritten).
--   4. The only ways in for a signed-in user: write_audit (a whitelist; cannot name the company or the actor; cannot make up VOID_INVOICE,
--      ISSUE, MARK_PAID, RECORD_PAYMENT, WRITE_OFF_INVOICE, REVERSE_WRITE_OFF ...; PASSWORD_RESET_PREPARED is admin-only on user_profiles)
--      and the row-change triggers / named-event functions, whose action names are fixed in the function. No other function that an API
--      role can run takes an action name.
--   5. The real flow: an invoice issued, paid and voided through the real functions leaves ISSUE / RECORD_PAYMENT / MARK_PAID /
--      VOID_INVOICE rows by the right actor, and the company's chain links (each previous_hash = the previous row's hash) and every
--      hash recomputes (s10p.verify_chain below: there is no verify function in the database, the query lives here and in
--      tests/db/audit-chain-077.test.ts).
--   6. Tamper evidence, as the table owner (the one role that can switch the guards off): editing a payload, deleting a row, rewriting a
--      row's hash, back-dating an insert are each reported by the verification. Reported exemptions (GAP): actor_email / ip_address /
--      user_agent / request_id are not in the hash; deleting the LAST rows, or re-hashing the whole chain from the first edit onwards,
--      leaves a chain that verifies (nothing outside the table anchors the head); the owner can TRUNCATE.
--   7. The view shows an admin every row of their own company and nothing of another; shows other roles nothing; anon nothing.
-- =====================================================================================================================================
begin;
set local timezone to 'UTC';            -- security_audit.set_audit_hash hashes created_at::text; the stack runs in UTC
set local client_min_messages to notice;

-- ---- scratch schema (rolled back with the rest) -----------------------------------------------------------------------------------
create schema s10p;
grant usage on schema s10p to anon, authenticated, service_role;
create table s10p.ctx (k text primary key, v text);
create table s10p.results (n serial primary key, kind text, label text);
grant select on s10p.ctx to anon, authenticated, service_role;
grant all on s10p.results to anon, authenticated, service_role;
grant all on sequence s10p.results_n_seq to anon, authenticated, service_role;

create function s10p.put(p_k text, p_v text) returns void language sql security definer set search_path = pg_catalog, s10p as
  $f$ insert into s10p.ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $f$;
create function s10p.v(p_k text) returns text language sql stable security definer set search_path = pg_catalog, s10p as
  $f$ select v from s10p.ctx where k = p_k $f$;
-- The JWT claims PostgREST would hand the database for one of the fixture people (aal2: the company requires a second step for admins).
create function s10p.claims(p_who text) returns text language sql stable security definer set search_path = pg_catalog, s10p as
  $f$ select json_build_object('sub', s10p.v(p_who), 'role', 'authenticated', 'aud', 'authenticated', 'session_id', s10p.v(p_who || '_sess'),
                               'aal', 'aal2', 'email', s10p.v(p_who || '_email'))::text $f$;
grant execute on all functions in schema s10p to anon, authenticated, service_role;

create function s10p.ok(p_kind text, p_label text) returns void language plpgsql as $f$
begin
  insert into s10p.results (kind, label) values (p_kind, p_label);
  raise notice 'ok   %  %', rpad(p_kind, 8), p_label;
end $f$;
create function s10p.gap(p_label text) returns void language plpgsql as $f$
begin
  insert into s10p.results (kind, label) values ('GAP', p_label);
  raise notice 'GAP  %', p_label;
end $f$;
create function s10p.check(p_label text, p_ok boolean) returns void language plpgsql as $f$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
  perform s10p.ok('holds', p_label);
end $f$;
-- The statement must be refused with exactly this SQLSTATE (and, if given, a message containing p_msg). It runs in a subtransaction.
create function s10p.refused(p_label text, p_sql text, p_code text, p_msg text default null) returns void language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_code then raise exception 'FAIL % : refused, but with % (%), expected %', p_label, v_state, v_msg, p_code; end if;
    if p_msg is not null and position(p_msg in v_msg) = 0 then raise exception 'FAIL % : refused with "%", expected it to contain "%"', p_label, v_msg, p_msg; end if;
    perform s10p.ok('refused', p_label || '  [' || v_state || ' ' || left(v_msg, 80) || ']');
    return;
  end;
  raise exception 'FAIL % : it was ALLOWED', p_label;
end $f$;
-- The statement must be allowed (and may touch any number of rows, 0 included); the number of rows is returned.
create function s10p.allowed(p_label text, p_sql text) returns bigint language plpgsql as $f$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform s10p.ok('allowed', p_label || '  [' || n || ' row(s)]');
  return n;
end $f$;

-- The chain verification (the query of tests/db/audit-chain-077.test.ts, as a function): per company, in created_at order, every row's
-- previous_hash must be the previous row's hash, and every hash must recompute from the row's own fields and its previous_hash.
create function s10p.verify_chain(p_org uuid)
returns table (total int, broken_links int, bad_hashes int, first_bad uuid) language sql stable as $f$
  with r as (
    select a.*, lag(a.hash) over (order by a.created_at, a.id) as expected_previous
    from security_audit.audit_log a where a.organization_id = p_org),
  c as (
    select r.id, r.created_at,
           r.previous_hash is distinct from r.expected_previous as bad_link,
           r.hash is distinct from encode(extensions.digest(
             coalesce(r.previous_hash, '') || coalesce(r.organization_id::text, '') || coalesce(r.actor_user_id::text, '') || r.action || r.entity_table ||
             coalesce(r.entity_id, '') || coalesce(r.old_data::text, '') || coalesce(r.new_data::text, '') || coalesce(r.metadata::text, '') || r.created_at::text,
             'sha256'), 'hex') as bad_hash
    from r)
  select count(*)::int, (count(*) filter (where bad_link))::int, (count(*) filter (where bad_hash))::int,
         (select c2.id from c c2 where c2.bad_link or c2.bad_hash order by c2.created_at, c2.id limit 1)
  from c $f$;
-- Runs a tamper statement (as the current role) inside a subtransaction, verifies the company's chain while the damage is in place, undoes
-- it, and checks what the verification reported. p_detected: true = the verification must report a break (or p_links / p_hashes exactly);
-- false = the damage is a reported exemption (the chain still verifies).
create function s10p.tamper(p_label text, p_org uuid, p_sql text, p_detected boolean, p_links int default null, p_hashes int default null)
returns void language plpgsql as $f$
declare r record; v_total int; v_links int; v_hashes int; v_msg text; v_before int;
begin
  select * into r from s10p.verify_chain(p_org);
  if r.broken_links <> 0 or r.bad_hashes <> 0 then raise exception 'FAIL % : the chain was already broken before the tamper (% links, % hashes)', p_label, r.broken_links, r.bad_hashes; end if;
  v_before := r.total;
  begin
    execute p_sql;
    select * into r from s10p.verify_chain(p_org);
    raise exception using errcode = 'S1000', message = r.total || '|' || r.broken_links || '|' || r.bad_hashes;
  exception when sqlstate 'S1000' then
    get stacked diagnostics v_msg = message_text;
  end;
  v_total := split_part(v_msg, '|', 1)::int; v_links := split_part(v_msg, '|', 2)::int; v_hashes := split_part(v_msg, '|', 3)::int;
  select * into r from s10p.verify_chain(p_org);
  if r.total <> v_before or r.broken_links <> 0 or r.bad_hashes <> 0 then raise exception 'FAIL % : the tamper was not undone', p_label; end if;
  if p_detected then
    if v_links + v_hashes = 0 then raise exception 'FAIL % : the tamper was NOT detected (rows %, links %, hashes %)', p_label, v_total, v_links, v_hashes; end if;
    if p_links is not null and v_links <> p_links then raise exception 'FAIL % : expected % broken link(s), got %', p_label, p_links, v_links; end if;
    if p_hashes is not null and v_hashes <> p_hashes then raise exception 'FAIL % : expected % bad hash(es), got %', p_label, p_hashes, v_hashes; end if;
    perform s10p.ok('detected', p_label || '  [rows ' || v_total || ', broken links ' || v_links || ', bad hashes ' || v_hashes || ']');
  else
    if v_links + v_hashes <> 0 then raise exception 'FAIL % : documented as undetected but the verification reported links % hashes %', p_label, v_links, v_hashes; end if;
    perform s10p.gap(p_label || '  [chain still verifies: rows ' || v_total || ']');
  end if;
end $f$;

-- ---- fixture: two companies; alpha has an admin, an office member and a viewer, beta has its own admin ------------------------------
insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('51000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'admin.alpha.s10proof@example.test', '{"full_name":"S10 Alpha Admin"}'),
  ('51000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'office.alpha.s10proof@example.test', '{"full_name":"S10 Alpha Office"}'),
  ('51000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'viewer.alpha.s10proof@example.test', '{"full_name":"S10 Alpha Viewer"}'),
  ('51000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'admin.beta.s10proof@example.test', '{"full_name":"S10 Beta Admin"}');
insert into auth.sessions (id, user_id, aal) values
  ('51000000-0000-4000-8000-0000000000c1', '51000000-0000-4000-8000-0000000000a1', 'aal2'),
  ('51000000-0000-4000-8000-0000000000c2', '51000000-0000-4000-8000-0000000000a2', 'aal2'),
  ('51000000-0000-4000-8000-0000000000c3', '51000000-0000-4000-8000-0000000000a3', 'aal2'),
  ('51000000-0000-4000-8000-0000000000d1', '51000000-0000-4000-8000-0000000000b1', 'aal2');
select s10p.put('admin_a', '51000000-0000-4000-8000-0000000000a1'), s10p.put('admin_a_sess', '51000000-0000-4000-8000-0000000000c1'), s10p.put('admin_a_email', 'admin.alpha.s10proof@example.test'),
       s10p.put('office_a', '51000000-0000-4000-8000-0000000000a2'), s10p.put('office_a_sess', '51000000-0000-4000-8000-0000000000c2'), s10p.put('office_a_email', 'office.alpha.s10proof@example.test'),
       s10p.put('viewer_a', '51000000-0000-4000-8000-0000000000a3'), s10p.put('viewer_a_sess', '51000000-0000-4000-8000-0000000000c3'), s10p.put('viewer_a_email', 'viewer.alpha.s10proof@example.test'),
       s10p.put('admin_b', '51000000-0000-4000-8000-0000000000b1'), s10p.put('admin_b_sess', '51000000-0000-4000-8000-0000000000d1'), s10p.put('admin_b_email', 'admin.beta.s10proof@example.test');

set local role service_role;
select s10p.put('alpha', public.create_organization('S10 Proof Alpha Ltd', 's10-proof-alpha', 'admin.alpha.s10proof@example.test',
  '{"documentName":"S10 Proof Alpha Ltd","addressLines":["Unit 1, Test Estate","Testtown","TE1 1ST"],"phone":"01000 000000","email":"office.alpha.s10proof@example.test","vatRegistered":true,"vatNumber":"GB 000 0000 00","defaultVatRate":20}'::jsonb)::text);
select public.add_member(s10p.v('alpha')::uuid, 'office.alpha.s10proof@example.test', 'office');
select public.add_member(s10p.v('alpha')::uuid, 'viewer.alpha.s10proof@example.test', 'viewer');
select s10p.put('beta', public.create_organization('S10 Proof Beta Ltd', 's10-proof-beta', 'admin.beta.s10proof@example.test',
  '{"documentName":"S10 Proof Beta Ltd","addressLines":["Unit 2"],"phone":"01000 000001","email":"beta.s10proof@example.test","vatRegistered":true,"vatNumber":"GB 000 0000 01","defaultVatRate":20}'::jsonb)::text);
reset role;

-- =====================================================================================================================================
-- 1. Catalogue: who may do what to the table, from the privilege tables themselves
-- =====================================================================================================================================
select s10p.check('security_audit.audit_log has row-level security enabled',
  (select relrowsecurity from pg_class where oid = 'security_audit.audit_log'::regclass));
select s10p.check('its only policy is a SELECT for admins of the row''s own company (no INSERT, UPDATE or DELETE policy for any role)',
  (select count(*) = 1 and bool_and(polcmd = 'r') and bool_and(pg_get_expr(polqual, polrelid) like '%current_user_organization_id()%' and pg_get_expr(polqual, polrelid) like '%has_org_role%admin%')
   from pg_policy where polrelid = 'security_audit.audit_log'::regclass));
select s10p.check(r || ' has no ' || p || ' on the audit table' || case when p in ('INSERT', 'UPDATE', 'REFERENCES') then ' (table or any column)' else '' end,
  not has_table_privilege(r, 'security_audit.audit_log', p) and (p not in ('INSERT', 'UPDATE', 'REFERENCES') or not has_any_column_privilege(r, 'security_audit.audit_log', p)))
from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p;
select s10p.check('anon has no SELECT on the audit table or its view', not has_table_privilege('anon', 'security_audit.audit_log', 'SELECT') and not has_table_privilege('anon', 'public.audit_log_view', 'SELECT')
  and not has_schema_privilege('anon', 'security_audit', 'USAGE'));
select s10p.check('authenticated can SELECT the table and the view, and has no write privilege on the table',
  has_table_privilege('authenticated', 'security_audit.audit_log', 'SELECT') and has_table_privilege('authenticated', 'public.audit_log_view', 'SELECT'));
-- The view itself carries the default write grants of the public schema (000 revoked only anon's). They are inert while the view is
-- security_invoker (a write through it is checked against the BASE table as the caller: section 2 tries each and is refused), but they
-- would become a hole if the view ever stopped being security_invoker. Reported, not failed.
select s10p.gap('public.audit_log_view grants ' || string_agg(distinct r || ':' || p, ', ' order by r || ':' || p) || ' (inert: security_invoker + no base-table privilege; REVOKE would remove the dependency)')
from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
where has_table_privilege(r, 'public.audit_log_view', p)
having count(*) > 0;
select s10p.ok('info', 'service_role SELECT on the table: ' || has_table_privilege('service_role', 'security_audit.audit_log', 'SELECT') || ' (schema USAGE: ' || has_schema_privilege('service_role', 'security_audit', 'USAGE') || '); it reaches the log only through definer functions, which only append');
select s10p.check('no API role owns the table, is a superuser or bypasses by membership of the owner''s role',
  not exists (select 1 from pg_roles where rolname in ('anon', 'authenticated', 'service_role') and rolsuper)
  and not exists (select 1 from pg_class c where c.oid = 'security_audit.audit_log'::regclass and c.relowner in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')))
  and not pg_has_role('anon', (select relowner from pg_class where oid = 'security_audit.audit_log'::regclass), 'MEMBER')
  and not pg_has_role('authenticated', (select relowner from pg_class where oid = 'security_audit.audit_log'::regclass), 'MEMBER')
  and not pg_has_role('service_role', (select relowner from pg_class where oid = 'security_audit.audit_log'::regclass), 'MEMBER'));
select s10p.check('the append-only trigger is a plain, enabled BEFORE UPDATE OR DELETE row trigger (no WHEN clause)',
  exists (select 1 from pg_trigger t where t.tgrelid = 'security_audit.audit_log'::regclass and t.tgname = 'audit_log_prevent_mutation' and t.tgenabled = 'O'
          and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER audit_log_prevent_mutation BEFORE DELETE OR UPDATE ON security_audit.audit_log FOR EACH ROW EXECUTE FUNCTION security_audit.prevent_audit_mutation()'));
select s10p.check('the chain trigger is a plain, enabled BEFORE INSERT row trigger on set_audit_hash',
  exists (select 1 from pg_trigger t where t.tgrelid = 'security_audit.audit_log'::regclass and t.tgname = 'audit_log_set_hash' and t.tgenabled = 'O'
          and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER audit_log_set_hash BEFORE INSERT ON security_audit.audit_log FOR EACH ROW EXECUTE FUNCTION security_audit.set_audit_hash()'));
select s10p.check('set_audit_hash is a definer function with a pinned search_path',
  (select prosecdef and proconfig is not null and proconfig::text like '%search_path%' from pg_proc where oid = 'security_audit.set_audit_hash()'::regprocedure));
select s10p.check('audit_log_view is security_invoker (the base table''s policy applies to the reader) and leaves out the old/new row payloads',
  (select coalesce(reloptions::text, '') like '%security_invoker=true%' from pg_class where oid = 'public.audit_log_view'::regclass)
  and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_log_view' and column_name in ('old_data', 'new_data')));
select s10p.gap('no BEFORE TRUNCATE trigger: TRUNCATE is refused only by the missing privilege (no API role has it); the table owner can truncate (see section 6)')
where not exists (select 1 from pg_trigger t where t.tgrelid = 'security_audit.audit_log'::regclass and not t.tgisinternal and (t.tgtype & 32) <> 0);

-- Which functions an API role can run that append to the log, and whether any of them takes an action name from the caller.
select s10p.check('the only function an API role can run that takes an audit action from the caller is write_audit (the others fix their action names in their own text)',
  (select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '{}') = array['write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'security_audit') and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
     and p.prosrc ~* 'insert\s+into\s+security_audit\.audit_log'
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and exists (select 1 from unnest(coalesce(p.proargnames, '{}')) a where a ~* 'action|event')));
select s10p.check('write_audit is not callable by anon (signed-in only)', not has_function_privilege('anon', 'public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE'));
select s10p.check('log_named_event (the internal writer of ISSUE / MARK_PAID ...) is not callable by any API role',
  not has_function_privilege('anon', 'security_audit.log_named_event(uuid,text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'security_audit.log_named_event(uuid,text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('service_role', 'security_audit.log_named_event(uuid,text,text,text,jsonb)', 'EXECUTE'));

-- =====================================================================================================================================
-- 5 (first). The real flow, so the later sections have financial rows to attack: alpha issues two invoices (one paid in full, one voided);
-- beta issues and voids one. All through the real functions, as the app calls them.
-- =====================================================================================================================================
select set_config('request.jwt.claims', s10p.claims('office_a'), true);
set local role authenticated;
select s10p.check('the office session works in alpha', public.current_user_organization_id() = s10p.v('alpha')::uuid);
select s10p.put('inv_void', public.create_with_lines('invoices',
  '{"customer":"S10 Customer Ltd","description":"Machined flange","subtotal":150,"carriage":0,"vat":30,"total":180,"vat_enabled":true,"carriage_vat":true,"status":"draft","amount_paid":0,"invoice_date":"2026-10-22","due_date":"2099-01-31","terms":"30 days"}'::jsonb,
  'invoice_line_items', 'invoice_id',
  '[{"position":0,"description":"Machined flange","quantity":1,"unit_price":100,"vat_pct":20,"vat_exempt":false},{"position":1,"description":"Bolt set","quantity":2,"unit_price":25,"vat_pct":20,"vat_exempt":false}]'::jsonb)::text);
select s10p.put('inv_paid', public.create_with_lines('invoices',
  '{"customer":"S10 Customer Ltd","description":"Machined flange","subtotal":150,"carriage":0,"vat":30,"total":180,"vat_enabled":true,"carriage_vat":true,"status":"draft","amount_paid":0,"invoice_date":"2026-10-22","due_date":"2099-01-31","terms":"30 days"}'::jsonb,
  'invoice_line_items', 'invoice_id',
  '[{"position":0,"description":"Machined flange","quantity":1,"unit_price":100,"vat_pct":20,"vat_exempt":false},{"position":1,"description":"Bolt set","quantity":2,"unit_price":25,"vat_pct":20,"vat_exempt":false}]'::jsonb)::text);
select s10p.put('ref_void', public.issue_invoice(s10p.v('inv_void')::uuid));
select s10p.put('ref_paid', public.issue_invoice(s10p.v('inv_paid')::uuid));
select public.record_invoice_payment(s10p.v('inv_paid')::uuid, 180, date '2026-10-23', 'BACS', 'S10-REF', gen_random_uuid());
select set_config('request.jwt.claims', s10p.claims('admin_a'), true);
select public.void_invoice(s10p.v('inv_void')::uuid, '  Raised against the wrong customer  ');
reset role;

select set_config('request.jwt.claims', s10p.claims('admin_b'), true);
set local role authenticated;
select s10p.put('inv_beta', public.create_with_lines('invoices',
  '{"customer":"S10 Beta Customer","description":"Bracket","subtotal":100,"carriage":0,"vat":20,"total":120,"vat_enabled":true,"carriage_vat":true,"status":"draft","amount_paid":0,"invoice_date":"2026-10-22","due_date":"2099-01-31"}'::jsonb,
  'invoice_line_items', 'invoice_id',
  '[{"position":0,"description":"Bracket","quantity":1,"unit_price":100,"vat_pct":20,"vat_exempt":false}]'::jsonb)::text);
select public.issue_invoice(s10p.v('inv_beta')::uuid);
select public.void_invoice(s10p.v('inv_beta')::uuid, 'Beta test void');
reset role;

select s10p.check('alpha: ISSUE rows for both invoices, by the office member, with the invoice numbers',
  (select count(*) = 2 and bool_and(actor_user_id = s10p.v('office_a')::uuid) and bool_and(metadata ->> 'invoice_ref' in (s10p.v('ref_void'), s10p.v('ref_paid')))
   from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid and action = 'ISSUE' and entity_table = 'invoices' and entity_id in (s10p.v('inv_void'), s10p.v('inv_paid'))));
select s10p.check('alpha: RECORD_PAYMENT and MARK_PAID rows for the paid invoice, by the office member',
  (select count(*) filter (where action = 'RECORD_PAYMENT') >= 1 and count(*) filter (where action = 'MARK_PAID') = 1 and bool_and(actor_user_id = s10p.v('office_a')::uuid)
   from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid and entity_table = 'invoices' and entity_id = s10p.v('inv_paid') and action in ('RECORD_PAYMENT', 'MARK_PAID')));
select s10p.check('alpha: one VOID_INVOICE row, by the admin, with the trimmed reason, the invoice number and the status it left',
  (select count(*) = 1 and bool_and(actor_user_id = s10p.v('admin_a')::uuid and metadata ->> 'reason' = 'Raised against the wrong customer'
          and metadata ->> 'invoice_ref' = s10p.v('ref_void') and metadata ->> 'from_status' = 'issued' and organization_id = s10p.v('alpha')::uuid)
   from security_audit.audit_log where action = 'VOID_INVOICE' and entity_id = s10p.v('inv_void')));
select s10p.check('beta''s void is recorded in beta''s chain, not alpha''s',
  (select count(*) = 1 and bool_and(organization_id = s10p.v('beta')::uuid) from security_audit.audit_log where action = 'VOID_INVOICE' and entity_id = s10p.v('inv_beta')));
select s10p.check('the row-change trigger recorded the status change to void as an UPDATE of the invoice (old and new row), before the VOID_INVOICE event',
  (select count(*) >= 1 from security_audit.audit_log u join security_audit.audit_log v on v.action = 'VOID_INVOICE' and v.entity_id = u.entity_id
   where u.entity_table = 'invoices' and u.action = 'UPDATE' and u.entity_id = s10p.v('inv_void') and u.new_data ->> 'status' = 'void' and u.old_data ->> 'status' = 'issued' and u.created_at <= v.created_at));
select s10p.put('alpha_rows', (select count(*)::text from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid));
select s10p.put('alpha_ids', (select string_agg(id::text, ',' order by id) from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid));
select s10p.put('beta_ids', (select string_agg(id::text, ',' order by id) from security_audit.audit_log where organization_id = s10p.v('beta')::uuid));
select s10p.put('other_ids', (select coalesce(string_agg(id::text, ',' order by id), '') from security_audit.audit_log where organization_id is distinct from s10p.v('alpha')::uuid and organization_id is distinct from s10p.v('beta')::uuid));
select s10p.check('alpha has a real chain to verify (rows from the organisation setup, the invoices, the payment and the void)', s10p.v('alpha_rows')::int >= 12);
select s10p.check('the chain: each row''s previous_hash is the previous row''s hash, the first has none, and every hash recomputes (alpha)',
  (select total = s10p.v('alpha_rows')::int and broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('alpha')::uuid))
  and (select previous_hash is null from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid order by created_at, id limit 1));
select s10p.check('the chain verifies for beta too, separately (one chain per company)',
  (select total >= 3 and broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('beta')::uuid)));
select s10p.check('no row of one company is chained to a row of another (previous_hash is always a hash of the same company)',
  not exists (select 1 from security_audit.audit_log a join security_audit.audit_log p on p.hash = a.previous_hash where p.organization_id is distinct from a.organization_id));

-- =====================================================================================================================================
-- 2. Attempts by each API role: INSERT, UPDATE, DELETE, TRUNCATE on the table and the view, and switching the triggers off
-- =====================================================================================================================================
-- anon: nothing at all (no schema USAGE, no table privilege)
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select s10p.refused('anon: ' || t.what, t.sql, '42501')
from (values
  ('read the table',   'select * from security_audit.audit_log'),
  ('read the view',    'select * from public.audit_log_view'),
  ('insert',           $$insert into security_audit.audit_log (action, entity_table) values ('FORGED', 'invoices')$$),
  ('update',           $$update security_audit.audit_log set action = 'FORGED'$$),
  ('delete',           'delete from security_audit.audit_log'),
  ('truncate',         'truncate security_audit.audit_log'),
  ('insert via the view', $$insert into public.audit_log_view (action, entity_table) values ('FORGED', 'invoices')$$),
  ('write_audit',      $$select public.write_audit('EXPORT', 'invoices', 'x', null, null, '{}'::jsonb, null, null)$$)) as t(what, sql);
reset role;

-- authenticated: an admin of alpha (the most privileged API role in a company) and an office member
select set_config('request.jwt.claims', s10p.claims('admin_a'), true);
set local role authenticated;
select s10p.refused('authenticated admin: ' || t.what, t.sql, t.code, t.msg)
from (values
  ('insert a row (with a chosen hash)', $$insert into security_audit.audit_log (organization_id, action, entity_table, hash, previous_hash) values (public.current_user_organization_id(), 'FORGED', 'invoices', 'aa', 'bb')$$, '42501', 'permission denied'),
  ('insert ... on conflict do update',  $$insert into security_audit.audit_log (id, action, entity_table) select id, action, entity_table from security_audit.audit_log limit 1 on conflict (id) do update set action = 'FORGED'$$, '42501', 'permission denied'),
  ('update one row',                    $$update security_audit.audit_log set metadata = '{}' where action = 'VOID_INVOICE'$$, '42501', 'permission denied'),
  ('update every row (where true)',     $$update security_audit.audit_log set organization_id = null where true$$, '42501', 'permission denied'),
  ('delete the VOID_INVOICE row',       $$delete from security_audit.audit_log where action = 'VOID_INVOICE'$$, '42501', 'permission denied'),
  ('delete every row',                  'delete from security_audit.audit_log', '42501', 'permission denied'),
  ('truncate',                          'truncate security_audit.audit_log', '42501', 'permission denied'),
  ('insert through the view',           $$insert into public.audit_log_view (organization_id, action, entity_table) values (public.current_user_organization_id(), 'FORGED', 'invoices')$$, '42501', 'permission denied'),
  ('update through the view',           $$update public.audit_log_view set action = 'FORGED' where action = 'VOID_INVOICE'$$, '42501', 'permission denied'),
  ('delete through the view',           $$delete from public.audit_log_view where action = 'VOID_INVOICE'$$, '42501', 'permission denied'),
  ('switch the guards off (session_replication_role = replica)', 'set session_replication_role = replica', '42501', 'permission denied'),
  ('disable the append-only trigger',   'alter table security_audit.audit_log disable trigger audit_log_prevent_mutation', '42501', 'must be owner'),
  ('drop the append-only trigger',      'drop trigger audit_log_prevent_mutation on security_audit.audit_log', '42501', 'must be owner'),
  ('replace the chain function',        $$create or replace function security_audit.set_audit_hash() returns trigger language plpgsql as 'begin return new; end'$$, '42501', 'permission denied')
) as t(what, sql, code, msg);
select set_config('request.jwt.claims', s10p.claims('office_a'), true);
select s10p.refused('authenticated office: ' || t.what, t.sql, '42501')
from (values
  ('update',   $$update security_audit.audit_log set action = 'FORGED' where action = 'ISSUE'$$),
  ('delete',   $$delete from security_audit.audit_log where action = 'ISSUE'$$),
  ('insert',   $$insert into security_audit.audit_log (action, entity_table) values ('FORGED', 'invoices')$$),
  ('truncate', 'truncate security_audit.audit_log')) as t(what, sql);
reset role;

-- service_role: BYPASSRLS, but not owner and no table privilege; the trigger is the second lock either way
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select s10p.refused('service_role: ' || t.what, t.sql, '42501', 'permission denied')
from (values
  ('insert',   $$insert into security_audit.audit_log (organization_id, action, entity_table) values (null, 'FORGED', 'invoices')$$),
  ('update',   $$update security_audit.audit_log set action = 'FORGED'$$),
  ('delete',   'delete from security_audit.audit_log'),
  ('truncate', 'truncate security_audit.audit_log'),
  ('insert through the view', $$insert into public.audit_log_view (action, entity_table) values ('FORGED', 'invoices')$$),
  ('update through the view', $$update public.audit_log_view set action = 'FORGED'$$),
  ('delete through the view', 'delete from public.audit_log_view'),
  ('switch the guards off',   'set session_replication_role = replica')) as t(what, sql);
reset role;

select s10p.check('nothing above changed the log: alpha''s rows are the same count and the chain still verifies',
  (select count(*) = s10p.v('alpha_rows')::int from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid)
  and (select broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('alpha')::uuid)));

-- =====================================================================================================================================
-- 3. The second lock: privileges AND an open policy given to the API roles (inside this transaction only) still don't allow a change
-- =====================================================================================================================================
savepoint second_lock;
grant usage on schema security_audit to service_role;
grant select, insert, update, delete, truncate on security_audit.audit_log to authenticated, service_role;
create policy zz_s10_open on security_audit.audit_log for all to authenticated, service_role using (true) with check (true);
select set_config('request.jwt.claims', s10p.claims('admin_a'), true);
set local role authenticated;
select s10p.refused('authenticated with every privilege and an open policy: update', $$update security_audit.audit_log set metadata = '{"forged":true}' where action = 'VOID_INVOICE'$$, 'P0001', 'append-only');
select s10p.refused('authenticated with every privilege and an open policy: delete', $$delete from security_audit.audit_log where action = 'VOID_INVOICE'$$, 'P0001', 'append-only');
select s10p.refused('authenticated with every privilege and an open policy: update of the whole log', 'update security_audit.audit_log set action = action', 'P0001', 'append-only');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select s10p.refused('service_role with every privilege: update', $$update security_audit.audit_log set metadata = '{"forged":true}' where action = 'VOID_INVOICE'$$, 'P0001', 'append-only');
select s10p.refused('service_role with every privilege: delete', $$delete from security_audit.audit_log where action = 'VOID_INVOICE'$$, 'P0001', 'append-only');
reset role;
-- An insert that is allowed by privilege and policy is still chained by the database: a forged created_at / previous_hash / hash is overwritten.
set local role service_role;
select s10p.allowed('service_role with every privilege: insert a row that claims its own hash, previous hash and a 2001 timestamp',
  format($$insert into security_audit.audit_log (organization_id, action, entity_table, entity_id, hash, previous_hash, created_at) values (%L, 'S10_FORGED', 'invoices', 'x', 'forged-hash', 'forged-previous', timestamptz '2001-01-01')$$, s10p.v('alpha')));
reset role;
select s10p.check('... the stored row has the real previous hash (the company''s last row), a recomputed hash and the real time, not the forged ones',
  (select a.hash <> 'forged-hash' and a.previous_hash <> 'forged-previous' and a.created_at > now() - interval '1 hour'
          and a.previous_hash = (select p.hash from security_audit.audit_log p where p.organization_id = a.organization_id and p.id <> a.id order by p.created_at desc limit 1)
   from security_audit.audit_log a where a.action = 'S10_FORGED'));
rollback to savepoint second_lock;
select s10p.check('the grant, the policy and the forged row are rolled back (the log is as it was)',
  not has_table_privilege('authenticated', 'security_audit.audit_log', 'UPDATE') and not has_table_privilege('service_role', 'security_audit.audit_log', 'INSERT')
  and not exists (select 1 from pg_policy where polrelid = 'security_audit.audit_log'::regclass and polname = 'zz_s10_open')
  and not exists (select 1 from security_audit.audit_log where action = 'S10_FORGED'));

-- =====================================================================================================================================
-- 4. The way in for a signed-in user: write_audit, a whitelist; and what it can't be made to say
-- =====================================================================================================================================
select set_config('request.jwt.claims', s10p.claims('admin_a'), true);
set local role authenticated;
-- Events the database writes itself, with the change they describe (035, 073, 105 and the payment functions): none can be made up.
select s10p.refused('admin cannot record a made-up ' || a, format($$select public.write_audit(%L, 'invoices', %L, null, '{"made_up":true}'::jsonb, '{"reason":"forged"}'::jsonb, null, null)$$, a, s10p.v('inv_paid')), '42501')
from unnest(array['VOID_INVOICE', 'ISSUE', 'MARK_PAID', 'RECORD_PAYMENT', 'REVERSE_PAYMENT', 'CONFIRM_PAYMENTS', 'CONFIRM_STILL_OWED', 'APPLY_CREDIT', 'REFUND_CUSTOMER_CREDIT',
                   'WRITE_OFF_INVOICE', 'REVERSE_WRITE_OFF', 'RESEND', 'REOPEN', 'INSPECT_JOB', 'INSERT', 'UPDATE_INVOICE', 'DELETE_AUDIT', 'MADE_UP']) a;
select s10p.refused('admin cannot record ' || a || ' with a chosen metadata (095: the AI events must be exactly the shape the app sends)',
  format($$select public.write_audit(%L, 'invoices', %L, null, null, '{"kind":"invoice","checker":"rules-v1","count":1,"codes":["x"],"note":"free text"}'::jsonb, null, null)$$, a, s10p.v('inv_paid')), '42501')
from unnest(array['ai_finance_check_requested', 'ai_finance_check_completed', 'ai_suggestion_accepted', 'ai_suggestion_rejected']) a;
select s10p.refused('admin cannot record an event about a table that is not on the list (security_audit.audit_log, or an invented one)',
  format($$select public.write_audit('EXPORT', %L, 'x', null, null, '{}'::jsonb, null, null)$$, t), '42501')
from unnest(array['audit_log', 'security_audit.audit_log', 'pg_authid', 'made_up_table']) t;
-- What it does accept: a read event, and (admin only, on user_profiles) PASSWORD_RESET_PREPARED.
select s10p.allowed('admin records EXPORT on invoices (a read event)', $$select public.write_audit('EXPORT', 'invoices', 'S10-export', null, null, '{"rows":3}'::jsonb, '203.0.113.5, 10.0.0.1', 'S10 test agent')$$);
select s10p.allowed('admin records PASSWORD_RESET_PREPARED on user_profiles', format($$select public.write_audit('PASSWORD_RESET_PREPARED', 'user_profiles', %L, null, null, '{}'::jsonb, null, null)$$, s10p.v('office_a')));
select s10p.refused('admin cannot record PASSWORD_RESET_PREPARED on any other table', $$select public.write_audit('PASSWORD_RESET_PREPARED', 'invoices', 'x', null, null, '{}'::jsonb, null, null)$$, '42501');
-- The caller cannot choose the company or the actor, whatever the payload claims.
select s10p.allowed('admin records EXPORT on jobs whose payload claims another company and actor',
  format($$select public.write_audit('EXPORT', 'jobs', 'S10-claims', null, jsonb_build_object('organization_id', %L, 'actor_user_id', %L), jsonb_build_object('organization_id', %L, 'source', 'database_trigger'), null, null)$$,
         s10p.v('beta'), s10p.v('admin_b'), s10p.v('beta')));
select set_config('request.jwt.claims', s10p.claims('office_a'), true);
select s10p.refused('office cannot record PASSWORD_RESET_PREPARED (admin only)', format($$select public.write_audit('PASSWORD_RESET_PREPARED', 'user_profiles', %L, null, null, '{}'::jsonb, null, null)$$, s10p.v('office_a')), '42501');
select s10p.refused('office cannot record EXPORT on user_profiles (admin only)', $$select public.write_audit('EXPORT', 'user_profiles', 'x', null, null, '{}'::jsonb, null, null)$$, '42501');
select set_config('request.jwt.claims', s10p.claims('viewer_a'), true);
select s10p.refused('viewer cannot record a write event (CREATE on customers)', $$select public.write_audit('CREATE', 'customers', 'x', null, null, '{}'::jsonb, null, null)$$, '42501');
reset role;

select s10p.check('the two accepted events are in alpha''s chain, by the admin, with source write_audit, and the first entry of the forwarded-for list as the IP',
  (select count(*) = 1 and bool_and(actor_user_id = s10p.v('admin_a')::uuid and organization_id = s10p.v('alpha')::uuid and metadata ->> 'source' = 'write_audit'
          and ip_address = '203.0.113.5'::inet and user_agent = 'S10 test agent')
   from security_audit.audit_log where action = 'EXPORT' and entity_id = 'S10-export'));
select s10p.check('the event whose payload named beta and its admin was stored for alpha and the admin who called, with source write_audit',
  (select count(*) = 1 and bool_and(organization_id = s10p.v('alpha')::uuid and actor_user_id = s10p.v('admin_a')::uuid and metadata ->> 'source' = 'write_audit')
   from security_audit.audit_log where action = 'EXPORT' and entity_id = 'S10-claims'));
select s10p.check('no made-up event reached the log (none of the refused names appears with source write_audit by the app, other than the two accepted events)',
  not exists (select 1 from security_audit.audit_log where action in ('MADE_UP', 'DELETE_AUDIT', 'UPDATE_INVOICE', 'WRITE_OFF_INVOICE', 'REVERSE_WRITE_OFF') and organization_id in (s10p.v('alpha')::uuid, s10p.v('beta')::uuid))
  and (select count(*) from security_audit.audit_log where action = 'VOID_INVOICE' and organization_id = s10p.v('alpha')::uuid) = 1
  and (select count(*) from security_audit.audit_log where action = 'MARK_PAID' and organization_id = s10p.v('alpha')::uuid) = 1);
select s10p.check('the chain still verifies after the accepted events (alpha)', (select broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('alpha')::uuid)));

-- =====================================================================================================================================
-- 7. The view: what each reader sees (computed before the tamper tests; same rows)
-- =====================================================================================================================================
select s10p.put('alpha_ids', (select string_agg(id::text, ',' order by id) from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid));
select s10p.put('beta_ids', (select string_agg(id::text, ',' order by id) from security_audit.audit_log where organization_id = s10p.v('beta')::uuid));

select set_config('request.jwt.claims', s10p.claims('admin_a'), true);
set local role authenticated;
select s10p.check('alpha admin: the view returns every alpha row (same ids as the table), so nothing a member should see is hidden',
  (select string_agg(id::text, ',' order by id) from public.audit_log_view) = s10p.v('alpha_ids'));
select s10p.check('alpha admin: the view shows no row of beta or of no company, and not beta''s VOID_INVOICE',
  not exists (select 1 from public.audit_log_view where organization_id is distinct from s10p.v('alpha')::uuid)
  and not exists (select 1 from public.audit_log_view where entity_id = s10p.v('inv_beta')));
select s10p.check('alpha admin: the view carries the hash and previous hash of each row (so a copy of it can be checked against the chain)',
  (select bool_and(hash is not null) and count(*) filter (where previous_hash is null) = 1 from public.audit_log_view));
select s10p.check('alpha admin: the table read directly gives the same rows (the policy, not the view, is the boundary)',
  (select string_agg(id::text, ',' order by id) from security_audit.audit_log) = s10p.v('alpha_ids'));
select set_config('request.jwt.claims', s10p.claims('office_a'), true);
select s10p.check('alpha office sees no audit row (admins only)', (select count(*) = 0 from public.audit_log_view) and (select count(*) = 0 from security_audit.audit_log));
select set_config('request.jwt.claims', s10p.claims('viewer_a'), true);
select s10p.check('alpha viewer sees no audit row (admins only)', (select count(*) = 0 from public.audit_log_view) and (select count(*) = 0 from security_audit.audit_log));
select set_config('request.jwt.claims', s10p.claims('admin_b'), true);
select s10p.check('beta admin: the view returns beta''s rows and only beta''s (none of alpha''s ISSUE / VOID_INVOICE / MARK_PAID)',
  (select string_agg(id::text, ',' order by id) from public.audit_log_view) = s10p.v('beta_ids')
  and not exists (select 1 from public.audit_log_view where organization_id is distinct from s10p.v('beta')::uuid)
  and not exists (select 1 from public.audit_log_view where entity_id in (s10p.v('inv_void'), s10p.v('inv_paid')))
  and exists (select 1 from public.audit_log_view where action = 'VOID_INVOICE' and entity_id = s10p.v('inv_beta')));
reset role;

-- =====================================================================================================================================
-- 6. Tamper evidence. The table owner is the one role that can switch the guards off (a DBA, the SQL editor, a restore); every change
--    below is made as the owner inside a subtransaction, verified while it is in place, and undone.
-- =====================================================================================================================================
select s10p.refused('the owner, without switching anything off, is still refused: update', $$update security_audit.audit_log set metadata = '{"x":1}' where action = 'VOID_INVOICE'$$, 'P0001', 'append-only');
select s10p.refused('the owner, without switching anything off, is still refused: delete', $$delete from security_audit.audit_log where action = 'VOID_INVOICE'$$, 'P0001', 'append-only');

select s10p.put('alpha_rows_pre_tamper', (select count(*)::text from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid));
-- 6a. detected
select s10p.tamper('owner edits the VOID_INVOICE reason (trigger disabled)', s10p.v('alpha')::uuid,
  $$alter table security_audit.audit_log disable trigger audit_log_prevent_mutation;
    update security_audit.audit_log set metadata = jsonb_set(metadata, '{reason}', '"Nothing to see"') where action = 'VOID_INVOICE'$$, true, 0, 1);
select s10p.tamper('owner edits the VOID_INVOICE reason (session_replication_role = replica)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica;
    update security_audit.audit_log set metadata = jsonb_set(metadata, '{reason}', '"Nothing to see"') where action = 'VOID_INVOICE'$$, true, 0, 1);
select s10p.tamper('owner changes who voided it (actor_user_id)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica; update security_audit.audit_log set actor_user_id = %L where action = 'VOID_INVOICE'$$, s10p.v('office_a')), true, 0, 1);
select s10p.tamper('owner changes the entity a row is about (entity_id)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica; update security_audit.audit_log set entity_id = %L where action = 'VOID_INVOICE'$$, s10p.v('inv_paid')), true, 0, 1);
select s10p.tamper('owner changes the recorded old row of a row-change entry (old_data)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica; update security_audit.audit_log set old_data = old_data || '{"status":"paid"}' where action = 'UPDATE' and entity_table = 'invoices' and new_data ->> 'status' = 'void'$$, true, 0, 1);
select s10p.tamper('owner changes a row''s time (created_at)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica; update security_audit.audit_log set created_at = created_at - interval '1 second' where action = 'VOID_INVOICE'$$, true);
select s10p.tamper('owner deletes the VOID_INVOICE row (a row in the middle of the chain)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica; delete from security_audit.audit_log where action = 'VOID_INVOICE'$$, true, 1, 0);
select s10p.tamper('owner deletes the first row of the chain', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica; delete from security_audit.audit_log where id = (select id from security_audit.audit_log where organization_id = (select v::uuid from s10p.ctx where k = 'alpha') order by created_at, id limit 1)$$, true, 1, 0);
select s10p.tamper('owner deletes every row of one action (all the ISSUE rows)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica; delete from security_audit.audit_log where action = 'ISSUE'$$, true);
select s10p.tamper('owner edits a middle row''s payload and re-computes THAT row''s hash (the next row''s link breaks)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica;
    update security_audit.audit_log a set metadata = jsonb_set(metadata, '{reason}', '"Nothing to see"') where action = 'VOID_INVOICE';
    update security_audit.audit_log a set hash = encode(extensions.digest(
      coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table || coalesce(entity_id, '') ||
      coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text, 'sha256'), 'hex') where action = 'VOID_INVOICE'$$, true, 1, 0);
select s10p.tamper('owner sets a row''s hash to a made-up value', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica; update security_audit.audit_log set hash = 'forged' where action = 'VOID_INVOICE'$$, true);
select s10p.tamper('owner inserts a back-dated row with a made-up hash (trigger bypassed)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica;
    insert into security_audit.audit_log (organization_id, action, entity_table, entity_id, previous_hash, hash, created_at)
    select %L, 'VOID_INVOICE', 'invoices', %L, previous_hash, 'forged', created_at - interval '1 millisecond' from security_audit.audit_log where action = 'VOID_INVOICE' and organization_id = %L$$, s10p.v('alpha'), s10p.v('inv_paid'), s10p.v('alpha')), true);
select s10p.tamper('owner moves a row to another company (organization_id)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica; update security_audit.audit_log set organization_id = %L where action = 'VOID_INVOICE'$$, s10p.v('beta')), true);
select s10p.tamper('owner deletes the company''s whole chain (a company with no rows verifies trivially: the caller must expect rows)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica; delete from security_audit.audit_log where organization_id = %L$$, s10p.v('alpha')), false);

-- 6b. not detected by the chain alone (reported, not failures): what the hash does not cover, and what has nothing after it to break
select s10p.tamper('owner edits actor_email, ip_address, user_agent and request_id (not part of the hash)', s10p.v('alpha')::uuid,
  $$set local session_replication_role = replica;
    update security_audit.audit_log set actor_email = 'someone.else@example.test', ip_address = '198.51.100.9', user_agent = 'forged', request_id = 'forged' where action = 'VOID_INVOICE'$$, false);
select s10p.tamper('owner deletes the LAST rows of the chain (nothing after them to break)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica;
    delete from security_audit.audit_log where id in (select id from security_audit.audit_log where organization_id = %L order by created_at desc, id desc limit 2)$$, s10p.v('alpha')), false);
select s10p.tamper('owner edits the LAST row and re-computes its hash (nothing after it to break)', s10p.v('alpha')::uuid,
  format($$set local session_replication_role = replica;
    update security_audit.audit_log a set metadata = metadata || '{"edited":true}' where id = (select id from security_audit.audit_log where organization_id = %L order by created_at desc, id desc limit 1);
    update security_audit.audit_log a set hash = encode(extensions.digest(
      coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table || coalesce(entity_id, '') ||
      coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text, 'sha256'), 'hex')
    where id = (select id from security_audit.audit_log where organization_id = %L order by created_at desc, id desc limit 1)$$, s10p.v('alpha'), s10p.v('alpha')), false);
select s10p.tamper('owner edits the VOID_INVOICE row and re-hashes it and EVERY row after it (needs the hash recipe; nothing outside the table anchors the head)', s10p.v('alpha')::uuid,
  format($t$set local session_replication_role = replica;
    update security_audit.audit_log set metadata = jsonb_set(metadata, '{reason}', '"Nothing to see"') where action = 'VOID_INVOICE';
    do $do$
    declare r record; prev text;
    begin
      for r in select id from security_audit.audit_log where organization_id = %L and created_at >= (select min(created_at) from security_audit.audit_log where action = 'VOID_INVOICE') order by created_at, id loop
        select hash into prev from security_audit.audit_log a2 where a2.organization_id = %L and a2.created_at < (select created_at from security_audit.audit_log where id = r.id) order by a2.created_at desc limit 1;
        update security_audit.audit_log set previous_hash = prev, hash = encode(extensions.digest(
          coalesce(prev, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table || coalesce(entity_id, '') ||
          coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text, 'sha256'), 'hex') where id = r.id;
      end loop;
    end $do$$t$, s10p.v('alpha'), s10p.v('alpha')), false);
savepoint s10_trunc2;
truncate security_audit.audit_log;
select s10p.gap('the table owner can TRUNCATE the log (no BEFORE TRUNCATE trigger; no API role has the privilege); undone below');
select s10p.check('... and the log is empty while the damage is in place', (select count(*) = 0 from security_audit.audit_log));
rollback to savepoint s10_trunc2;
select s10p.check('... and it is back after the rollback', (select count(*) > 0 from security_audit.audit_log) and (select broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('alpha')::uuid)));

select s10p.check('the log and its chain are exactly as they were before the tamper tests (alpha and beta)',
  (select count(*) = s10p.v('alpha_rows_pre_tamper')::int from security_audit.audit_log where organization_id = s10p.v('alpha')::uuid)
  and (select broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('alpha')::uuid))
  and (select broken_links = 0 and bad_hashes = 0 from s10p.verify_chain(s10p.v('beta')::uuid))
  and not has_table_privilege('authenticated', 'security_audit.audit_log', 'UPDATE')
  and (select count(*) = 1 from pg_trigger where tgrelid = 'security_audit.audit_log'::regclass and tgname = 'audit_log_prevent_mutation' and tgenabled = 'O'));

select s10p.ok('summary', (select count(*) filter (where kind <> 'GAP' and kind <> 'info' and kind <> 'summary') || ' checks passed, ' || count(*) filter (where kind = 'GAP') || ' reported exemptions (GAP)' from s10p.results));
select 'PASS audit integrity proof' as result,
       (select count(*) filter (where kind not in ('GAP', 'info', 'summary')) from s10p.results) as checks,
       (select count(*) filter (where kind = 'GAP') from s10p.results) as gaps,
       (select count(*) filter (where kind = 'refused') from s10p.results) as refusals,
       (select count(*) filter (where kind = 'detected') from s10p.results) as tampers_detected;
rollback;
