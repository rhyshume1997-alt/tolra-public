import { describe, expect, it } from 'vitest';
import { suggestPaidClaims, type InboundEmail, type OpenInvoice } from '../../lib/chase/paid-claim-adapter';
const inv: OpenInvoice[] = [
{id:'a',number:'INV-101',customerEmail:'accounts@acme.co.uk',customerName:'Acme'},
{id:'b',number:'INV-102',customerEmail:'accounts@acme.co.uk',customerName:'Acme'},
{id:'c',number:'INV-201',customerEmail:'office@other.co.uk',customerName:'Other'},
];
const msg=(subject:string,body='',from='accounts@acme.co.uk'):InboundEmail=>({id:'e',from,subject,body,receivedAt:'2026-11-02T10:00:00Z'});
describe('suggestPaidClaims',()=>{
 const positives=['Payment made today','BACS sent','Remittance attached','Paid on Friday','We have transferred the payment','We have settled the invoice'];
 it.each(positives)('matches a named invoice with %s',body=>{
   expect(suggestPaidClaims([msg('Update',body+' for INV-101')],inv).map(x=>x.invoiceId)).toEqual(['a']);
 });
 const negatives=['Will pay tomorrow','Not yet paid','Please send invoice','Can you confirm payment received?','Out of office'];
 it.each(negatives)('ignores %s',body=>expect(suggestPaidClaims([msg('Update',body)],inv)).toEqual([]));
 it('does not guess between same sender invoices',()=>expect(suggestPaidClaims([msg('BACS sent')],inv)).toEqual([]));
 it('matches one sender invoice',()=>expect(suggestPaidClaims([msg('BACS sent','','office@other.co.uk')],inv)[0].invoiceId).toBe('c'));
 it('supports two explicitly named invoices',()=>expect(suggestPaidClaims([msg('BACS sent','INV-101 and INV-102')],inv)).toHaveLength(2));
 it('ignores an unknown sender without a reference',()=>expect(suggestPaidClaims([msg('BACS sent','','stranger@example.org')],inv)).toEqual([]));
 it('accepts mailbox display names',()=>expect(suggestPaidClaims([msg('BACS sent','','Office <office@other.co.uk>')],inv)).toHaveLength(1));
 it('ignores invalid timestamps',()=>expect(suggestPaidClaims([{...msg('BACS sent'),receivedAt:'bad'}],inv)).toEqual([]));
 it('ignores an empty list',()=>expect(suggestPaidClaims([],inv)).toEqual([]));
});