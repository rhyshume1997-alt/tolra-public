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
it('file-only Sage never pretends to be connected or transferred',()=>{expect(accountingStatuses(input())[1]).toMatchObject({name:'Sage (file export)',connection:'File export only',lastTransfer:'No online transfers'});});
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({rpc:vi.fn(),filters:[] as unknown[],support:false,allowed:true}));
vi.mock('@/lib/integrations/server',()=>({xeroReady:async()=>({synthetic:true})}));
vi.mock('@/lib/server/auth',()=>({requireProfile:async()=>state.allowed?{profile:{organization_id:'synthetic-A'},session:{support:state.support},supabase:{rpc:state.rpc,from:()=>{const q={select:()=>q,eq:(c:string,v:string)=>{state.filters.push([c,v]);return q;},order:()=>q,limit:async()=>({data:[{status:'failed'}],error:null})};return q;}}}:new Response('',{status:403}),isErrorResponse:(x:unknown)=>x instanceof Response,jsonError:(error:string,status:number)=>Response.json({error},{status})}));
import {GET} from '@/app/api/integrations/accounting-status/route';
beforeEach(()=>{state.allowed=true;state.support=false;state.filters=[];state.rpc.mockReset().mockImplementation(async(fn:string)=>({data:fn==='integration_overview'?overview:{enabled:false},error:null}));});
it('admin status route scopes transfer reads to current company and exposes no tokens',async()=>{
 const result=await (await GET()).json();expect(state.filters).toContainEqual(['organization_id','synthetic-A']);expect(result.providers[0].readiness).toBe('Transfers OFF');expect(JSON.stringify(result)).not.toContain('token');
});
it('refuses non-admin and support reads',async()=>{state.allowed=false;expect((await GET()).status).toBe(403);state.allowed=true;state.support=true;expect((await GET()).status).toBe(403);expect(state.rpc).not.toHaveBeenCalled();});
