import {beforeEach,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {AccountingProvider} from '@/lib/integrations/types';
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({sent:vi.fn(),token:vi.fn(),enabled:false}));
vi.mock('@/lib/integrations/engine',async importOriginal=>({...await importOriginal<object>(),runSends:state.sent}));
vi.mock('@/lib/integrations/tokens',()=>({createTokenSource:()=>state.token}));
import {sendQueued} from '@/lib/integrations/server';
import {heldXeroProvider,xeroTransfersEnabled} from '@/lib/integrations/xero/launch-hold';
import {batchDeps} from '@/lib/integrations/xero/batch-deps';
const ready={config:{} as never,key:Buffer.alloc(32)};
const client=()=>({rpc:vi.fn(async()=>({data:state.enabled,error:null}))}) as unknown as SupabaseClient;
beforeEach(()=>{state.enabled=false;state.sent.mockReset();state.token.mockReset();state.sent.mockResolvedValue({sent:1});});
it('connected company held OFF makes no engine, token or outbound call',async()=>{
 expect(await sendQueued(client(),'company-A',ready)).toMatchObject({blocked:'launch_hold',sent:0});
 expect(state.sent).not.toHaveBeenCalled();expect(state.token).not.toHaveBeenCalled();
});
it('explicit enable follows the existing normal send path',async()=>{
 state.enabled=true;expect(await sendQueued(client(),'company-A',ready)).toEqual({sent:1});expect(state.sent).toHaveBeenCalledOnce();
});
it.each([null,false,{},'true'])('missing or malformed enable %j stays OFF',async value=>{
 const c={rpc:async()=>({data:value,error:null})} as unknown as SupabaseClient;expect(await xeroTransfersEnabled(c,'A')).toBe(false);
});
it('read failure stays OFF',async()=>{expect(await xeroTransfersEnabled({rpc:async()=>{throw Error('synthetic');}} as unknown as SupabaseClient,'A')).toBe(false);});
it('held batch cannot enqueue or retry even with an existing connection',async()=>{
 const service={...client(),from:vi.fn()},user={rpc:vi.fn()};
 const deps=batchDeps({service:service as never,user:user as never,org:'company-A',ready});
 await expect(deps.enqueue({} as never)).rejects.toThrow('off');await expect(deps.retry('synthetic-send')).rejects.toThrow('off');
 expect(service.from).not.toHaveBeenCalled();expect(user.rpc).not.toHaveBeenCalled();
});
it('enabled batch keeps its existing retry path',async()=>{
 state.enabled=true;const user={rpc:vi.fn(async()=>({error:null}))};
 await batchDeps({service:client(),user:user as never,org:'company-A',ready}).retry('synthetic-send');
 expect(user.rpc).toHaveBeenCalledWith('integration_retry_send',{p_send:'synthetic-send'});
});
it('rechecks hold before invoice, credit, void and retry read-back operations',async()=>{
 const call=vi.fn();const provider={id:'xero',pushInvoice:call,pushCreditNote:call,voidInvoice:call,readBack:call,createContact:call} as unknown as AccountingProvider;
 const held=heldXeroProvider(provider,async()=>state.enabled);
 for(const op of [()=>held.pushInvoice({} as never,{} as never,'c','k'),()=>held.pushCreditNote({} as never,{} as never,'c','k'),()=>held.voidInvoice('i','k'),()=>held.readBack('invoice','INV-1'),()=>held.createContact('name','k')])await expect(op()).rejects.toThrow('off');
 expect(call).not.toHaveBeenCalled();state.enabled=true;await held.readBack('invoice','INV-1');expect(call).toHaveBeenCalledOnce();
 state.enabled=false;await expect(held.readBack('invoice','INV-1')).rejects.toThrow('off');expect(call).toHaveBeenCalledOnce();
});
