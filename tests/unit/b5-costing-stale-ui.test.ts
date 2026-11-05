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
