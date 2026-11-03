// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BankCheck } from '@/components/bank/bank-check';
let host:HTMLDivElement,root:Root;
const invoices=[{id:'i',ref:'INV-12',customer:'Shop',balancePence:10000,dueDate:'2026-11-01'}];
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('TextEncoder',TextEncoder);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function upload(onMarkPaid=vi.fn(),csv='Date,Details,Amount\n02/11/2026,INV-12,100.00'){
 act(()=>root.render(createElement(BankCheck,{invoices,onMarkPaid,onSkip:()=>{}})));
 const input=host.querySelector('input')!;
 Object.defineProperty(input,'files',{configurable:true,value:[{text:async()=>csv}]});
 await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});return onMarkPaid;
}
const confirm=()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Confirm payment received')!;
describe('manual bank confirmation',()=>{
 it('keeps the row visible and blocks duplicate actions until save succeeds',async()=>{
  let finish!:()=>void;const save=vi.fn(()=>new Promise<void>(r=>{finish=r;}));await upload(save);
  await act(async()=>{confirm().click();});await vi.waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(host.textContent).toContain('INV-12');expect(confirm().disabled).toBe(true);
  await act(async()=>confirm().click());expect(save).toHaveBeenCalledTimes(1);
  await act(async()=>finish());expect(confirm()).toBeUndefined();
 });
 it('keeps a failed row and retries with the same idempotency key',async()=>{
  const save=vi.fn().mockRejectedValueOnce(new Error('uncertain')).mockResolvedValueOnce(undefined);await upload(save);
  await act(async()=>{confirm().click();});await vi.waitFor(()=>expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(confirm().disabled).toBe(false);const id=save.mock.calls[0][2];
  await act(async()=>{confirm().click();});await vi.waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][2]).toBe(id);
 });
 it('blocks confirming valid rows while any CSV rows are invalid',async()=>{
  const save=await upload(vi.fn(),'Date,Details,Amount\n02/11/2026,INV-12,100.00\nwrong,broken,1.00');
  expect(confirm().disabled).toBe(true);expect(host.textContent).toContain('Correct the file');expect(save).not.toHaveBeenCalled();
 });
});
