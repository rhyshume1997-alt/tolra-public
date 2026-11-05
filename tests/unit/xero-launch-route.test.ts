import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({support:false,rpc:vi.fn(),allowed:true,origin:true}));
vi.mock('@/lib/server/auth',()=>({
 requireProfile:async()=>state.allowed?{session:{support:state.support},supabase:{rpc:state.rpc}}:new Response('',{status:403}),
 isErrorResponse:(v:unknown)=>v instanceof Response,sameOrigin:()=>state.origin,forbiddenOrigin:()=>new Response('',{status:403}),
 jsonError:(error:string,status:number)=>Response.json({error},{status}),readJson:async(r:Request)=>({ok:true,data:await r.json()}),
}));
import {GET,POST} from '@/app/api/integrations/xero/launch/route';
const request=(body:unknown)=>new Request('https://synthetic.test/api/integrations/xero/launch',{method:'POST',body:JSON.stringify(body)});
beforeEach(()=>{state.support=false;state.allowed=true;state.origin=true;state.rpc.mockReset().mockResolvedValue({data:{enabled:false,connected:true},error:null});});
it('shows connected but OFF and saves explicit admin enable via the existing auth client',async()=>{
 expect(await (await GET()).json()).toEqual({enabled:false,connected:true});
 expect((await POST(request({enabled:true}))).status).toBe(200);expect(state.rpc).toHaveBeenCalledWith('integration_xero_set_transfers',{p_enabled:true});
});
it('refuses non-admin, support, cross-origin and invalid enable without changing settings',async()=>{
 state.allowed=false;expect((await POST(request({enabled:true}))).status).toBe(403);
 state.allowed=true;state.support=true;expect((await POST(request({enabled:true}))).status).toBe(403);
 state.support=false;state.origin=false;expect((await POST(request({enabled:true}))).status).toBe(403);
 state.origin=true;expect((await POST(request({enabled:'true'}))).status).toBe(400);expect(state.rpc).not.toHaveBeenCalled();
});
