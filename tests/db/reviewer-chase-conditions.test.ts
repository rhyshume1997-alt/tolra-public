import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {approveChaseDraft} from '@/lib/email/chase/approve';
import {createSyntheticWorld,destroySyntheticWorld,verifyBackendIdentity,adminClient,signedInClient,type SyntheticWorld} from '../support/fixtures';
it('real SQL claims send exact approved text once and close uncertain attempts against resend',async()=>{
 await verifyBackendIdentity();const world=await createSyntheticWorld();
 try{
  const org=world.tenants.alpha.id,actor=world.tenants.alpha.users.office,service=adminClient(),db=await signedInClient(actor);
  expect((await service.from('customers').insert({organization_id:org,name:'SQL chase customer',email:'chase@example.test'})).error).toBeNull();
  const step=await service.from('chase_steps').insert({organization_id:org,offset_days:1,tone:'friendly'}).select('id').single();expect(step.error).toBeNull();
  const subject='Exact approved subject',body='Hello,\n\n  Keep these spaces.\n';
  const draft=async()=>{
   const invoice=await service.from('invoices').insert({organization_id:org,invoice_ref:`INV-${crypto.randomUUID()}`,customer:'SQL chase customer',status:'sent',total:120,amount_paid:0,due_date:'2000-01-01'}).select('id').single();expect(invoice.error).toBeNull();
   const result=await service.rpc('chase_create_draft',{p_org:org,p_invoice:invoice.data!.id,p_step:step.data!.id,p_to:'chase@example.test',p_to_name:'Customer',p_subject:subject,p_body:body,p_user:actor.id});expect(result.error).toBeNull();expect(result.data.created).toBe(true);return result.data.history_id as string;
  };
  const id=await draft();
  const send=vi.fn(async(input:{subject:string;text:string})=>{
   expect(input.subject).toBe(subject);expect(input.text).toBe(body);
   const result=await service.from('email_history').insert({organization_id:org,to_email:'chase@example.test',subject:input.subject,body:input.text,status:'sent_via_system',related_to_type:'general'}).select('id').single();expect(result.error).toBeNull();
   return {ok:true as const,mode:'sent' as const,provider:'mock' as const,historyId:result.data!.id};
  });
  const input={organizationId:org,userId:actor.id,draftId:id,expectedSubject:subject,expectedBody:body,today:new Date().toISOString().slice(0,10)};
  const deps={db,admin:service,provider:async()=>({}),send,allowlisted:()=>false};
  expect((await approveChaseDraft({...input,expectedBody:'Stale reviewed text'},deps)).status).toBe('refused');
  expect(send).not.toHaveBeenCalled();
  const stillDraft=await service.from('email_history').select('status,subject,body').eq('id',id).single();
  expect(stillDraft.error).toBeNull();expect(stillDraft.data).toEqual({status:'drafted',subject,body});
  const attempts=await Promise.all([approveChaseDraft(input,deps),approveChaseDraft(input,deps)]);
  expect(attempts.filter(r=>r.status==='sent')).toHaveLength(1);expect(send).toHaveBeenCalledTimes(1);
  const uncertainId=await draft();const uncertain=vi.fn(async()=>({ok:false as const,code:'provider_error' as const,error:'Synthetic timeout',uncertain:true}));
  const uncertainInput={...input,draftId:uncertainId};
  expect((await approveChaseDraft(uncertainInput,{...deps,send:uncertain})).status).toBe('refused');
  expect((await approveChaseDraft(uncertainInput,{...deps,send:uncertain})).status).toBe('refused');expect(uncertain).toHaveBeenCalledTimes(1);
  const stored=await service.from('email_history').select('status,subject,body').eq('id',uncertainId).single();expect(stored.error).toBeNull();expect(stored.data).toEqual({status:'unknown',subject,body});
 }finally{await destroySyntheticWorld(world.runId);}
},120000);

