import { expect,it,vi } from 'vitest';
import { runChase } from '@/lib/email/chase/run';
import { approveChaseDraft } from '@/lib/email/chase/approve';
import { FakeDb } from '../support/fake-db';
const company='company-a';
const make=(secondEmail:string|null='second@example.test',secondCompany=company)=>new FakeDb({
 chase_steps:[{id:'step',organization_id:company,offset_days:7,tone:'friendly'}],
 invoices:[{id:'invoice',organization_id:company,invoice_ref:'INV-1',customer:'Shop Ltd',job_id:null,total:120,amount_paid:0,credited_amount:0,refunded_amount:0,status:'sent',due_date:'2026-11-01',payment_unverified:false}],
 customers:[{id:'one',organization_id:company,name:'Shop Ltd',email:'first@example.test',contact_name:null},{id:'two',organization_id:secondCompany,name:' SHOP LTD ',email:secondEmail,contact_name:null}],
 chase_sends:[{id:'send',organization_id:company,invoice_id:'invoice',status:'drafted',draft_history_id:'draft',step_id:'step',offset_days:7}],
 email_history:[{id:'draft',organization_id:company,to_email:'first@example.test',subject:'Invoice INV-1',body:'Please pay',status:'drafted',related_to_type:'invoice',related_to_id:'invoice'}],
 chase_pauses:[],email_schedules:[],jobs:[],purchase_orders:[],email_templates:[],organizations:[{id:company,name:'Our Shop'}],organization_settings:[],user_profiles:[]
});
for(const email of ['second@example.test',null])it(`does not guess a chase recipient when a duplicate record has ${email}`,async()=>{
 const db=make(email);db.tables.chase_sends=[];
 const createDraft=vi.fn().mockResolvedValue({created:true,history_id:"new"});const result=await runChase(db as never,{organizationId:company,today:'2026-11-20'},{createDraft});
 expect(result).toMatchObject({drafted:0,skipped:1,reasons:{ambiguous_customer:1}});expect(createDraft).not.toHaveBeenCalled();
});
it('refuses an existing draft where the customer name is ambiguous',async()=>{
 const db=make(),send=vi.fn(),provider=vi.fn();
 const result=await approveChaseDraft({organizationId:company,userId:'office',draftId:'draft',expectedTo:"first@example.test",expectedSubject:'Invoice INV-1',expectedBody:'Please pay',today:'2026-11-20'}, {db:db as never,admin:{rpc:vi.fn()} as never,send,provider,allowlisted:()=>false});
 expect(result).toMatchObject({status:'refused',http:409,message:'Two customer records use this name. Check them before sending.'});expect(send).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
});
it('does not confuse a same-name customer in another company',async()=>{
 const db=make('other@example.test','company-b');db.tables.chase_sends=[];const createDraft=vi.fn().mockResolvedValue({created:true,history_id:'new'});
 expect(await runChase(db as never,{organizationId:company,today:'2026-11-20'},{createDraft})).toMatchObject({drafted:1});
 expect(createDraft.mock.calls[0][1].to).toBe('first@example.test');
});

it('an invoice total stays the original total when a credit reduces the balance',async()=>{
 const db=make('other@example.test','company-b');db.tables.chase_sends=[];
 Object.assign(db.rows('invoices')[0],{amount_paid:30,credited_amount:20});
 db.rows('email_templates').push({organization_id:company,key:'invoice_reminder',subject:'Reminder',body:'Total {{total}}, balance {{balance}}'});
 const createDraft=vi.fn().mockResolvedValue({created:true,history_id:'new'});
 await runChase(db as never,{organizationId:company,today:'2026-11-20'},{createDraft});
 expect(createDraft.mock.calls[0][1].body).toBe('Total £120.00, balance £70.00');
});
