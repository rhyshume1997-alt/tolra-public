'use client';
import { useState } from 'react';
import { parseStatementCsv, matchStatementLines, type BankLine, type Invoice } from '@/lib/bank/match-statement';
type Props = { invoices: Invoice[]; onMarkPaid: (invoice: Invoice, line: BankLine) => void; onSkip: (line: BankLine) => void };
export function BankCheck({ invoices, onMarkPaid, onSkip }: Props) {
  const [csv, setCsv] = useState('');
  const [skipped, setSkipped] = useState<number[]>([]);
  const parsed = parseStatementCsv(csv);
  const matches = matchStatementLines(parsed.lines, invoices);
  const groups = [
    { heading: 'To confirm', entries: matches.map((m, index) => ({ ...m, index })).filter(m => m.confidence === 'high' && m.invoice) },
    { heading: 'Unsure', entries: matches.map((m, index) => ({ ...m, index })).filter(m => m.confidence === 'medium' && m.invoice) },
    { heading: 'No match', entries: matches.map((m, index) => ({ ...m, index })).filter(m => !m.invoice) },
  ];
  return <section aria-label="Bank check" className="space-y-4">
    <h2>Bank check</h2>
    <label>Bank statement file (.csv)<input aria-label="Bank statement file (.csv)" type="file" accept=".csv,text/csv" onChange={async event => { const file = event.target.files?.[0]; setCsv(file ? await file.text() : ''); setSkipped([]); }} /></label>
    {parsed.errors.length > 0 && <div role="alert">{parsed.errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
    {groups.map(group => <section key={group.heading} aria-label={group.heading}><h3>{group.heading} ({group.entries.filter(e => !skipped.includes(e.index)).length})</h3>
      <ul>{group.entries.filter(e => !skipped.includes(e.index)).map(entry => <li key={entry.index} className="border p-3">
        <span>{entry.invoice?.ref ?? 'No invoice'} | {entry.invoice?.customer ?? 'Unknown customer'} | £{(entry.line.amountPence / 100).toFixed(2)} | {entry.line.date}</span>
        <p>{entry.reason}</p>
        {entry.invoice && <button type="button" onClick={() => { onMarkPaid(entry.invoice!, entry.line); setSkipped(previous => [...previous, entry.index]); }}>Confirm payment received</button>}
        <button type="button" onClick={() => { onSkip(entry.line); setSkipped(previous => [...previous, entry.index]); }}>Skip</button>
      </li>)}</ul>
    </section>)}
  </section>;
}
