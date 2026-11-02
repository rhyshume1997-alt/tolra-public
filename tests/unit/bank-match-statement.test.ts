import { describe, it, expect } from 'vitest';
import { parseStatementCsv, matchStatementLines } from '../../lib/bank/match-statement';

describe('parseStatementCsv', () => {
  it('parses UK dates, quotes and pence', () => {
    expect(parseStatementCsv('Date,Description,Amount\n02/11/2026,"ACME, INV-001",£1,234.50').lines).toHaveLength(0);
    expect(parseStatementCsv('Date,Description,Amount\n02/11/2026,"ACME, INV-001","£1,234.50"').lines[0]).toEqual({ date: '2026-11-02', description: 'ACME, INV-001', amountPence: 123450 });
  });
  it('handles separate credits and debits', () => {
    expect(parseStatementCsv('Date,Details,Paid In,Paid Out\n2026-11-02,BACS,100.00,\n2026-11-03,RENT,,25.50').lines.map(x => x.amountPence)).toEqual([10000, -2550]);
  });
  it('preserves integer pence', () => expect(parseStatementCsv('Date,Narrative,Amount\n01/11/2026,PAYMENT,0.29').lines[0].amountPence).toBe(29));
  it('handles negative amounts', () => expect(parseStatementCsv('Date,Reference,Amount\n01/11/2026,DEBIT,-12.00').lines[0].amountPence).toBe(-1200));
  it('accepts ISO dates', () => expect(parseStatementCsv('Date,Details,Amount\n2026-11-02,PAYMENT,10.00').lines).toHaveLength(1));
  it('reports invalid dates', () => expect(parseStatementCsv('Date,Details,Amount\n31/02/2026,PAYMENT,10.00').errors).toHaveLength(1));
  it('reports missing header', () => expect(parseStatementCsv('hello,world').errors).toHaveLength(1));
  it('is safe for empty input', () => expect(parseStatementCsv('').lines).toEqual([]));
  it('supports a BOM and a preamble', () => expect(parseStatementCsv('\uFEFFStatement Export\nDate,Details,Amount\n02/11/2026,ACME,1.00').lines).toHaveLength(1));
});
describe('matchStatementLines', () => {
  const invoices = [
    { id: 'a', ref: 'INV-001', customer: 'Acme Ltd', balancePence: 123450, dueDate: '2026-11-01' },
    { id: 'b', ref: 'INV-002', customer: 'Other Ltd', balancePence: 10000, dueDate: '2026-11-01' },
  ];
  it('matches exact amount with reference', () => expect(matchStatementLines([{ date: '2026-11-02', description: 'BACS INV 001', amountPence: 123450 }], invoices)[0].invoice?.id).toBe('a'));
  it('matches exact amount with customer', () => expect(matchStatementLines([{ date: '2026-11-02', description: 'Acme Ltd', amountPence: 123450 }], invoices)[0].confidence).toBe('medium'));
  it('does not match a debit', () => expect(matchStatementLines([{ date: '2026-11-02', description: 'INV-001', amountPence: -123450 }], invoices)[0].invoice).toBeNull());
  it('does not double allocate', () => {
    const result = matchStatementLines(Array(2).fill({ date: '2026-11-02', description: 'INV-001', amountPence: 123450 }), invoices);
    expect(result.filter(x => x.invoice)).toHaveLength(1);
  });
});
