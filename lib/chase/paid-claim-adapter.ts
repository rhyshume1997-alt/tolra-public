import { detectPaidClaim } from './paid-claim';
export type InboundEmail = { id: string; from: string; subject: string; body: string; receivedAt: string };
export type OpenInvoice = { id: string; number: string; customerEmail: string; customerName: string };
export type SuggestedPaidClaim = { invoiceId: string; emailId: string; confidence: 'high' | 'medium' | 'low'; reason: string };
const emailAddress = (value: unknown): string | null => {
  if(typeof value !== 'string' || /[\r\n]/.test(value))return null;
  const match=/^\s*(?:[^<>]*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/.exec(value);
  const address=(match?.[1] ?? match?.[2] ?? '').toLowerCase();
  return address.length<=254 && /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(address) ? address : null;
};
export function suggestPaidClaims(emails: InboundEmail[], invoices: OpenInvoice[]): SuggestedPaidClaim[] {
  const open = Array.isArray(invoices) ? invoices.filter(i => i && typeof i.id === 'string' && !!i.id && typeof i.number === 'string' && !!i.number) : [];
  const seen=new Set<string>();
  return (Array.isArray(emails) ? emails : []).flatMap(email => {
    if (!email?.id || !email?.receivedAt || !Number.isFinite(Date.parse(email.receivedAt))) return [];
    const result = detectPaidClaim({ subject: email.subject, body: email.body }, open.map(i => i.number));
    if (!result.claimsPaid) return [];
    const from = emailAddress(email.from);
    if(!from)return [];
    const named = open.filter(i => result.invoiceRefs.includes(i.number));
    const matchingSender = open.filter(i => emailAddress(i.customerEmail) === from);
    const candidates = named.length ? named.filter(i=>matchingSender.some(m=>m.id===i.id)) : matchingSender;
    if (!candidates.length) return [];
    if (!named.length && candidates.length !== 1) return [];
    return candidates.filter(invoice=>{const key=email.id+'\0'+invoice.id;if(seen.has(key))return false;seen.add(key);return true;}).map(invoice => ({
      invoiceId: invoice.id, emailId: email.id,
      confidence: named.some(i => i.id === invoice.id) && matchingSender.some(i => i.id === invoice.id) ? 'high' : named.length ? 'medium' : 'low',
      reason: named.length ? 'Payment claimed with invoice number ' + invoice.number : 'Payment claimed by the invoice customer email',
    }));
  });
}