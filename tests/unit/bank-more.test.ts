import { describe, expect, it } from 'vitest';
import { matchStatementLines, parseStatementCsv, type Invoice } from '../../lib/bank/match-statement';
const inv=(id:string,ref:string,customer:string,amount:number):Invoice=>({id,ref,customer,balancePence:amount,dueDate:'2026-10-31'});
const line=(description:string,amountPence:number,date='2026-11-02')=>({description,amountPence,date});
describe('bank matching safety regression',()=>{
 const scenarios:[string,string,number,string,string,number,string|null][]=[
 ['ref exact','INV-123',10000,'INV-123','ACME',10000,'a'],
 ['ref spaced','INV 123',10000,'INV-123','ACME',10000,'a'],
 ['case insensitive','inv123',10000,'INV-123','ACME',10000,'a'],
 ['ref typo','INV-124',10000,'INV-123','ACME',10000,null],
 ['wrong amount','INV-123',9000,'INV-123','ACME',10000,null],
 ['part payment','INV-123',4000,'INV-123','ACME',10000,null],
 ['overpayment','INV-123',11000,'INV-123','ACME',10000,null],
 ['refund','INV-123',-10000,'INV-123','ACME',10000,null],
 ['zero','INV-123',0,'INV-123','ACME',10000,null],
 ['customer match','ACME',10000,'INV-123','ACME',10000,'a'],
 ['customer short','ABC',10000,'INV-123','ABC',10000,null],
 ['missing reference','TRANSFER',10000,'INV-123','ACME',10000,null],
 ['credit note label','CREDIT NOTE',10000,'INV-123','ACME',10000,null],
 ['different person','OTHER',10000,'INV-123','ACME',10000,null],
 ['reference punctuation','INV/123',10000,'INV-123','ACME',10000,'a'],
 ];
 it.each(scenarios)('%s',(_,desc,amount,ref,customer,balance,want)=>{
  expect(matchStatementLines([line(desc,amount)],[inv('a',ref,customer,balance)])[0].invoice?.id??null).toBe(want);
 });
 it('same amount and two customers remains ambiguous',()=>expect(matchStatementLines([line('PAYMENT',10000)],[inv('a','INV1','ACME',10000),inv('b','INV2','OTHER',10000)])[0].invoice).toBeNull());
 it('same amount and reference selects uniquely',()=>expect(matchStatementLines([line('INV2',10000)],[inv('a','INV1','ACME',10000),inv('b','INV2','OTHER',10000)])[0].invoice?.id).toBe('b'));
 it('second duplicate transaction is not allocated twice',()=>expect(matchStatementLines([line('INV1',10000),line('INV1',10000)],[inv('a','INV1','ACME',10000)]).filter(x=>x.invoice)).toHaveLength(1));
 it('ignores zero balance invoice',()=>expect(matchStatementLines([line('INV1',10000)],[inv('a','INV1','ACME',0)])[0].invoice).toBeNull());
 it('works on month end',()=>expect(matchStatementLines([line('INV1',10000,'2026-10-31')],[inv('a','INV1','ACME',10000)])[0].invoice?.id).toBe('a'));
 it('works on following month day',()=>expect(matchStatementLines([line('INV1',10000,'2026-11-01')],[inv('a','INV1','ACME',10000)])[0].invoice?.id).toBe('a'));
 it('works on year boundary',()=>expect(matchStatementLines([line('INV1',10000,'2027-01-01')],[inv('a','INV1','ACME',10000)])[0].invoice?.id).toBe('a'));
 it('parses one penny precisely',()=>expect(parseStatementCsv('Date,Details,Amount\n01/11/2026,INV1,0.01').lines[0].amountPence).toBe(1));
 it('rejects more than 2 decimals',()=>expect(parseStatementCsv('Date,Details,Amount\n01/11/2026,INV1,0.001').errors).toHaveLength(1));
 it('reads quoted thousands',()=>expect(parseStatementCsv('Date,Details,Amount\n01/11/2026,INV1,"1,000.01"').lines[0].amountPence).toBe(100001));
 it('does not silently round fractional pence',()=>expect(parseStatementCsv('Date,Details,Amount\n01/11/2026,INV1,10.999').errors).toHaveLength(1));
});