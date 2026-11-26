-- REHEARSAL SEED for scratch only (synthetic ZZ companies shaped like the production ones). Never run on production.
do $seed$
declare A uuid:='00000000-0000-4000-8000-0000000000a1'; B uuid:='00000000-0000-4000-8000-0000000000b1'; L uuid:='00000000-0000-4000-8000-0000000000c1';
  rhys uuid:='00000000-0000-4000-8000-0000000000f1'; john uuid:='00000000-0000-4000-8000-0000000000f2';
  t1 uuid:='00000000-0000-4000-8000-0000000000e1'; t2 uuid:='00000000-0000-4000-8000-0000000000e2'; t3 uuid:='00000000-0000-4000-8000-0000000000e3';
  jid uuid; iid uuid; qid uuid; sid uuid; dn uuid; mid uuid; o uuid; i int;
begin
  insert into public.organizations(id,name,slug) values (A,'ZZ WIPE REHEARSAL A','zz-wipe-a'),(B,'ZZ WIPE REHEARSAL B','zz-wipe-b'),(L,'ZZ WIPE REHEARSAL LIVE','zz-wipe-live');
  insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) select u, 'authenticated','authenticated', e, now(), now(), now(), '{}'::jsonb, '{}'::jsonb
    from (values (rhys,'zz-rhys@wipe.example'),(john,'zz-john@wipe.example'),(t1,'zz-t1@wipe.example'),(t2,'zz-t2@wipe.example'),(t3,'zz-t3@wipe.example')) v(u,e);
  insert into public.organization_members(user_id,organization_id,role,active) values
    (rhys,A,'admin',true),(rhys,B,'admin',true),(rhys,L,'admin',true),(john,A,'admin',true),(john,B,'admin',true),
    (t1,A,'viewer',false),(t1,B,'viewer',false),(t2,A,'office',true),(t3,B,'workshop',true);
  insert into public.organization_settings(organization_id,hidden_nav,company_profile) values (A,array['ui-jobs-v2:on','ui-quotes-v2:on'],'{"name":"ZZ A"}'),(B,array['ui-jobs-v2:on'],'{"name":"ZZ B"}'),(L,'{}','{}')
    on conflict (organization_id) do update set hidden_nav=excluded.hidden_nav, company_profile=excluded.company_profile;
  insert into public.email_templates(organization_id,key,subject,body) values (A,'quote','Quote','Hello'),(B,'quote','Quote','Hello');
  insert into public.costing_defaults(organization_id,labour_rate_pence,programming_rate_pence,overhead_pct,default_margin_pct) values (A,4000,5000,10,20);
  insert into public.doc_counters(organization_id,prefix,last) values (A,'QUO',22),(A,'J',28),(A,'INV',13),(A,'SO',3),(A,'PO',9),(A,'DLN',10),(A,'CRD',4),(B,'INV',1),(B,'J',4),(B,'QUO',3);
  insert into public.dln_numbering_pending(organization_id) values (B);
  foreach o in array array[A,B] loop
    insert into public.customers(organization_id,name) select o,'Cust '||g from generate_series(1, case when o=A then 9 else 1 end) g;
    insert into public.overview_owed_snapshots(organization_id,snapshot_date,owed_amount,late_amount) select o, current_date-g, 100, 10 from generate_series(1,26) g;
  end loop;
  insert into public.overview_owed_snapshots(organization_id,snapshot_date,owed_amount,late_amount) select L, current_date-g, 0, 0 from generate_series(1,16) g;
  insert into public.suppliers(organization_id,name) select A,'Sup '||g from generate_series(1,9) g;
  insert into public.machines(organization_id,name) values (A,'VMC 1') returning id into mid;
  insert into public.stock(organization_id,sku,material) select A,'S'||g,'Mat' from generate_series(1,6) g;
  insert into public.rfqs(organization_id,customer) select A,'RFQ cust '||g from generate_series(1,10) g;
  insert into public.purchase_orders(organization_id) select A from generate_series(1,10);
  foreach o in array array[A,B] loop
    for i in 1..(case when o=A then 28 else 3 end) loop
      insert into public.quotes(organization_id,quote_ref,customer) values (o,'QUO-'||substr(o::text,35,2)||'-'||i,'Cust 1') returning id into qid;
      if i<=(case when o=A then 31 else 3 end) then insert into public.quote_line_items(organization_id,quote_id,description) values (o,qid,'line'); end if;
    end loop;
    for i in 1..(case when o=A then 21 else 1 end) loop
      insert into public.sales_orders(organization_id,so_number) values (o,'SO-'||substr(o::text,35,2)||'-'||i) returning id into sid;
      insert into public.sales_order_lines(organization_id,sales_order_id,description,quantity,unit_price) values (o,sid,'sol',1,10);
    end loop;
    for i in 1..(case when o=A then 27 else 2 end) loop
      insert into public.jobs(organization_id,job_no) values (o,'J-'||substr(o::text,35,2)||'-'||i) returning id into jid;
      insert into public.job_values(job_id,organization_id) values (jid,o);
      insert into public.job_flow_events(seq,organization_id,job_id,kind) values (floor(random()*1e15)::bigint,o,jid,'created');
      if o=A and i<=9 then insert into public.job_machines(organization_id,job_id,machine_id,estimated_hours) values (o,jid,mid,1); end if;
      if i<=(case when o=A then 26 else 3 end) then insert into public.machine_runs(organization_id,job_id,started_at) values (o,jid,now()); end if;
    end loop;
    for i in 1..(case when o=A then 20 else 1 end) loop
      insert into public.invoices(organization_id,customer) values (o,'Cust 1') returning id into iid;
      insert into public.invoice_line_items(organization_id,invoice_id,description) values (o,iid,'il');
      insert into public.invoice_payments(organization_id,invoice_id,amount) values (o,iid,5);
      if o=A and i<=4 then insert into public.credit_notes(organization_id,invoice_id,customer) values (o,iid,'Cust 1'); end if;
    end loop;
  end loop;
  for i in 1..10 loop
    insert into public.delivery_notes(organization_id,dn_number) values (A,'DLN-'||i) returning id into dn;
    insert into public.delivery_note_items(organization_id,delivery_note_id,description) values (A,dn,'item');
  end loop;
  insert into public.record_archive_state(organization_id,record_table,record_id,state) select A,'jobs',gen_random_uuid(),'archived' from generate_series(1,69);
  insert into public.email_history(organization_id,to_email,subject,body,status) select A,'x@wipe.example','s','b','sent' from generate_series(1,3);
  insert into public.chase_pauses(organization_id,reason) select A,'r' from generate_series(1,2);
  insert into security_audit.audit_log(organization_id,actor_user_id,action,entity_table,entity_id) values (L,rhys,'ORGANIZATION_SETTINGS_UPDATE','organization_settings',''),(L,rhys,'ORGANIZATION_SETTINGS_UPDATE','organization_settings','');
end
$seed$;
