import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {EXIT} from '@/scripts/sliq-reconcile/cli.mjs';
import {workspace,runCli,analyse,editCsv,editTable,type Ws} from '@/tests/support/sliq-reconcile';
const allocated:Ws[]=[];
const make=()=>{const ws=workspace();allocated.push(ws);return ws;};
const hashTree=(root:string):Record<string,string>=>Object.fromEntries(readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>entry.isDirectory()?Object.entries(hashTree(path.join(root,entry.name))).map(([p,h])=>[entry.name+'/'+p,h]):[[entry.name,createHash('sha256').update(readFileSync(path.join(root,entry.name))).digest('hex')]]));
const inputs=(ws:Ws)=>({sliq:hashTree(ws.sliq),tolra:hashTree(ws.tolra)});
afterEach(()=>{for(const ws of allocated.splice(0))rmSync(ws.root,{recursive:true,force:true});});
it('read-only require-pass refuses outstanding synthetic WIP and leaves every input byte unchanged',async()=>{
 const ws=make(),before=inputs(ws);const result=await runCli(ws,['--require-pass']);
 expect(result.code).toBe(EXIT.NOT_PASS);expect(inputs(ws)).toEqual(before);
 expect(JSON.parse(readFileSync(path.join(ws.out,'summary.json'),'utf8')).verdict.status).toBe('INCOMPLETE');
});
it('a completed synthetic world can pass without modifying source exports or the snapshot',async()=>{
 const ws=make();editTable(ws,'jobs',rows=>{for(const row of rows)row.finished_at='2026-04-01';});editCsv(ws,'jobs.csv',s=>s.replace('In Progress','Finished'));
 const before=inputs(ws);expect((await runCli(ws,['--require-pass'])).code).toBe(EXIT.OK);expect(inputs(ws)).toEqual(before);
 expect(JSON.parse(readFileSync(path.join(ws.out,'summary.json'),'utf8')).verdict.status).toBe('PASS');
});
it.each([-1,1])('a %s penny receipt drift blocks sign-off with an exact outstanding-money difference',async delta=>{
 const ws=make();editTable(ws,'invoices',rows=>{rows.find(r=>r.invoice_ref==='S1002').amount_paid=((20000+delta)/100).toFixed(2);});
 const before=inputs(ws),report=await analyse(ws);expect(report.stats.receivables.source).toBe(188600);expect(report.stats.receivables.target).toBe(188600-delta);
 const row=report.rows.find(r=>r.code==='invoice_outstanding'&&r.identifier.includes('S1002'));expect(row).toMatchObject({source_value:'340.00',target_value:((34000-delta)/100).toFixed(2),difference:delta===1?'-0.01':'0.01',severity:'BLOCKER'});
 expect((await runCli(ws,['--require-pass'])).code).toBe(EXIT.BLOCKERS);expect(inputs(ws)).toEqual(before);
});
it('a missing unpaid invoice is a blocker, never hidden by matching counts elsewhere',async()=>{
 const ws=make();editTable(ws,'invoices',rows=>rows.filter(r=>r.invoice_ref!=='S1003'));const before=inputs(ws);const {rows}=await analyse(ws);
 expect(rows.find(r=>r.code==='invoice_missing_in_tolra'&&r.identifier.includes('S1003'))).toMatchObject({severity:'BLOCKER'});
 expect((await runCli(ws,['--require-pass'])).code).toBe(EXIT.BLOCKERS);expect(inputs(ws)).toEqual(before);
});
