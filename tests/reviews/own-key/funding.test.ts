import {beforeEach, expect, it, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({source:'own',missing:false,cap:false,reads:[] as string[],rpcs:[] as string[]}));
vi.mock('@/lib/integrations/crypto',()=>({decryptSecret:(cipher:string)=>{if(!cipher)throw Error('missing synthetic key');return cipher;}}));
vi.mock('@/lib/server/supabase-admin',()=>({createSupabaseAdminClient:()=>({
 from:(table:string)=>{state.reads.push(table);const q={select:()=>q,eq:(key:string,value:string)=>{expect([key,value]).toEqual(['organization_id','synthetic-company-A']);return q;},maybeSingle:async()=>({data:state.missing?null:{api_key_enc:'synthetic-company-owned-key'},error:null})};return q;},
 rpc:async(fn:string)=>{state.rpcs.push(fn);return {data:fn==='ai_helper_tolra_key'?'synthetic-platform-held-key':null,error:null};},
})}));
import {runAiHelper} from './fixtures/server';
function run(){
 const complete=vi.fn(async(req:{apiKey:string})=>({json:{keyUsed:req.apiKey},usage:{inputTokens:1,outputTokens:1},model:'synthetic'}));
 const supabase={rpc:async()=>({data:{ok:!state.cap,reason:state.cap?'cap':undefined,request_id:'synthetic-request',key_source:state.source},error:null})} as unknown as SupabaseClient;
 const result=runAiHelper({supabase,organizationId:'synthetic-company-A',feature:'rfq',system:'synthetic',data:'synthetic',schema:{},provider:{id:'mock',complete},validate:(json)=>({value:json,store:{synthetic:true}})});
 return {result,complete};
}
beforeEach(()=>{state.source='own';state.missing=false;state.cap=false;state.reads=[];state.rpcs=[];});
it('own mode uses only this company key, never the platform-held key',async()=>{
 const r=run();expect(await r.result).toMatchObject({kind:'ok',value:{keyUsed:'synthetic-company-owned-key'}});
 expect(state.reads).toEqual(['ai_helper_secrets']);expect(state.rpcs).toEqual(['ai_helper_settle']);
});
it('missing own key fails closed without falling back to Tolra credentials',async()=>{
 state.missing=true;const r=run();expect(await r.result).toMatchObject({kind:'failed',detail:'key'});
 expect(r.complete).not.toHaveBeenCalled();expect(state.rpcs).toEqual(['ai_helper_settle']);
});
it('provided mode is a different credential path',async()=>{
 state.source='tolra';const r=run();expect(await r.result).toMatchObject({kind:'ok',value:{keyUsed:'synthetic-platform-held-key'}});
 expect(state.reads).toEqual([]);expect(state.rpcs).toEqual(['ai_helper_tolra_key','ai_helper_settle']);
});
it('cap refusal reaches neither funding path',async()=>{
 state.cap=true;const r=run();expect(await r.result).toMatchObject({kind:'cap'});
 expect(r.complete).not.toHaveBeenCalled();expect(state.reads).toEqual([]);expect(state.rpcs).toEqual([]);
});
