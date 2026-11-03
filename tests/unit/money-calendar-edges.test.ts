import { describe, expect, it } from 'vitest';
import { documentTotals, toPence } from '@/lib/money';
import { balanceDue, daysPastDue, owed } from '@/lib/receivables';

describe('money and calendar edges', () => {
  it.each([[0.01, 1], [0.29, 29], [-0.29, -29], [0, 0], [0.145, 15], [-0.145, -15]])('keeps %s in whole pennies', (amount, pennies) => {
    expect(toPence(amount)).toBe(pennies);
  });
  it.each([[0.03, 0.01, 0.04], [0.07, 0.01, 0.08], [0.13, 0.03, 0.16], [0, 0, 0]])('20 percent VAT on %s', (net, vat, total) => {
    expect(documentTotals([{quantity: 1, unitPrice: net, vatPct: 20}])).toMatchObject({subtotal: net, vat, total});
  });
  it.each([['2026-01-31', '2026-02-01', 1], ['2024-02-28', '2024-03-01', 2], ['2026-03-28', '2026-03-30', 2], ['2026-10-24', '2026-10-26', 2], ['2026-12-31', '2027-01-01', 1], ['2026-04-01', '2026-03-31', -1]] as const)('calendar days from %s to %s', (due, today, days) => {
    expect(daysPastDue(due, today)).toBe(days);
  });
  it('never collects a negative or zero face value', () => {
    for (const total of [-1, 0]) expect(owed({status: 'issued', total, amount_paid: 0})).toBe(0);
  });
  it('settles odd pennies exactly and keeps refunded money outstanding', () => {
    expect(balanceDue(0.29, 0.2, 0.09)).toBe(0);
    expect(balanceDue(0.29, 0.29, 0, 0.01)).toBe(0.01);
  });
});
