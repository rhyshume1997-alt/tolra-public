export type Invoice = { id: string; ref: string; customer: string; balancePence: number; dueDate: string };
export type BankLine = { date: string; description: string; amountPence: number };
export type BankMatch = { line: BankLine; invoice: Invoice | null; confidence: 'high' | 'medium' | 'low'; reason: string };

function splitCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function parseDate(value: string): string | null {
  const text = value.trim();
  let year: number, month: number, day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    if (!match) return null;
    [, day, month, year] = match.map(Number);
  }
  const result = new Date(Date.UTC(year, month - 1, day));
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) return null;
  return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

function parsePence(value: string): number | null {
  const clean = value.trim().replace(/[£,\s]/g, '');
  if (!clean) return 0;
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return null;
  const pounds = Number(match[2]);
  const pennies = Number((match[3] ?? '').padEnd(2, '0'));
  const amount = pounds * 100 + pennies;
  if (!Number.isSafeInteger(amount)) return null;
  return match[1] === '-' ? -amount : amount;
}

function key(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }

export function parseStatementCsv(csv: string): { lines: BankLine[]; errors: string[] } {
  const lines: BankLine[] = [], errors: string[] = [];
  try {
    const rows = splitCsv(typeof csv === 'string' ? csv.replace(/^\uFEFF/, '') : '');
    const aliases = {
      date: ['date', 'transactiondate', 'valuedate', 'posteddate'],
      description: ['description', 'details', 'narrative', 'reference', 'transactiondescription', 'transactiondetails'],
      amount: ['amount', 'transactionamount'],
      credit: ['paidin', 'credit', 'moneyin', 'deposit'],
      debit: ['paidout', 'debit', 'moneyout', 'withdrawal'],
    };
    const indexOf = (row: string[], type: keyof typeof aliases) => row.findIndex(header => aliases[type].includes(key(header)));
    const headerAt = rows.findIndex(row => indexOf(row, 'date') >= 0 && indexOf(row, 'description') >= 0 &&
      (indexOf(row, 'amount') >= 0 || indexOf(row, 'credit') >= 0 || indexOf(row, 'debit') >= 0));
    if (headerAt < 0) return { lines, errors: ['No recognised bank statement header'] };
    const header = rows[headerAt];
    const dateCol = indexOf(header, 'date'), descCol = indexOf(header, 'description');
    const amountCol = indexOf(header, 'amount'), creditCol = indexOf(header, 'credit'), debitCol = indexOf(header, 'debit');
    rows.slice(headerAt + 1).forEach((row, i) => {
      const date = parseDate(row[dateCol] ?? '');
      const description = (row[descCol] ?? '').trim();
      const money = amountCol >= 0 ? parsePence(row[amountCol] ?? '') : parsePence(row[creditCol] ?? '');
      const debit = amountCol < 0 && debitCol >= 0 ? parsePence(row[debitCol] ?? '') : 0;
      if (row.length !== header.length || !date || !description || money === null || debit === null) {
        errors.push('Row ' + (headerAt + i + 2) + ': invalid date, description or amount');
        return;
      }
      const amountPence = amountCol >= 0 ? money : money - Math.abs(debit ?? 0);
      lines.push({ date, description, amountPence });
    });
    return { lines, errors };
  } catch { return { lines, errors: ['Statement could not be parsed'] }; }
}

export function matchStatementLines(lines: BankLine[], invoices: Invoice[]): BankMatch[] {
  const available = new Set<string>();
  const all = (Array.isArray(invoices) ? invoices : []).filter(invoice => invoice && invoice.balancePence > 0);
  return (Array.isArray(lines) ? lines : []).map(line => {
    if (!line || line.amountPence <= 0) return { line, invoice: null, confidence: 'low', reason: 'Not a money-in transaction' };
    const description = key(line.description);
    const candidates = all.filter(invoice => !available.has(invoice.id) && invoice.balancePence === line.amountPence);
    const byRef = candidates.filter(invoice => key(invoice.ref) && description.includes(key(invoice.ref)));
    const byCustomer = candidates.filter(invoice => key(invoice.customer).length >= 4 && description.includes(key(invoice.customer)));
    const chosen = byRef.length === 1 ? byRef[0] : byCustomer.length === 1 ? byCustomer[0] : null;
    if (chosen) available.add(chosen.id);
    return { line, invoice: chosen, confidence: byRef.length === 1 ? 'high' : chosen ? 'medium' : 'low',
      reason: byRef.length === 1 ? 'Exact amount and invoice reference' : chosen ? 'Exact amount and customer name' : 'No unique invoice match' };
  });
}
