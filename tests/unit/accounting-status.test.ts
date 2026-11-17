import {expect,it,vi,beforeEach} from 'vitest';
import {accountingStatuses} from '@/lib/integrations/accounting-status';
import type {IntegrationOverview} from '@/lib/integrations/overview';
const overview={provider:'xero',status:'connected',tenant_name:'Synthetic',connected_at:null,status_reason:null,unmapped:[],counts:{},contact_problems:0} satisfies IntegrationOverview;
const input=()=>({configured:true,overview,enabled:true,last:{status:'sent',updated_at:'2026-11-05'},lastReadOk:true});
it('connected plus configured/mapped but held is OFF, never Ready',()=>{expect(accountingStatuses({...input(),enabled:false})[0]).toMatchObject({connection:'Connected',readiness:'Transfers OFF'});});
it('explicit enable, connection, mapping and configuration are all needed for Ready',()=>{
 expect(accountingStatuses(input())[0]).toMatchObject({readiness:'Ready',lastTransfer:'Succeeded'});
 for(const x of [{configured:false},{enabled:null},{overview:null},{overview:{...overview,unmapped:['vat:20']}}])expect(accountingStatuses({...input(),...x})[0].readiness).not.toBe('Ready');
});
it('distinguishes missing setup, mapping and last failures without inferring a connection',()=>{
 expect(accountingStatuses({...input(),configured:false})[0].configuration).toBe('Needs configuration');
 expect(accountingStatuses({...input(),overview:{...overview,unmapped:['account:sales']},last:{status:'failed'}})[0]).toMatchObject({mapping:'Mapping outstanding',lastTransfer:'Failed'});
 expect(accountingStatuses({...input(),lastReadOk:false})[0].lastTransfer).toBe('Unknown');
});
it('the file-export row names no Sage or QuickBooks, claims no connection, and is never ready or transferred',()=>{
 const rows=accountingStatuses(input());
 expect(rows.map(r=>r.id)).toEqual(['xero','file-export']);
 expect(rows[1]).toMatchObject({name:'File export (CSV / Excel)',readiness:'File export only, no live link',lastTransfer:'No online transfers',connection:'Not applicable',transfers:'Not applicable'});
 expect(JSON.stringify(rows)).not.toMatch(/sage|quickbooks|read-only payment/i);
});
it('Sage and QuickBooks inputs are ignored: no provider row is ever produced for them',()=>{
 const rows=accountingStatuses({...input(),sage:{...overview,provider:'sage'},quickbooks:{...overview,provider:'quickbooks'}} as never);
 expect(rows.some(r=>r.id==='quickbooks'||r.id==='sage-files')).toBe(false);
 expect(rows).toHaveLength(2);
});
it('Xero transfers are On, Off or Unknown separately from Connected',()=>{
 expect(accountingStatuses(input())[0]).toMatchObject({connection:'Connected',transfers:'On'});
 expect(accountingStatuses({...input(),enabled:false})[0]).toMatchObject({connection:'Connected',transfers:'Off'});
 expect(accountingStatuses({...input(),enabled:null})[0]).toMatchObject({connection:'Connected',transfers:'Unknown',readiness:'Unknown'});
});
it('a later success does not hide earlier failures',()=>{
 const x=accountingStatuses({...input(),overview:{...overview,counts:{failed:2,needs_check:1,sent:5}},lastFailure:{status:'failed',updated_at:'2026-11-01T10:00:00Z'},failureReadOk:true})[0];
 expect(x.lastTransfer).toBe('Succeeded');expect(x.failures).toBe('2 failed, 1 needs checking, latest Failed 2026-11-01');
 expect(accountingStatuses({...input(),last:null,failureReadOk:true})[0].failures).toBe('None recorded');
 expect(accountingStatuses({...input(),overview:null})[0].failures).toBe('Unknown');
});
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({rpc:vi.fn(),filters:[] as unknown[],support:false,allowed:true}));
vi.mock('@/lib/integrations/server',()=>({xeroReady:async()=>({synthetic:true})}));
vi.mock('@/lib/server/auth',()=>({requireProfile:async()=>state.allowed?{profile:{organization_id:'synthetic-A'},session:{support:state.support},supabase:{rpc:state.rpc,from:()=>{const q={select:()=>q,eq:(c:string,v:string)=>{state.filters.push([c,v]);return q;},in:(c:string,v:unknown)=>{state.filters.push([c,v]);return q;},order:()=>q,limit:async()=>({data:[{status:'failed'}],error:null})};return q;}}}:new Response('',{status:403}),isErrorResponse:(x:unknown)=>x instanceof Response,jsonError:(error:string,status:number)=>Response.json({error},{status})}));
import {GET} from '@/app/api/integrations/accounting-status/route';
beforeEach(()=>{state.allowed=true;state.support=false;state.filters=[];state.rpc.mockReset().mockImplementation(async(fn:string)=>({data:fn==='integration_overview'?overview:{enabled:false},error:null}));});
it('admin status route scopes transfer reads to current company and exposes no tokens',async()=>{
 const result=await (await GET()).json();expect(state.filters).toContainEqual(['organization_id','synthetic-A']);expect(result.providers[0]).toMatchObject({readiness:'Transfers OFF',transfers:'Off'});expect(result.providers.map((p:{id:string})=>p.id)).toEqual(['xero','file-export']);expect(state.filters).toContainEqual(['status',['failed','needs_check']]);expect(JSON.stringify(result)).not.toContain('token');
});
it('refuses non-admin and support reads',async()=>{state.allowed=false;expect((await GET()).status).toBe(403);state.allowed=true;state.support=true;expect((await GET()).status).toBe(403);expect(state.rpc).not.toHaveBeenCalled();});
it('status route reads only the Xero overview, never sage or quickbooks',async()=>{await GET();expect(state.rpc.mock.calls.every((c:unknown[])=>(c[1] as {p_provider?:string}|undefined)?.p_provider!=='sage'&&(c[1] as {p_provider?:string}|undefined)?.p_provider!=='quickbooks')).toBe(true);});
