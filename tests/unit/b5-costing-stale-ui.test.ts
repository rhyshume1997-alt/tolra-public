// @vitest-environment jsdom
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/use-user',()=>({useUser:()=>({activeRole:'admin'})}));
vi.mock('@/lib/supabase',()=>({supabase:null}));
import {PriceThisPart} from '@/components/costing/price-this-part';
import {CONFIGURED} from './costing-fixtures';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it.each(['material','machine'] as const)('changing rates must not silently replace a selected %s',async kind=>{
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host),onAdd=vi.fn();
 const draw=async(rates:typeof CONFIGURED)=>{await act(async()=>root.render(createElement(PriceThisPart,{rates,onAdd})));};
 const input=async(label:string,value:string,select=false)=>{
  const element=host.querySelector(`[aria-label="${label}"]`)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(select?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event(select?'change':'input',{bubbles:true}));});
 };
 const add=()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Add as quote line')!;
 try{
  await draw(CONFIGURED);await input('Part description','Synthetic bush');await input('Material weight kg per part','0.5');await input('Cycle hours per part','0.2');
  await input(kind==='material'?'Part material':'Part machine',kind==='material'?CONFIGURED.materials[0].id:CONFIGURED.machines[0].id,true);
  expect(add().disabled).toBe(false);
  const changed=structuredClone(CONFIGURED);const nextId='99999999-9999-4999-8999-999999999999';
  if(kind==='material')changed.materials[0].id=nextId;else changed.machines[0].id=nextId;
  await draw(changed);expect(add().disabled).toBe(true);expect(host.textContent).toContain('still in the current rate list');expect(onAdd).not.toHaveBeenCalled();
  await input(kind==='material'?'Part material':'Part machine',nextId,true);expect(add().disabled).toBe(false);
 }finally{await act(async()=>root.unmount());host.remove();}
});
it('quote preview agrees with the rounded unit price actually copied, preserving the separate engine estimate',async()=>{
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host),onAdd=vi.fn();
 const rates=structuredClone(CONFIGURED);rates.materials[0].price=0.01;rates.materials[0].scrapPct=0;rates.machines[0].hourlyRate=0;
 rates.defaults={labourPerHour:0,programmingPerHour:0,overheadPct:100,marginPct:0};
 const input=async(label:string,value:string)=>{const element=host.querySelector(`[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});};
 try{
  await act(async()=>root.render(createElement(PriceThisPart,{rates,onAdd})));
  await input('Part description','Synthetic fractional material');await input('Part quantity','3');await input('Material weight kg per part','0.5');await input('Cycle hours per part','1');
  const add=[...host.querySelectorAll('button')].find(b=>b.textContent==='Add as quote line')!;
  await act(async()=>add.click());expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({qty:3,unit:0.01}));
  expect(host.textContent).toContain('Total quote: £0.03');
  expect(host.textContent).toContain('costing batch estimate is £0.01');
 }finally{await act(async()=>root.unmount());host.remove();}
});
it('refuses negative optional hours instead of silently pricing them as zero',async()=>{
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host),onAdd=vi.fn();
 const input=async(label:string,value:string)=>{const element=host.querySelector(`[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});};
 try{
  await act(async()=>root.render(createElement(PriceThisPart,{rates:CONFIGURED,onAdd})));
  await input('Part description','Synthetic');await input('Material weight kg per part','0.5');await input('Cycle hours per part','0.2');
  const add=[...host.querySelectorAll('button')].find(b=>b.textContent==='Add as quote line')!;expect(add.disabled).toBe(false);
  await input('Setup hours for batch','-1');expect(add.disabled).toBe(true);expect(host.textContent).toContain('setup time of zero or more');
  await input('Setup hours for batch','');await input('Programming hours for batch','-1');expect(add.disabled).toBe(true);expect(host.textContent).toContain('programming time of zero or more');expect(onAdd).not.toHaveBeenCalled();
 }finally{await act(async()=>root.unmount());host.remove();}
});
