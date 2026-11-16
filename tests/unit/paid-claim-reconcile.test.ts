import { expect,it } from 'vitest';
import { suggestPaidClaims } from '@/lib/chase/paid-claim-adapter';
const invoices=[{id:'short',number:'INV-1',customerEmail:'accounts@acme.co.uk',customerName:'Acme'},{id:'long',number:'INV-10',customerEmail:'accounts@acme.co.uk',customerName:'Acme'}];
const message=(body:string,from='accounts@acme.co.uk')=>({id:'mail',from,body,subject:'Payment update',receivedAt:'2026-11-03T10:00:00Z'});
it('the adapter uses the reconciled detector reference boundaries',()=>expect(suggestPaidClaims([message('We have sent the BACS for INV-10')],invoices).map(x=>x.invoiceId)).toEqual(['long']));
it('future wording does not produce an adapter suggestion',()=>expect(suggestPaidClaims([message('We will pay INV-1 next week')],invoices)).toEqual([]));
it('a completed claim cannot be redirected to the invoice discussed as future payment',()=>expect(suggestPaidClaims([message('We have paid INV-10. We will pay INV-1 next week.')],invoices).map(x=>x.invoiceId)).toEqual(['long']));
it('an explicit completed claim still requires the real customer mailbox',()=>expect(suggestPaidClaims([message('INV-10 settled','"accounts@acme.co.uk" <other@evil.test>')],invoices)).toEqual([]));
it('retains multiple explicitly paid invoices and deduplicates repeated email input',()=>{
 const email=message('BACS sent for INV-1 and INV-10');expect(suggestPaidClaims([email,email],invoices).map(x=>x.invoiceId).sort()).toEqual(['long','short']);
});
