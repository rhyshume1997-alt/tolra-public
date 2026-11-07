import {beforeEach,expect,it,vi} from 'vitest';
import {strFromU8,unzipSync} from 'fflate';
import {JNR_PROFILE} from '@/lib/company';
const state=vi.hoisted(()=>({rows:[] as Record<string,unknown>[]}));
vi.mock('@/lib/supabase',()=>({supabase:{from:(table:string)=>{const q={select:()=>q,eq:()=>q,order:()=>q,range:async(from:number,to:number)=>({data:table==='invoices'?state.rows.slice(from,to+1):[],error:null}),then:(done:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(done)};return q;}}}));
vi.mock('@/lib/audit',()=>({auditEvent:vi.fn(async()=>undefined)}));
import {buildYearEndZip,invoicePaidFigures} from '@/lib/year-end-export';
beforeEach(()=>{state.rows=[];});
it.each(['subtotal','vat','total'])('an invoice with missing %s is unresolved, never exported as a zero-value invoice',async field=>{
 state.rows=[{id:'synthetic',invoice_ref:'SYN-MISSING',customer:'Synthetic',status:'sent',invoice_date:'2026-11-05',subtotal:100,vat:20,total:120,amount_paid:0,[field]:null}];
 const result=await buildYearEndZip('2026-11-01','2026-11-30',{...JNR_PROFILE,name:'Synthetic company'});
 expect(result.summary[0]).toMatchObject({net:null,vat:null,gross:null,paid:null,balance:null,status:'UNRESOLVED',pdf:''});
 expect(result.unresolved).toBe(1);expect(result.problems.join(' ')).toMatch(/missing.*stored/i);
 expect(strFromU8(unzipSync(result.zip)['README.txt'])).toContain('1 UNRESOLVED RECORD');
});
it('a missing invoice total gives no guessed zero balance',()=>{
 expect(invoicePaidFigures({invoice_ref:'SYN-MISSING',status:'sent',amount_paid:0,total:null})).toMatchObject({paid:0,balance:null});
});
it('explicit zero totals remain known zero, not missing',async()=>{
 state.rows=[{id:'synthetic-zero',invoice_ref:'SYN-ZERO',customer:'Synthetic',status:'sent',invoice_date:'2026-11-05',subtotal:0,vat:0,total:0,amount_paid:0}];
 const result=await buildYearEndZip('2026-11-01','2026-11-30',{...JNR_PROFILE,name:'Synthetic company'});
 expect(result.summary[0]).toMatchObject({net:0,vat:0,gross:0,paid:0,balance:0,status:'sent'});expect(result.unresolved).toBe(0);
});