async function buildReviewer(world:SyntheticWorld){
 const org=world.tenants.alpha.id,actor=world.tenants.alpha.users.office,service=adminClient(),db=await signedInClient(actor);
 expect((await service.from('customers').insert({organization_id:org,name:'Named proof customer',email:'named@example.test'})).error).toBeNull();
 const step=await service.from('chase_steps').insert({organization_id:org,offset_days:1,tone:'friendly'}).select('id').single();expect(step.error).toBeNull();
 const invoice=await service.from('invoices').insert({organization_id:org,invoice_ref:`INV-${crypto.randomUUID()}`,customer:'Named proof customer',status:'sent',total:120,amount_paid:0,due_date:'2000-01-01'}).select('id').single();expect(invoice.error).toBeNull();
 const subject='Reviewed subject',body='Hello,\n\nExact approved text.\n';
 const created=await service.rpc('chase_create_draft',{p_org:org,p_invoice:invoice.data!.id,p_step:step.data!.id,p_to:'named@example.test',p_to_name:'Named proof customer',p_subject:subject,p_body:body,p_user:actor.id});expect(created.error).toBeNull();expect(created.data.created).toBe(true);
 const send=vi.fn(async(message:{subject:string;text:string})=>{
  const sent=await service.from('email_history').insert({organization_id:org,to_email:'named@example.test',subject:message.subject,body:message.text,status:'sent_via_system',related_to_type:'general'}).select('id').single();expect(sent.error).toBeNull();
  return {ok:true as const,mode:'sent' as const,provider:'mock' as const,historyId:sent.data!.id};
 });
 const input={organizationId:org,userId:actor.id,draftId:created.data.history_id as string,expectedSubject:subject,expectedBody:body,today:new Date().toISOString().slice(0,10)};
 return {world,org,actor,service,db,stepId:step.data!.id,invoiceId:invoice.data!.id,input,send,deps:{db,admin:service,provider:async()=>({}),send,allowlisted:()=>false}};
}
async function reviewerScenario(run:(context:Awaited<ReturnType<typeof buildReviewer>>)=>Promise<void>){
 await verifyBackendIdentity();const world=await createSyntheticWorld();try{await run(await buildReviewer(world));}finally{await destroySyntheticWorld(world.runId);}
}
it('DB: editing the draft voids the previously reviewed approval text',async()=>reviewerScenario(async c=>{
 const edited='Edited after review.\n';
 const update=await c.db.from('email_history').update({body:edited}).eq('id',c.input.draftId).eq('status','drafted').select('id');expect(update.error).toBeNull();expect(update.data).toHaveLength(1);
 expect((await approveChaseDraft(c.input,c.deps)).status).toBe('refused');expect(c.send).not.toHaveBeenCalled();
 const chase=await c.service.from('chase_sends').select('status,approved_by,approved_at').eq('invoice_id',c.invoiceId).single();expect(chase.error).toBeNull();expect(chase.data).toEqual({status:'drafted',approved_by:null,approved_at:null});
 expect((await approveChaseDraft({...c.input,expectedBody:edited},c.deps)).status).toBe('sent');
 expect(c.send).toHaveBeenCalledTimes(1);expect(c.send.mock.calls[0][0].text).toBe(edited);
}),120000);
it('DB: customer paid claim never marks the invoice paid or inserts a payment',async()=>reviewerScenario(async c=>{
 const financial=()=>c.service.from('invoices').select('total,amount_paid,credited_amount,refunded_amount,status').eq('id',c.invoiceId).single();
 const before=await financial();expect(before.error).toBeNull();
 const payments=await c.service.from('invoice_payments').select('*').eq('invoice_id',c.invoiceId);expect(payments.error).toBeNull();
 const claim=await c.db.rpc('mark_payment_claimed',{p_invoice:c.invoiceId,p_source:'manual',p_evidence:'Customer says paid',p_message_id:null});expect(claim.error).toBeNull();
 expect((await financial()).data).toEqual(before.data);
 const afterPayments=await c.service.from('invoice_payments').select('*').eq('invoice_id',c.invoiceId);expect(afterPayments.error).toBeNull();expect(afterPayments.data).toEqual(payments.data);
 const claimed=await c.service.from('invoices').select('payment_claimed_at').eq('id',c.invoiceId).single();expect(claimed.error).toBeNull();expect(claimed.data!.payment_claimed_at).not.toBeNull();
 expect((await approveChaseDraft(c.input,c.deps)).status).toBe('refused');expect(c.send).not.toHaveBeenCalled();
}),120000);
it('DB: duplicate approval and subsequent retries send exactly once',async()=>reviewerScenario(async c=>{
 const result=await Promise.all([approveChaseDraft(c.input,c.deps),approveChaseDraft(c.input,c.deps)]);
 expect(result.filter(r=>r.status==='sent')).toHaveLength(1);
 expect((await approveChaseDraft(c.input,c.deps)).status).toBe('refused');expect(c.send).toHaveBeenCalledTimes(1);
 const rows=await c.service.from('chase_sends').select('status,approved_by,approved_at').eq('invoice_id',c.invoiceId);expect(rows.error).toBeNull();expect(rows.data).toHaveLength(1);expect(rows.data![0]).toMatchObject({status:'sent',approved_by:c.actor.id});expect(rows.data![0].approved_at).not.toBeNull();
}),120000);
it('DB: cross-company chase creation approval and payment claims are blocked',async()=>reviewerScenario(async c=>{
 const beta=c.world.tenants.beta,other=await signedInClient(beta.users.office);
 const before=await c.service.from('email_history').select('*').eq('id',c.input.draftId).single();expect(before.error).toBeNull();
 const read=await other.from('email_history').select('id').eq('id',c.input.draftId);expect(read.error).toBeNull();expect(read.data).toEqual([]);
 const create=await c.service.rpc('chase_create_draft',{p_org:beta.id,p_invoice:c.invoiceId,p_step:c.stepId,p_to:'named@example.test',p_to_name:'Named proof customer',p_subject:c.input.expectedSubject,p_body:c.input.expectedBody,p_user:beta.users.office.id});expect(create.error?.code).toBe('P0002');
 expect((await approveChaseDraft({...c.input,organizationId:beta.id,userId:beta.users.office.id},{...c.deps,db:other})).status).toBe('refused');expect(c.send).not.toHaveBeenCalled();
 const claim=await other.rpc('mark_payment_claimed',{p_invoice:c.invoiceId,p_source:'manual',p_evidence:'Foreign attempt',p_message_id:null});expect(claim.error?.code).toBe('P0002');
 const after=await c.service.from('email_history').select('*').eq('id',c.input.draftId).single();expect(after.error).toBeNull();expect(after.data).toEqual(before.data);
}),120000);
