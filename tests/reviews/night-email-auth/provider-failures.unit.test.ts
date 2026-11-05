import {afterEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {microsoftProvider} from '@/lib/email/providers/microsoft';
import {resendProvider} from '@/lib/email/providers/resend';
import type {OutgoingEmail} from '@/lib/email/providers/types';
const email:OutgoingEmail={to:['bound@example.test'],cc:[],subject:'Approved invoice reminder',text:'Hello John\r\n\r\nPlease check INV-SYNTHETIC\n',attachments:[],idempotencyKey:'night-email-synthetic-001'};
afterEach(()=>vi.restoreAllMocks());
it.each([400,401,403,404,408,409,429,500,502,503])('Microsoft HTTP %s is classified without a second send or credential disclosure',async status=>{
 const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response('SYNTHETIC_SECRET_BODY',{status}));
 const result=await microsoftProvider('SYNTHETIC_SECRET_TOKEN',transport).send(email);
 expect(result.outcome).toBe(status>=500||status===408||status===409?'unknown':'failed');
 expect(transport).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
 if(status===429)expect(result.rateLimited).toBe(true);
});
it('Microsoft aborts timed-out transport and returns unknown, never an automatic retry',async()=>{
 const transport=vi.fn<typeof fetch>().mockImplementation((_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
 const result=await microsoftProvider('synthetic-token',transport,5).send(email);
 expect(result.outcome).toBe('unknown');expect(transport).toHaveBeenCalledTimes(1);
});
it.each([400,401,403,408,409,422,429,500,502,503])('Resend HTTP %s is classified without a second send or response-body disclosure',async status=>{
 const send=vi.fn().mockResolvedValue({data:null,error:{name:'synthetic_provider_error',message:'SYNTHETIC_SECRET_BODY',statusCode:status}});
 const result=await resendProvider('synthetic-key','office@example.test',{emails:{send}}).send(email);
 expect(result.outcome).toBe(status>=500||status===408||status===409?'unknown':'failed');
 expect(send).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
 expect(send.mock.calls[0][0]).toMatchObject({to:email.to,text:email.text});
 expect(send.mock.calls[0][1]).toEqual({idempotencyKey:email.idempotencyKey});
});
it('Resend network exception remains unknown rather than permission to resend',async()=>{
 const send=vi.fn().mockRejectedValue(new Error('synthetic offline'));
 expect((await resendProvider('synthetic','office@example.test',{emails:{send}}).send(email)).outcome).toBe('unknown');expect(send).toHaveBeenCalledTimes(1);
});
