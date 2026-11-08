// @vitest-environment jsdom
// DEV-001 (release 147 hold): staff alert contracts, written first by Codex (draft PR #390); runs against the real form.
import { act,createElement } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { friendlyError } from '@/lib/friendly-error';
const mock=vi.hoisted(()=>({success:vi.fn(),created:vi.fn(),rpc:vi.fn(),audit:vi.fn()}));
vi.mock('sonner',()=>({toast:{success:mock.success}}));
vi.mock('@/lib/audit',()=>({auditEvent:mock.audit}));
vi.mock('@/lib/supabase',()=>({supabase:{rpc:mock.rpc,from:()=>({select:()=>({order:()=>({limit:()=>Promise.resolve({data:[{id:'44444444-4444-4444-8444-444444444444',name:'Synthetic Goods'}],error:null})})})})}}));
import { JobDeliveryNoteForm } from '@/components/job-delivery-note-form';
const DLN='Delivery notes are paused while the next number is checked. Ask the office for help. Your note has not been saved.';
const HELD='Work for this company is paused. Ask your supervisor or the office before trying again. Your changes have not been saved.';
const fallback="Couldn't create the delivery note. Nothing was saved.";
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.spyOn(console,'error').mockImplementation(()=>{});mock.rpc.mockReset();mock.success.mockClear();mock.created.mockClear();mock.audit.mockClear();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();});
it('DEV-001-01 real 147 hold hint gives plain staff wording, not Nothing was saved',()=>{
 expect(friendlyError({code:'55000',hint:'dln_numbering_not_set',message:'Synthetic server hold'},fallback)).toBe(DLN);
});
it('DEV-001-02 explicit whole-company hold gives a distinct safe instruction',()=>{
 // Proposed typed signal: Code must implement/verify its authenticated server source; do not infer a hold from any permission error.
 expect(friendlyError({code:'42501',hint:'company_on_hold',message:'permission denied for relation synthetic_private'},fallback)).toBe(HELD);
});
it('DEV-001-03 a known hold must not expose raw database or another company’s text',()=>{
 const message=friendlyError({code:'55000',hint:'dln_numbering_not_set',message:'relation synthetic_other_company contains synthetic-user@example.test'},fallback);
 expect(message).toBe(DLN);expect(message).not.toContain('synthetic_other_company');
});
it('DEV-001-04 unknown errors do not falsely claim the company is held',()=>{
 expect(friendlyError({code:'55000',hint:'unknown_synthetic'},fallback)).toBe(fallback);
 expect(friendlyError({code:'42501',message:'permission denied for relation synthetic_private'})).toBe("You don't have permission to do that.");
});
async function refusedForm(){
 mock.rpc.mockResolvedValue({data:null,error:{code:'55000',hint:'dln_numbering_not_set',message:'Synthetic server hold'}});
 await act(async()=>root.render(createElement(JobDeliveryNoteForm,{job:{id:'55555555-5555-4555-8555-555555555555',job_no:'J-SYN',customer:'Synthetic Goods'},onCreated:mock.created})));
 for(const [label,value] of [['Description 1','Synthetic bracket'],['Quantity 1','1']]){
  const input=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 }
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save Delivery Note')!.click());
}
it('DEV-001-05 held save displays an accessible staff alert with the requested instruction',async()=>{
 await refusedForm();expect(mock.rpc).toHaveBeenCalledTimes(1);expect(host.querySelector('[role="alert"]')?.textContent).toBe(DLN);
});
it('DEV-001-06 refusal preserves entered work and never reports success',async()=>{
 await refusedForm();expect((host.querySelector('[aria-label="Description 1"]') as HTMLInputElement).value).toBe('Synthetic bracket');expect(mock.success).not.toHaveBeenCalled();expect(mock.created).not.toHaveBeenCalled();expect(mock.audit).not.toHaveBeenCalled();
});
