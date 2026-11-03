import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {approveChaseDraft} from '@/lib/email/chase/approve';
import {createSyntheticWorld,destroySyntheticWorld,verifyBackendIdentity,adminClient,signedInClient} from '../support/fixtures';
it('real SQL claims send exact approved text once and close uncertain attempts against resend',async()=>{
 await verifyBackendIdentity();const world=await createSyntheticWorld();
 try{
  const org=world.tenants.alpha.id,actor=world.tenants.alpha.users.office,service=adminClient(),db=await signedInClient(actor);
  expect((await service.from('customers').insert({organization_id:org,name:'SQL chase customer',email:'chase@example.test'})).error).toBeNull();
  const step=await service.from('chase_steps').insert({organization_id:org,offset_days:0,tone:'friendly'}).select('id').single();expect(step.error).toBeNull();
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
  const attempts=await Promise.all([approveChaseDraft(input,deps),approveChaseDraft(input,deps)]);
  expect(attempts.filter(r=>r.status==='sent')).toHaveLength(1);expect(send).toHaveBeenCalledTimes(1);
  const uncertainId=await draft();const uncertain=vi.fn(async()=>({ok:false as const,code:'provider_error' as const,error:'Synthetic timeout',uncertain:true}));
  const uncertainInput={...input,draftId:uncertainId};
  expect((await approveChaseDraft(uncertainInput,{...deps,send:uncertain})).status).toBe('refused');
  expect((await approveChaseDraft(uncertainInput,{...deps,send:uncertain})).status).toBe('refused');expect(uncertain).toHaveBeenCalledTimes(1);
  const stored=await service.from('email_history').select('status,subject,body').eq('id',uncertainId).single();expect(stored.error).toBeNull();expect(stored.data).toEqual({status:'unknown',subject,body});
 }finally{await destroySyntheticWorld(world.runId);}
},120000);
