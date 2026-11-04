import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { bankPaymentRequestId, recordConfirmedBankPayment } from "@/lib/bank/confirmation";
import { matchStatementLines, type Invoice } from "@/lib/bank/match-statement";
const invoice:Invoice={id:'11111111-1111-4111-8111-111111111111',ref:'INV-12',customer:'Test Shop',balancePence:10000,dueDate:'2026-11-01'};
const line={date:'2026-11-02',description:'Test Shop INV-123',amountPence:10000};
describe('bank confirmation safeguards',()=>{
 it('never treats the prefix of another reference as a unique match, even with a name',()=>expect(matchStatementLines([line],[invoice])[0].invoice).toBeNull());
 it('does not fall back to customer when an explicit reference has the wrong amount',()=>{
  const other={...invoice,id:'other',ref:'INV-123',balancePence:9000};expect(matchStatementLines([line],[invoice,other])[0].invoice).toBeNull();
 });
 it('does not choose a customer from a statement mentioning two invoice references',()=>{
  expect(matchStatementLines([{...line,description:'Test Shop INV-12 and INV-123'}],[invoice,{...invoice,id:'other',ref:'INV-123',customer:'Other'}])[0].invoice).toBeNull();
 });
 it.each([Infinity,1.5,NaN])('refuses unsafe integer pence %s',amountPence=>expect(matchStatementLines([{...line,amountPence}],[{...invoice,balancePence:amountPence}])[0].invoice).toBeNull());
 it('reuses the request ID for identical input and distinguishes invoices and rows',async()=>{
  vi.stubGlobal('crypto',webcrypto);
  try{const id=await bankPaymentRequestId('CSV',0,invoice.id);expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);expect(await bankPaymentRequestId('CSV',0,invoice.id)).toBe(id);expect(await bankPaymentRequestId('CSV',1,invoice.id)).not.toBe(id);expect(await bankPaymentRequestId('CSV',0,'other')).not.toBe(id);}finally{vi.unstubAllGlobals();}
 });
 it('passes the stable ID to the existing idempotent payment RPC only after confirmation',async()=>{
  const db={rpc:vi.fn().mockResolvedValue({data:{status:'paid',amount_paid:100},error:null})};const id='11111111-1111-5111-8111-111111111111';
  await recordConfirmedBankPayment(db as never,invoice,{...line,description:'INV-12'},id);
  expect(db.rpc).toHaveBeenCalledTimes(1);expect(db.rpc).toHaveBeenCalledWith('record_invoice_payment',expect.objectContaining({p_request_id:id,p_invoice:invoice.id,p_amount:100,p_paid_on:'2026-11-02'}));
 });
 it('does not call a write for a mismatched amount',async()=>{const db={rpc:vi.fn()};await expect(recordConfirmedBankPayment(db as never,invoice,{...line,amountPence:1},'bad')).rejects.toThrow();expect(db.rpc).not.toHaveBeenCalled();});
});
