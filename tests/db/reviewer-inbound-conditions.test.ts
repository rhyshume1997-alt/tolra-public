import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {verifyBackendIdentity,withDb} from '../support/fixtures';
it('real delegated paid replies preserve invoice and payment data for two companies',async()=>{
 await verifyBackendIdentity();await withDb(async db=>{await db.query('BEGIN');try{
  const orgs=[randomUUID(),randomUUID()];
  for(const org of orgs){
   const user=randomUUID(),mailbox=`${org}@example.test`;
   await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Synthetic reply',$2,'active')",[org,`t-reply-${org}`]);
   await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[user,mailbox]);
   await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic','admin',$3,true,false)",[user,mailbox,org]);
   await db.query("INSERT INTO public.integration_connections(organization_id,provider,status,tenant_id,connected_by) VALUES($1,'microsoft','connected',$2,$3)",[org,mailbox,user]);
   await db.query('INSERT INTO public.integration_mailbox_sync(organization_id,mailbox_id,mail_read) VALUES($1,$2,true)',[org,mailbox]);
   await db.query("INSERT INTO public.invoices(organization_id,invoice_ref,customer,total,amount_paid,credited_amount,refunded_amount,status) VALUES($1,'INV-PAID-REPLY','Synthetic',120,0,0,0,'sent')",[org]);
  }
  const snapshot=async()=>({invoices:(await db.query('SELECT to_jsonb(i) AS row FROM public.invoices i WHERE organization_id=ANY($1::uuid[]) ORDER BY id',[orgs])).rows,payments:(await db.query('SELECT to_jsonb(p) AS row FROM public.invoice_payments p WHERE organization_id=ANY($1::uuid[]) ORDER BY id',[orgs])).rows});
  const before=await snapshot();
  for(const org of orgs)for(const text of ['We have paid INV-PAID-REPLY','Remittance attached for INV-PAID-REPLY','Payment sent for INV-PAID-REPLY']){
   const id=randomUUID();
   const args=[org,id,`<${id}@example.test>`,'customer@example.test','Customer',text,new Date().toISOString(),text,text];
   const sql='SELECT public.mailbox_record_inbound($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r';
   expect((await db.query(sql,args)).rows[0].r.inserted).toBe(true);
   expect((await db.query(sql,args)).rows[0].r.inserted).toBe(false);
   expect(await snapshot()).toEqual(before);
  }
  expect((await db.query('SELECT organization_id,count(*)::int AS n FROM public.inbound_emails WHERE organization_id=ANY($1::uuid[]) GROUP BY organization_id',[orgs])).rows).toHaveLength(2);
 }finally{await db.query('ROLLBACK');}});
},120000);
