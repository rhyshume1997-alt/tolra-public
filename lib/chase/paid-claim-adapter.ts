import { detectPaidClaim } from './paid-claim';
export type InboundEmail = { id: string; from: string; subject: string; body: string; receivedAt: string };
export type OpenInvoice = { id: string; number: string; customerEmail: string; customerName: string };
export type SuggestedPaidClaim = { invoiceId: string; emailId: string; confidence: 'high' | 'medium' | 'low'; reason: string };
const emailAddress = (v: string) => (v.match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1] ?? v.trim()).toLowerCase();
export function suggestPaidClaims(emails: InboundEmail[], invoices: OpenInvoice[]): SuggestedPaidClaim[] {
  const open = Array.isArray(invoices) ? invoices.filter(i => i && i.id && i.number) : [];
  return (Array.isArray(emails) ? emails : []).flatMap(email => {
    if (!email?.id || !email?.receivedAt || !Number.isFinite(Date.parse(email.receivedAt))) return [];
    const result = detectPaidClaim({ subject: email.subject, body: email.body }, open.map(i => i.number));
    if (!result.claimsPaid) return [];
    const from = emailAddress(email.from ?? '');
    const named = open.filter(i => result.invoiceRefs.includes(i.number));
    const matchingSender = open.filter(i => emailAddress(i.customerEmail) === from);
    const candidates = named.length ? named : matchingSender;
    if (!candidates.length) return [];
    if (!named.length && candidates.length !== 1) return [];
    return candidates.map(invoice => ({
      invoiceId: invoice.id, emailId: email.id,
      confidence: named.some(i => i.id === invoice.id) && matchingSender.some(i => i.id === invoice.id) ? 'high' : named.length ? 'medium' : 'low',
      reason: named.length ? 'Payment claimed with invoice number ' + invoice.number : 'Payment claimed by the invoice customer email',
    }));
  });
}