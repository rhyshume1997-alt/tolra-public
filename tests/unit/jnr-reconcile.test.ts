import {expect,it} from 'vitest';
import {halfEven,pence,reconcile} from '../../scripts/jnr-reconcile/check.mjs';
function fixture(){
 const snapshot={customers:[{company:'JNR',sourceRef:'c1'}],invoices:[{company:'JNR',sourceRef:'i1',customerRef:'c1',totalPence:'9007199254740993123',paidPence:'123',creditPence:'100',refundPence:'1'}],payments:[{company:'JNR',sourceRef:'p1',invoiceRef:'i1',amountPence:'123'}],jobs:[{company:'JNR',sourceRef:'j1',customerRef:'c1'}],numbering:{invoices:'99',jobs:'10'}};
 const preservation={marpet:{customers:[{company:'MARPET',id:'m1',name:'private'}],invoices:[]},logins:[{id:'a'}],settings:{a:1},numbering:{next:'100'},audit:[{id:'event1'}]};
 return {company:'JNR',protectedCompany:'MARPET',expected:structuredClone(snapshot),actual:structuredClone(snapshot),protectedInventory:['customers','invoices'],preservationBefore:structuredClone(preservation),preservationAfter:structuredClone(preservation)};
}
it('matches exact huge pence, part payments, credits, refunds and preserved company without mutation',()=>{const f=fixture(),before=JSON.stringify(f);expect(reconcile(f)).toMatchObject({status:'PASS',marpetUnchanged:true,exactPence:true});expect(JSON.stringify(f)).toBe(before);expect(JSON.stringify(reconcile(f))).not.toContain('private');});
it.each([['5','2','2'],['7','2','4'],['-5','2','-2'],['-7','2','-4'],['0','2','0'],['9007199254740993125','2','4503599627370496562']])('rounds %s/%s half to even', (n,d,v)=>expect(halfEven(n,d)).toBe(v));
it.each([0,1.5,'1.5','NaN','1e6','',null,undefined])('refuses inexact or missing pence %s',v=>expect(()=>pence(v)).toThrow());
it('refuses invalid divisor',()=>expect(()=>halfEven('1','0')).toThrow());
it.each(['customers','invoices','payments','jobs','numbering'])('detects changed %s',area=>{const f=fixture();const actual=f.actual as unknown as Record<string,unknown>;actual[area]=area==='numbering'?{invoices:'100',jobs:'10'}:[];expect(reconcile(f).status).toBe('FAIL');});
it.each(['marpet','logins','settings','numbering','audit'])('detects protected %s change',category=>{const f=fixture();(f.preservationAfter as unknown as Record<string,unknown>)[category]={changed:true};expect(reconcile(f).status).toBe('FAIL');});
it('never matches customers by name',()=>{const f=fixture();f.actual.customers[0].sourceRef='different';expect(reconcile(f).status).toBe('FAIL');});
it('refuses duplicate reference',()=>{const f=fixture();f.actual.customers.push({...f.actual.customers[0]});expect(reconcile(f).status).toBe('FAIL');});
it('refuses cross-company row',()=>{const f=fixture();f.actual.invoices[0].company='MARPET';expect(reconcile(f).status).toBe('FAIL');});
it('refuses omitted inventory',()=>{const f=fixture();f.protectedInventory=[];expect(reconcile(f).status).toBe('FAIL');});
it('refuses partial Marpet inventory',()=>{const f=fixture();f.protectedInventory.push('jobs');expect(reconcile(f).status).toBe('FAIL');});
it('refuses missing protected category',()=>{const f=fixture();delete (f.preservationBefore as Partial<typeof f.preservationBefore>).audit;expect(reconcile(f).status).toBe('FAIL');});
it('detects mismatched allocation, even when both snapshots share it',()=>{const f=fixture();f.expected.payments[0].amountPence='124';f.actual.payments[0].amountPence='124';expect(reconcile(f).status).toBe('FAIL');});
it('compares zero balances without rounding them',()=>{const f=fixture();for(const s of [f.expected,f.actual]){s.invoices[0].totalPence='222';}expect(reconcile(f).status).toBe('PASS');});
it('refuses over-allocation rather than hiding a negative balance',()=>{const f=fixture();f.actual.invoices[0].totalPence='0';expect(reconcile(f).status).toBe('FAIL');});
