import { expect,it,vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
vi.mock('server-only',()=>({}));
vi.mock('@/lib/server/supabase-admin',()=>({createSupabaseAdminClient:()=>({from:()=>{throw new Error('No key read is allowed after cap refusal');},rpc:()=>{throw new Error('No settlement after cap refusal');}})}));
import { runAiHelper } from '@/lib/ai-helper/server';
it('G31-06 cap refusal stops before key read and provider call',async()=>{
 const complete=vi.fn();
 const client={rpc:async()=>({data:{ok:false,reason:'cap',request_id:'synthetic-cap'},error:null})} as unknown as SupabaseClient;
 const r=await runAiHelper({supabase:client,organizationId:'synthetic-A',feature:'rfq',system:'synthetic',data:'synthetic',schema:{},provider:{id:'mock',complete},validate:()=>{throw new Error('No validation after refusal');}});
 expect(r).toEqual({kind:'cap',requestId:'synthetic-cap'});expect(complete).not.toHaveBeenCalled();
});
