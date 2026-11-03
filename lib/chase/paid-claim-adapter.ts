import { detectPaidClaim } from './paid-claim';
export type InboundEmail = { id: string; from: string; subject: string; body: string; receivedAt: string };
export type OpenInvoice = { id: string; number: string; customerEmail: string; customerName: string };
export type SuggestedPaidClaim = { invoiceId: string; emailId: string; confidence: 'high' | 'medium' | 'low'; reason: string };
const emailAddress = (value: unknown): string | null => {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return null;
  const text = value.trim();
  let address = text;
  if (text.includes('<') || text.includes('>')) {
    const match = /^([^<>]*)<([^<>]+)>$/.exec(text);
    if (!match) return null;
    const display = match[1].trim();
    // One mailbox only. A quoted display name can contain a comma or an email.
    if (display.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\.)*"$/.test(display)) return null;
    } else if (/[,;"]/.test(display)) return null;
    address = match[2];
  }
  if (address.length > 254 || address !== address.trim()) return null;
  const parts = address.split('@');
  if (parts.length !== 2 || parts[0].length > 64) return null;
  const [local, domain] = parts;
  // Conservative unquoted dot-atom mailbox. Do not strip dots or +tags.
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return address.toLowerCase();
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