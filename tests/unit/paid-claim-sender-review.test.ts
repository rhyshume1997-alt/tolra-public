import { describe,expect,it } from 'vitest';
import { suggestPaidClaims,type InboundEmail,type OpenInvoice } from '@/lib/chase/paid-claim-adapter';
const invoices:OpenInvoice[]=[{id:'acme',number:'INV-1',customerEmail:'accounts@acme.co.uk',customerName:'Acme'},{id:'similar',number:'INV-2',customerEmail:'accounts@acme-co.uk',customerName:'Similar'},{id:'plus',number:'INV-3',customerEmail:'accounts+payments@acme.co.uk',customerName:'Acme payments'}];
const message=(from:unknown,body='BACS sent for INV-1'):InboundEmail=>({id:'mail',from:from as string,subject:'Payment',body,receivedAt:'2026-11-03T10:00:00Z'});
describe('strict sender identity',()=>{
 it.each([undefined,null,'',' ','not-an-email','a@@acme.co.uk','@acme.co.uk','a..b@acme.co.uk','.a@acme.co.uk','a.@acme.co.uk','a@-acme.co.uk','a@acme-.co.uk','a@acme_co.uk','a@acme..co.uk','a@acme','a@acme.co.uk.','accounts@acme.co.uk\n','accounts@acme.co.uk\r\nBcc: x@evil.test','Office <accounts@acme.co.uk> <x@evil.test>','x@evil.test, accounts@acme.co.uk','x@evil.test; Office <accounts@acme.co.uk>','Office < accounts@acme.co.uk >','Office <accounts@acme.co.uk> trailing','"Unclosed <accounts@acme.co.uk>'])('refuses invalid/missing sender %s',from=>expect(suggestPaidClaims([message(from)],invoices)).toEqual([]));
 it.each(['accounts@acme.co.uk','ACCOUNTS@ACME.CO.UK','Office <accounts@acme.co.uk>','"Accounts, team" <accounts@acme.co.uk>','"other@example.test" <accounts@acme.co.uk>'])('accepts one actual matching mailbox: %s',from=>expect(suggestPaidClaims([message(from)],invoices).map(x=>x.invoiceId)).toEqual(['acme']));
 it.each(['accounts@acme.co.uk <accounts@evil.test>','"accounts@acme.co.uk" <accounts@evil.test>','Acme <accounts@acme.co.uk.evil.test>','Accounts <accounts@acme-co.uk>'])('never trusts display text or similar domains: %s',from=>expect(suggestPaidClaims([message(from)],invoices)).toEqual([]));
 it('uses the actual address when the display name contains another customer mailbox',()=>expect(suggestPaidClaims([message('"accounts@acme.co.uk" <accounts@acme-co.uk>','BACS sent for INV-2')],invoices).map(x=>x.invoiceId)).toEqual(['similar']));
 it('matches a plus address exactly without treating it as the base mailbox',()=>{
  expect(suggestPaidClaims([message('accounts+payments@acme.co.uk')],invoices)).toEqual([]);
  expect(suggestPaidClaims([message('accounts+payments@acme.co.uk','BACS sent for INV-3')],invoices).map(x=>x.invoiceId)).toEqual(['plus']);
  expect(suggestPaidClaims([message('accounts@acme.co.uk','BACS sent for INV-3')],invoices)).toEqual([]);
 });
 it('invalid stored sender cannot match another invalid sender',()=>expect(suggestPaidClaims([message('')],[{...invoices[0],customerEmail:''}])).toEqual([]));
 it('does not produce duplicate suggestions for repeated inbound messages',()=>expect(suggestPaidClaims([message('accounts@acme.co.uk'),message('accounts@acme.co.uk')],invoices)).toHaveLength(1));
});
