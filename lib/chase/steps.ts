export type Step = { id: string; offsetDays: number; tone: 'before_due' | 'friendly' | 'firm' | 'final' };
export type ChaseInvoice = { id: string; dueDate: string; balancePence: number; paused: boolean; alreadySentStepIds: string[] };
export type ChaseFields = { customerName: string; invoiceRef: string; balancePence: number; dueDate: string; daysOverdue: number; jobRef?: string; jobStatus?: string; partsWaiting?: string[]; supplierExpectedDate?: string; companyName: string };

function dayNumber(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return Math.floor(timestamp / 86400000);
}

export function dueSteps(steps: Step[], invoice: ChaseInvoice, today: string): Step[] {
  try {
    if (invoice.paused || !Number.isSafeInteger(invoice.balancePence) || invoice.balancePence <= 0) return [];
    const due = dayNumber(invoice.dueDate);
    const current = dayNumber(today);
    if (due === null || current === null) return [];
    const sent = new Set(invoice.alreadySentStepIds ?? []);
    const allSteps = Array.isArray(steps) ? steps : [];
    const highestSentOffset = allSteps.filter(step => sent.has(step.id) && Number.isInteger(step.offsetDays)).reduce((highest, step) => Math.max(highest, step.offsetDays), -Infinity);
    const eligible = allSteps.filter(step =>
      step && typeof step.id === 'string' && Number.isInteger(step.offsetDays) &&
      current >= due + step.offsetDays && step.offsetDays > highestSentOffset && !sent.has(step.id));
    eligible.sort((a, b) => b.offsetDays - a.offsetDays);
    return eligible.length ? [eligible[0]] : [];
  } catch { return []; }
}

function money(pence: number): string {
  const safe = Number.isSafeInteger(pence) ? pence : 0;
  const absolute = Math.abs(safe);
  const pounds = Math.floor(absolute / 100).toLocaleString('en-GB');
  return (safe < 0 ? '-' : '') + '£' + pounds + '.' + String(absolute % 100).padStart(2, '0');
}

export function renderChase(tone: Step['tone'], fields: ChaseFields): { subject: string; body: string } {
  const customer = fields.customerName?.trim() || 'there';
  const ref = fields.invoiceRef?.trim() || 'your invoice';
  const company = fields.companyName?.trim() || 'Accounts';
  const balance = money(fields.balancePence);
  const due = fields.dueDate || 'the agreed due date';
  const days = Number.isFinite(fields.daysOverdue) ? Math.max(0, Math.trunc(fields.daysOverdue)) : 0;
  const details = [
    fields.jobRef ? 'Job reference: ' + fields.jobRef : '',
    fields.jobStatus ? 'Job status: ' + fields.jobStatus : '',
    fields.partsWaiting?.length ? 'Parts waiting: ' + fields.partsWaiting.join(', ') : '',
    fields.supplierExpectedDate ? 'Supplier expected date: ' + fields.supplierExpectedDate : '',
  ].filter(Boolean).join('\n');
  const heads: Record<Step['tone'], string> = {
    before_due: 'Reminder: invoice ' + ref + ' due soon',
    friendly: 'Payment reminder: invoice ' + ref,
    firm: 'Overdue invoice ' + ref + ': payment requested',
    final: 'Final payment reminder: invoice ' + ref,
  };
  const intro: Record<Step['tone'], string> = {
    before_due: 'A reminder that invoice ' + ref + ' for ' + balance + ' is due on ' + due + '. Please let us know if you need a copy.',
    friendly: 'We have not yet recorded payment of ' + balance + ' for invoice ' + ref + ', which was due on ' + due + '. Please let us know when payment is arranged.',
    firm: 'Invoice ' + ref + ' is ' + days + ' ' + (days === 1 ? 'day' : 'days') + ' overdue, with ' + balance + ' outstanding. Please arrange payment and confirm when we should expect it, or tell us about any query.',
    final: 'We are following up again about invoice ' + ref + '. The outstanding amount is ' + balance + '. Please contact us today with a payment date, or tell us if there is a problem we can help resolve.',
  };
  return {
    subject: heads[tone] ?? heads.friendly,
    body: ['Hello ' + customer + ',', '', intro[tone] ?? intro.friendly, details ? '\n' + details : '', 'If you have already paid, please let us know so we can check our records.', '', 'Kind regards,', company].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n'),
  };
}
