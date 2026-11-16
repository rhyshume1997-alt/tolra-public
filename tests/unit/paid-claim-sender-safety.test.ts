import { describe, expect, it } from "vitest";
import { suggestPaidClaims, type InboundEmail } from "@/lib/chase/paid-claim-adapter";
const invoice={id:'i',number:'INV-123',customerEmail:'accounts@shop.co.uk',customerName:'Shop'};
const message:InboundEmail={id:'email',from:'accounts@shop.co.uk',subject:'BACS sent',body:'INV-123',receivedAt:'2026-11-02T10:00:00Z'};
describe('sender safeguards on payment suggestions',()=>{
 it('never matches blank sender to a blank customer address',()=>expect(suggestPaidClaims([{...message,from:'',body:''}],[{...invoice,customerEmail:''}])).toEqual([]));
 it.each(['not-an-address','a@b','two@shop.co.uk, accounts@shop.co.uk','accounts@shop.co.uk\r\nBcc: other@example.test'])('refuses malformed or multiple sender %s',from=>expect(suggestPaidClaims([{...message,from}],[invoice])).toEqual([]));
 it('does not suggest a named invoice belonging to another sender',()=>expect(suggestPaidClaims([{...message,from:'stranger@example.test'}],[invoice])).toEqual([]));
 it('accepts a single matching mailbox with a display name and case differences',()=>expect(suggestPaidClaims([{...message,from:'Accounts <ACCOUNTS@SHOP.CO.UK>'}],[invoice])).toMatchObject([{invoiceId:'i',confidence:'high'}]));
 it('does not attach a shorter reference in another account',()=>expect(suggestPaidClaims([message],[invoice,{...invoice,id:'other',number:'INV-12',customerEmail:'other@example.test'}]).map(x=>x.invoiceId)).toEqual(['i']));
 it('does not duplicate suggestions for a repeated message',()=>expect(suggestPaidClaims([message,message],[invoice])).toHaveLength(1));
 it('never turns a future payment promise into a suggestion',()=>expect(suggestPaidClaims([{...message,subject:'Invoice update',body:'We will pay INV-123 next week.'}],[invoice])).toEqual([]));
});
