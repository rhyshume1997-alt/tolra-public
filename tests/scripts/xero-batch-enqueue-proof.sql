-- E3 proof (plain PostgreSQL stand-in, whole chain 000..101): the Xero batch queues a document that has no send row with a direct
-- INSERT ... ON CONFLICT DO NOTHING as the service role (what lib/integrations/xero/batch-deps.ts enqueue does through PostgREST). It must
-- (1) be allowed for the service role through the table's guards and audit trigger, (2) add exactly the row 084's trigger adds,
-- (3) change nothing the second time, (4) be refused for a signed-in user (no write grant). Run: psql -v ON_ERROR_STOP=1 -f this file.
begin;
insert into organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000e3', 'E3 proof co', 'e3-proof-co') on conflict do nothing;
insert into integration_connections (organization_id, provider, status, tenant_id, tenant_name)
  values ('00000000-0000-4000-8000-0000000000e3', 'xero', 'connected', 'tenant-e3', 'E3 org');
set local role service_role;
insert into integration_sends (organization_id, provider, doc_type, doc_id, doc_ref, action)
  values ('00000000-0000-4000-8000-0000000000e3', 'xero', 'invoice', '00000000-0000-4000-8000-0000000000d1', 'INV-E3-1', 'create')
  on conflict (organization_id, provider, doc_type, doc_id, action) do nothing;
insert into integration_sends (organization_id, provider, doc_type, doc_id, doc_ref, action)
  values ('00000000-0000-4000-8000-0000000000e3', 'xero', 'invoice', '00000000-0000-4000-8000-0000000000d1', 'INV-E3-1', 'create')
  on conflict (organization_id, provider, doc_type, doc_id, action) do nothing;
select count(*) as rows_after_two_inserts, min(status) as status, min(attempts) as attempts from integration_sends where doc_id = '00000000-0000-4000-8000-0000000000d1';
reset role;
-- The engine's claim with a document (the batch's first attempt): takes that document's row once (attempts 0 -> 1), then never again for
-- `only`; another document is never taken by it.
insert into integration_mappings (organization_id, provider, kind, tolra_key, external_code, external_name)
  values ('00000000-0000-4000-8000-0000000000e3', 'xero', 'sales_account', '', '200', 'Sales'), ('00000000-0000-4000-8000-0000000000e3', 'xero', 'credit_account', '', '200', 'Sales');
set local role service_role;
select (public.integration_claim_next('00000000-0000-4000-8000-0000000000e3', 'xero', 120, 'invoice', '00000000-0000-4000-8000-0000000000d9') -> 'send' ->> 'id') is null as other_doc_not_taken;
select (public.integration_claim_next('00000000-0000-4000-8000-0000000000e3', 'xero', 120, 'invoice', '00000000-0000-4000-8000-0000000000d1') -> 'send' ->> 'attempts') as first_claim_attempts;
select (public.integration_claim_next('00000000-0000-4000-8000-0000000000e3', 'xero', 120, 'invoice', '00000000-0000-4000-8000-0000000000d1') -> 'send' ->> 'id') is null as second_claim_nothing;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
do $$ begin
  begin
    insert into integration_sends (organization_id, provider, doc_type, doc_id, action)
      values ('00000000-0000-4000-8000-0000000000e3', 'xero', 'invoice', '00000000-0000-4000-8000-0000000000d2', 'create');
    raise exception 'FAIL: a signed-in user could insert a send row';
  exception when insufficient_privilege then raise notice 'ok: signed-in user refused (no write grant)';
  end;
end $$;
rollback;
