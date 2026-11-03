import { describe, expect, it } from 'vitest';
import { detectPaidClaim } from '../../lib/chase/paid-claim';

const refs = ['INV-0012', 'INV-2026-015', 'JNR 72'];
const detect = (subject: string, body = '') => detectPaidClaim({ subject, body }, refs);
describe('detectPaidClaim', () => {
  const positive = [
    ['Payment made today', 'Please find invoice INV-0012'],
    ['BACS sent', 'For INV 0012'],
    ['Invoice update', 'We paid on Friday, INV-0012'],
    ['Remittance attached', 'INV-0012'],
    ['Invoice 12', 'We have transferred the payment for INV0012'],
    ['Settlement', 'We have settled INV-0012'],
    ['Account update', 'The balance has been settled for JNR-72'],
    ['Payment notification', 'Our accounts team sent payment for INV 2026 015'],
    ['BACS', 'BACS has been sent this morning for INV-0012'],
    ['Payment', 'We paid yesterday, thanks'],
    ['Remittance advice attached', 'Please see INV-0012'],
    ['Payment sent', 'We have sent the payment'],
    ['Invoices', 'We have paid INV-0012 and INV-2026-015'],
    ['Funds transferred', 'Funds transferred today for INV-0012'],
    ['Payment made', 'Paid in full for JNR 72'],
    ['Account settled', 'Account is now settled'],
  ];
  it.each(positive)('accepts completed payment: %s', (subject, body) => {
    expect(detect(subject, body).claimsPaid).toBe(true);
  });
  const negative = [
    ['Payment', 'We will pay INV-0012 tomorrow'],
    ['Invoice request', 'Please send invoice INV-0012'],
    ['Payment', 'Not yet paid INV-0012'],
    ['Enquiry', 'Can you confirm payment received?'],
    ['Enquiry', 'Have you received our payment for INV-0012?'],
    ['Payment', 'We are going to pay next week'],
    ['Invoice', 'Payment pending'],
    ['Account', 'We have not paid this yet'],
    ['Payment', 'We intend to pay Friday'],
    ['Out of office', 'We paid INV-0012'],
    ['Automatic reply', 'Payment made today'],
    ['Out of office reply', 'I am currently out of the office'],
    ['Old email', '> Paid in full for INV-0012'],
    ['Reply', 'Thank you\n> Payment made today for INV-0012'],
    ['Reply', 'Kind regards\nPaid in full for INV-0012'],
    ['Reply', 'Sent from my iPhone\nBACS sent INV-0012'],
    ['Reply', 'From: accounts@example.com\nPaid on Friday'],
    ['Reply', 'We have not paid INV-0012'],
  ];
  it.each(negative)('rejects non-claim: %s', (subject, body) => {
    expect(detect(subject, body).claimsPaid).toBe(false);
  });
  it('extracts references ignoring case, spaces and hyphens', () => {
    expect(detect('BACS sent', 'inv 0012, inv2026015, jnr-72').invoiceRefs).toEqual(refs);
  });
  it('never throws on empty input', () => {
    expect(detect('', '')).toEqual({ claimsPaid: false, invoiceRefs: [], confidence: 'low', reason: 'No message text' });
  });
  it('ignores malformed runtime arguments', () => {
    expect(detectPaidClaim(null as never, null as never).claimsPaid).toBe(false);
  });
  it('returns high confidence with a known reference', () => {
    expect(detect('Payment made today', 'INV-0012').confidence).toBe('high');
  });
  it('returns medium confidence without an invoice number', () => {
    expect(detect('BACS sent').confidence).toBe('medium');
  });
});
