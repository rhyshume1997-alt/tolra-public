import { expect,it } from 'vitest';
import { parseStatementCsv,matchStatementLines } from '@/lib/bank/match-statement';
const invoice={id:'invoice',ref:'INV-123',customer:'Test Shop',balancePence:123456,dueDate:'2026-11-01'};
it('a quoted UK-bank amount, named date and combined reference reach the matcher correctly',()=>{
 const parsed=parseStatementCsv('Date,Type,Description,Reference,Money In,Money Out\n2 November 2026,BACS,Test Shop,INV-123,"£1,234.56",\n');
 expect(parsed.errors).toEqual([]);expect(parsed.lines[0].amountPence).toBe(123456);
 expect(matchStatementLines(parsed.lines,[invoice])[0]).toMatchObject({invoice,confidence:'high'});
});
it('unclosed quotes still reject a whole recognised six-bank-format statement',()=>{
 const parsed=parseStatementCsv('Date,Details,Credit Amount,Debit Amount\n02/11/2026,INV-123,1234.56,\n03/11/2026,"unfinished,20.00,');
 expect(parsed.lines).toEqual([]);expect(parsed.errors).toHaveLength(1);
});
it('parsing and matching together never use a short reference prefix as a customer fallback',()=>{
 const parsed=parseStatementCsv('Date,Description,Amount (GBP)\n02/11/2026,Test Shop INV-1234,1234.56');
 expect(parsed.errors).toEqual([]);expect(matchStatementLines(parsed.lines,[invoice])[0].invoice).toBeNull();
});
it('repeated parsed rows cannot reserve the same invoice twice',()=>{
 const parsed=parseStatementCsv('Date,Description,Amount\n02/11/2026,INV-123,1234.56\n02/11/2026,INV-123,1234.56');
 expect(parsed.errors).toEqual([]);expect(matchStatementLines(parsed.lines,[invoice]).filter(m=>m.invoice)).toHaveLength(1);
});
