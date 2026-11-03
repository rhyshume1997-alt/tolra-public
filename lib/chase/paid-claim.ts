export type PaidClaim = {
  claimsPaid: boolean;
  invoiceRefs: string[];
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

const normalise = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

function relevantText(value: string): string {
  const lines = value.replace(/\r/g, '').split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(?:on .{3,120} wrote:|from:|sent:|subject:|to:)\s*/i.test(line)) break;
    if (/^\s*(?:kind regards|best regards|regards|many thanks|thanks and regards|sent from my|signature:|--\s*$)/i.test(line)) break;
    result.push(line);
  }
  return result.join('\n');
}

export function detectPaidClaim(
  email: { subject: string; body: string },
  knownInvoiceRefs: string[],
): PaidClaim {
  try {
    const subject = typeof email?.subject === 'string' ? email.subject : '';
    const body = typeof email?.body === 'string' ? email.body : '';
    const text = relevantText(subject + '\n' + body);
    if (!text.trim()) return { claimsPaid: false, invoiceRefs: [], confidence: 'low', reason: 'No message text' };
    if (/\b(?:automatic reply|auto(?:matic)?[- ]?reply|out of office|away from the office|on annual leave|currently unavailable)\b/i.test(subject) ||
        /^\s*(?:i am currently out of (?:the )?office|this is an automatic reply|thank you for your email\. i am away)/im.test(text)) {
      return { claimsPaid: false, invoiceRefs: [], confidence: 'low', reason: 'Automatic absence reply' };
    }
    const clean = text.replace(/\s+/g, ' ');
    const negative = /\b(?:not yet paid|not paid|haven't paid|have not paid|hasn't paid|unpaid|still to pay|will pay|going to pay|intend to pay|plan to pay|please send (?:the |an? )?invoice|could you send (?:the |an? )?invoice|can you confirm (?:whether |if )?(?:you(?:'ve| have) )?received (?:the |our )?payment|have you received (?:the |our )?payment|payment (?:is|will be) due|payment pending)\b/i;
    const phrases = [
      /\bpayment (?:has been |was )?made(?: today| yesterday| on \w+| this morning| this afternoon)?\b/i,
      /\b(?:bacs|bank transfer|faster payment) (?:has been |was )?(?:sent|made|completed)\b/i,
      /\b(?:we |i )?(?:have )?sent (?:the )?bacs\b/i,
      /\b(?:invoice|ref(?:erence)?)\s+[A-Z0-9][A-Z0-9 /-]{0,40}\s+(?:has been |was |is now )?(?:paid|settled)\b/i,
      /\b(?:i|we|our accounts team)\s+(?:have |has )?(?:paid|transferred|settled|sent (?:the )?payment)\b/i,
      /\bpaid (?:on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})|today|yesterday|in full|last week)\b/i,
      /\bremittance (?:advice )?(?:is |has been )?attached\b/i,
      /\b(?:funds|amount|balance|invoice|account) (?:has been |was |is now )?(?:transferred|settled|paid)\b/i,
      /\b(?:transferred|settled) (?:the |your |our )?(?:amount|balance|invoice|payment|funds|account)\b/i,
    ];
    const sentenceParts = clean.split(/(?<=[.!?;])\s+|\n+/);
    const evidence = sentenceParts.filter(part => phrases.some(pattern => pattern.test(part)) && !negative.test(part) && !part.includes("?") &&
      !/\b(?:if|once|when|after|before)\b[^.!?]*\b(?:paid|payment|transferred|settled)\b/i.test(part) &&
      !/\b(?:tomorrow|next week|next month|scheduled|expected|expect|once approved)\b/i.test(part) &&
      !/\b(?:did you|have you|could you|can you|please|if|once|when|after|before|not|never)\b[^.!?]*\b(?:paid|payment made|transferred|settled)\b/i.test(part));
    const claimsPaid = evidence.length > 0;
    if (!claimsPaid) return { claimsPaid: false, invoiceRefs: [], confidence: 'low', reason: negative.test(clean) ? 'No completed payment claim; message discusses future, missing or unconfirmed payment' : 'No completed payment claim detected' };
    // Match complete references, allowing separators but never a prefix of another reference.
    const hasRef = (value: string, ref: string) => {
      const pattern = normalise(ref).split('').join('[^A-Z0-9]*');
      return new RegExp('(?:^|[^A-Z0-9])' + pattern + '(?![A-Z0-9])', 'i').test(value);
    };
    const known = (Array.isArray(knownInvoiceRefs) ? knownInvoiceRefs : []).filter((ref): ref is string => typeof ref === 'string' && !!normalise(ref));
    const evidenceRefs = known.filter(ref => hasRef(evidence.join(' '), ref));
    const allowedContext = sentenceParts.filter(part => !negative.test(part) && !/\b(?:tomorrow|next week|next month)\b/i.test(part)).join(' ');
    const invoiceRefs = [...new Set(evidenceRefs.length ? evidenceRefs : known.filter(ref => hasRef(allowedContext, ref)))];
    const confidence = invoiceRefs.length ? 'high' : /\b(?:remittance|bacs|payment made|paid|settled|transferred)\b/i.test(evidence.join(' ')) ? 'medium' : 'low';
    return { claimsPaid: true, invoiceRefs, confidence, reason: invoiceRefs.length ? 'Completed payment claim mentions known invoice reference' : 'Completed payment claim without a known invoice reference' };
  } catch {
    return { claimsPaid: false, invoiceRefs: [], confidence: 'low', reason: 'Message could not be analysed' };
  }
}
