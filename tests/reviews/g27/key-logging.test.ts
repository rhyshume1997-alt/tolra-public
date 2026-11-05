import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({ step:'provider', key:'SYNTHETIC_CANARY_NOT_A_REAL_PROVIDER_KEY' }));
vi.mock('@/lib/integrations/crypto',()=>({ decryptSecret:()=>state.key }));
vi.mock('@/lib/server/supabase-admin',()=>({ createSupabaseAdminClient:()=>({
 from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{api_key_enc:'synthetic ciphertext'},error:state.step==='key'?new Error(state.key):null})})})}),
 rpc:async()=>({data:null,error:state.step==='settle'?{code:'XX000',message:state.key}:null}),
}) }));
import { runAiHelper } from '@/lib/ai-helper/server';
import { aiHelperEnabled } from '@/lib/ai-helper/flag';
afterEach(()=>vi.restoreAllMocks());
it.each(['reserve','key','provider','validation','settle'])('never logs or returns a synthetic key when %s fails',async step=>{
 state.step=step;
 const spies=[vi.spyOn(console,'error').mockImplementation(()=>{}),vi.spyOn(console,'warn').mockImplementation(()=>{}),vi.spyOn(console,'log').mockImplementation(()=>{})];
 const client={rpc:async()=>({data:{ok:true,request_id:'synthetic-request'},error:step==='reserve'?{code:'XX000',message:state.key}:null})} as unknown as SupabaseClient;
 const outcome=await runAiHelper({supabase:client,organizationId:'synthetic-company',feature:'rfq',system:'synthetic',data:'synthetic',schema:{},provider:{id:'mock',complete:async request=>{
   expect(request.apiKey).toBe(state.key); if(step==='provider') throw new Error(`SDK error with ${state.key}`);
   return {json:{},usage:{inputTokens:1,outputTokens:1},model:'synthetic'};
 }},validate:()=>{if(step==='validation')throw new Error(state.key);return{value:{},store:{}};}});
 expect(outcome.kind).not.toBe('ok');
 expect(JSON.stringify(outcome)).not.toContain(state.key);
 for(const spy of spies)expect(JSON.stringify(spy.mock.calls)).not.toContain(state.key);
});
it('has no global enablement without the explicit approved flag',()=>{expect(aiHelperEnabled({})).toBe(false);expect(aiHelperEnabled({AI_HELPER_ENABLED:'false'})).toBe(false);});
