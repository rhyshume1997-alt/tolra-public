import { describe, expect, it } from 'vitest';
import { renderChase } from '../../lib/chase/steps';
const fields={customerName:'Lee',invoiceRef:'INV-55',balancePence:103050,dueDate:'2026-10-01',daysOverdue:7,companyName:'JNR'};
describe('chase wording',()=>{
 it.each(['before_due','friendly','firm','final'] as const)('%s stays polite and includes invoice and signature',tone=>{
  const {body}=renderChase(tone,fields);expect(body).toContain('INV-55');expect(body).toContain('£1,030.50');expect(body).toContain('Kind regards,\nJNR');expect(body).not.toMatch(/debt collector|court action|legal proceedings/i);
 });
 it.each([7,14,30])('renders day %i correctly',days=>expect(renderChase('firm',{...fields,daysOverdue:days}).body).toContain(days+' days overdue'));
 it('renders singular one day',()=>expect(renderChase('firm',{...fields,daysOverdue:1}).body).toContain('1 day overdue'));
});