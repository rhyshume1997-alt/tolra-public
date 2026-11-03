'use client';
import { useRef, useState } from 'react';
import { parseStatementCsv, matchStatementLines, type BankLine, type Invoice } from '@/lib/bank/match-statement';
import { bankPaymentRequestId } from '@/lib/bank/confirmation';
type Props = { invoices: Invoice[]; onMarkPaid: (invoice: Invoice, line: BankLine, requestId: string) => void | Promise<void>; onSkip: (line: BankLine) => void | Promise<void> };
export function BankCheck({ invoices, onMarkPaid, onSkip }: Props) {
  const [csv, setCsv] = useState('');
  const [skipped, setSkipped] = useState<number[]>([]);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const busy=useRef(false);
  const read=useRef(0);
  const parsed = parseStatementCsv(csv);
  const matches = matchStatementLines(parsed.lines, invoices);
  const groups = [
    { heading: 'To confirm', entries: matches.map((m, index) => ({ ...m, index })).filter(m => m.confidence === 'high' && m.invoice) },
    { heading: 'Unsure', entries: matches.map((m, index) => ({ ...m, index })).filter(m => m.confidence === 'medium' && m.invoice) },
    { heading: 'No match', entries: matches.map((m, index) => ({ ...m, index })).filter(m => !m.invoice) },
  ];
  async function perform(index:number, action:()=>void|Promise<void>){
    if(busy.current)return;
    busy.current=true;setPending(true);setError('');
    try{await action();setSkipped(previous=>[...previous,index]);}
    catch{setError('Could not complete that action. The row is still here. Check whether the payment was saved before trying again.');}
    finally{busy.current=false;setPending(false);}
  }
  return <section aria-label="Bank check" className="space-y-4">
    <h2>Bank check</h2>
    <label>Bank statement file (.csv)<input aria-label="Bank statement file (.csv)" type="file" accept=".csv,text/csv" disabled={pending} onChange={async event => {
      if(busy.current)return;
      const id=++read.current;const file=event.target.files?.[0];
      try{const text=file?await file.text():'';if(id===read.current){setCsv(text);setSkipped([]);setError('');}}
      catch{if(id===read.current){setCsv('');setError('Could not read that file. Choose the bank statement again.');}}
    }} /></label>
    {parsed.errors.length > 0 && csv && <div role="alert">{parsed.errors.map((error, index) => <p key={index}>{error}</p>)}<p>Correct the file before confirming payments.</p></div>}
    {error&&<p role="alert">{error}</p>}
    {pending&&<p role="status">Saving…</p>}
    {groups.map(group => <section key={group.heading} aria-label={group.heading}><h3>{group.heading} ({group.entries.filter(e => !skipped.includes(e.index)).length})</h3>
      <ul>{group.entries.filter(e => !skipped.includes(e.index)).map(entry => <li key={entry.index} className="border p-3">
        <span>{entry.invoice?.ref ?? 'No invoice'} | {entry.invoice?.customer ?? 'Unknown customer'} | £{(entry.line.amountPence / 100).toFixed(2)} | {entry.line.date}</span>
        <p>{entry.reason}</p>
        {entry.invoice && <button type="button" disabled={pending||!!parsed.errors.length} onClick={() => void perform(entry.index,async()=>{const id=await bankPaymentRequestId(csv,entry.index,entry.invoice!.id);await onMarkPaid(entry.invoice!,entry.line,id);})}>Confirm payment received</button>}
        <button type="button" disabled={pending} onClick={() => void perform(entry.index,()=>onSkip(entry.line))}>Skip</button>
      </li>)}</ul>
    </section>)}
  </section>;
}
