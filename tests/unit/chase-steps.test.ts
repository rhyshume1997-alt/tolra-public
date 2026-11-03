import { describe, expect, it } from 'vitest';
import { dueSteps, renderChase, type Step } from '../../lib/chase/steps';
const steps: Step[] = [
  { id: 'pre', offsetDays: -3, tone: 'before_due' },
  { id: 'friendly', offsetDays: 1, tone: 'friendly' },
  { id: 'firm', offsetDays: 7, tone: 'firm' },
  { id: 'final', offsetDays: 14, tone: 'final' },
];
const invoice = { id: 'x', dueDate: '2026-11-10', balancePence: 123450, paused: false, alreadySentStepIds: [] as string[] };
describe('dueSteps', () => {
  it('sends no future steps', () => expect(dueSteps(steps, invoice, '2026-11-06')).toEqual([]));
  it('sends reminder before due', () => expect(dueSteps(steps, invoice, '2026-11-07')[0].id).toBe('pre'));
  it('chooses only the most advanced overdue step', () => expect(dueSteps(steps, invoice, '2026-11-30').map(x => x.id)).toEqual(['final']));
  it('chooses the most advanced unsent step after an earlier step was sent', () => expect(dueSteps(steps, { ...invoice, alreadySentStepIds: ['friendly'] }, '2026-11-18')[0].id).toBe('firm'));
  it('never sends an earlier step after the final step was sent', () => expect(dueSteps(steps, { ...invoice, alreadySentStepIds: ['final'] }, '2026-11-30')).toEqual([]));
  it.each(['2026-11-01', '2026-12-01'])('never sends 7 or 14 day reminders after a 30 day reminder on %s', today => {
    const custom: Step[] = [14, 30, 7].map(n => ({ id: 's' + n, offsetDays: n, tone: 'firm' }));
    expect(dueSteps(custom, { ...invoice, dueDate: '2026-10-01', alreadySentStepIds: ['s30'] }, today)).toEqual([]);
  });
  it('does not repeat sent steps', () => expect(dueSteps(steps, { ...invoice, alreadySentStepIds: ['pre'] }, '2026-11-07')).toEqual([]));
  it('returns none when paused', () => expect(dueSteps(steps, { ...invoice, paused: true }, '2026-11-30')).toEqual([]));
  it('returns none when settled', () => expect(dueSteps(steps, { ...invoice, balancePence: 0 }, '2026-11-30')).toEqual([]));
  it('rejects invalid dates', () => expect(dueSteps(steps, { ...invoice, dueDate: '2026-02-30' }, '2026-11-30')).toEqual([]));
  it('handles year boundaries', () => expect(dueSteps([{ id: 'x', offsetDays: 2, tone: 'firm' }], { ...invoice, dueDate: '2026-12-31' }, '2027-01-02')).toHaveLength(1));
});
const fields = { customerName: 'Sarah', invoiceRef: 'INV-012', balancePence: 123450, dueDate: '2026-11-01', daysOverdue: 8, companyName: 'JNR Engineering' };
describe('renderChase', () => {
  it.each(['before_due', 'friendly', 'firm', 'final'] as const)('renders %s', tone => {
    const result = renderChase(tone, fields);
    expect(result.subject).toContain('INV-012');
    expect(result.body).toContain('£1,234.50');
    expect(result.body).toContain('Sarah');
    expect(result.body).toContain('JNR Engineering');
  });
  it('renders job and supplier context', () => {
    expect(renderChase('friendly', { ...fields, jobRef: 'J-23', jobStatus: 'Running', partsWaiting: ['steel'], supplierExpectedDate: '2026-11-19' }).body).toContain('Supplier expected date: 2026-11-19');
  });
  it('renders pennies exactly', () => expect(renderChase('friendly', { ...fields, balancePence: 1 }).body).toContain('£0.01'));
});
