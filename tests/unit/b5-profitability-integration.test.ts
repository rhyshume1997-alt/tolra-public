import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import * as purchasing from '@/lib/purchase-order-link';
// Type-only from the public test oracle. No pending feature or separate rate store is installed.
type CostTimer={id:string;organization_id:string;job_id:string;user_id?:string;machine_id?:string;operator_id?:string;started_at:string;ended_at:string|null};
const source=readFileSync('tests/reviews/b5-financial/fixtures/actuals-f5de19a.ts.txt','utf8');
const exports:Record<string,unknown>={};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(id:string)=>{if(id==='@/lib/purchase-order-link')return purchasing;throw Error('Unexpected oracle import');}});
const actual=exports.actualJobProfit as (input:unknown)=>{actualProfitPence:number|null;state:string};
const timer = (id: string, start = '08:00', end: string | null = '09:00'): CostTimer => ({ id, organization_id: 'org', job_id: 'job', user_id: 'worker', machine_id: 'mill', operator_id: 'worker', started_at: `2026-11-04T${start}:00Z`, ended_at: end ? `2026-11-04T${end}:00Z` : null });
const fixture = () => ({ organizationId: 'org', jobId: 'job', config: { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'labour', overhead_rate_pence: 500 }, rates: [{ machine_id: 'mill', rate_pence: 3000, includes_labour: false, includes_overhead: false }], labour: [timer('l')], machines: [timer('m')], plans: [{ machine_id: 'mill', estimated_hours: 1 }], estimate: { supplier_pence: 1000, labour_hours: 1, overhead_hours: 1, labour_not_required: false, machines_not_required: false }, pos: [{ id: 'po', total_value: '100.00', linked_net: '10.00', status: 'sent' }], invoices: [{ id: 'invoice', status: 'sent', subtotal: '200.00' }], credits: [{ invoice_id: 'invoice', status: 'issued', subtotal: '10.00' }], quoteLines: [{ quantity: 1, unit_price: 200 }] });


it('pins the public pending #378 source used for the integration finding',()=>{expect(createHash('sha256').update(source).digest('hex')).toBe('038a6bb12477b518e9e8e086a02432c27a1149e0a2c27bfbfb7c1f8b2de9d94d');});
it('pending #378 recalculates an old job at current rates: historical freeze is missing, do not activate',()=>{
 const input=fixture();expect(actual(input)).toMatchObject({state:'complete',actualProfitPence:12500});
 input.config.labour_rate_pence=4000;input.config.revision=2;
 expect(actual(input)).toMatchObject({state:'complete',actualProfitPence:10500});
});
it('assigned candidate legacy supplier profit never reads mutable costing rates',()=>{
 const current=readFileSync('components/bought-in-profit.tsx','utf8');expect(current).not.toMatch(/costing_defaults|costing_machines|job_profitability_actual_inputs/);
});
