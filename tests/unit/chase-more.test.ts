import { describe, expect, it } from 'vitest';
import { dueSteps, renderChase, type Step } from '../../lib/chase/steps';
const step=(id:string,n:number):Step=>({id,offsetDays:n,tone:'firm'});
const invoice={id:'i',dueDate:'2026-10-01',balancePence:12345,paused:false,alreadySentStepIds:[] as string[]};
describe('additional chase calendar and state cases',()=>{
 const cases:[string,string,number,number][]=[
 ['month end','2026-10-31',30,1],['month boundary','2026-11-01',30,1],
 ['not due','2026-09-30',0,0],['due day','2026-10-01',0,1],
 ['one day','2026-10-02',1,1],['two days early','2026-09-29',-2,1],
 ['before early','2026-09-28',-2,0],['later date','2026-12-01',60,1],
 ['far future','2026-12-01',90,0],['due 7','2026-10-08',7,1],
 ['due 14','2026-10-15',14,1],['due 30','2026-10-31',30,1],
 ['not due 30','2026-10-30',30,0],['due 31','2026-11-01',31,1],
 ['long offset','2027-01-01',1000,0]
 ];
 it.each(cases)('%s',(_,today,offset,count)=>expect(dueSteps([step('x',offset)],invoice,today)).toHaveLength(count));
 it('stays empty when paid',()=>expect(dueSteps([step('x',0)],{...invoice,balancePence:0},'2026-11-01')).toEqual([]));
 it('stays empty when paused',()=>expect(dueSteps([step('x',0)],{...invoice,paused:true},'2026-11-01')).toEqual([]));
 it('ignores earlier step after later sent',()=>expect(dueSteps([step('a',7),step('b',30)],{...invoice,alreadySentStepIds:['b']},'2026-11-01')).toEqual([]));
 it('accepts unsorted steps',()=>expect(dueSteps([step('a',30),step('b',7),step('c',14)],invoice,'2026-11-01')[0].id).toBe('a'));
 it('does not backtrack with duplicate offsets already sent',()=>expect(dueSteps([step('a',7),step('b',7)],{...invoice,alreadySentStepIds:['a']},'2026-11-01')).toEqual([]));
 it('handles leap day',()=>expect(dueSteps([step('x',1)],{...invoice,dueDate:'2028-02-28'},'2028-02-29')).toHaveLength(1));
 it('rejects non leap day',()=>expect(dueSteps([step('x',1)],{...invoice,dueDate:'2027-02-29'},'2027-03-01')).toEqual([]));
 it('rejects date typo',()=>expect(dueSteps([step('x',1)],invoice,'2026-13-01')).toEqual([]));
 it('prints job reference',()=>expect(renderChase('firm',{customerName:'Chris',invoiceRef:'INV-9',balancePence:12345,dueDate:'2026-10-01',daysOverdue:1,companyName:'JNR',jobRef:'J-3'}).body).toContain('Job reference: J-3'));
 it('prints waiting parts and supplier date',()=>expect(renderChase('firm',{customerName:'Chris',invoiceRef:'INV-9',balancePence:12345,dueDate:'2026-10-01',daysOverdue:1,companyName:'JNR',partsWaiting:['seal','bolt'],supplierExpectedDate:'2026-11-05'}).body).toContain('Parts waiting: seal, bolt'));
 it('renders thousands accurately',()=>expect(renderChase('final',{customerName:'Chris',invoiceRef:'INV-9',balancePence:123456789,dueDate:'2026-10-01',daysOverdue:30,companyName:'JNR'}).body).toContain('£1,234,567.89'));
});