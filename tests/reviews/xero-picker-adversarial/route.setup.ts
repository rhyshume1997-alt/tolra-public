/** Actual rate limiter and recent-MFA policy run. Only authenticated identity/assurance projection uses synthetic data. */
import {vi} from 'vitest';
type Rpc=(name:string,args?:Record<string,unknown>)=>Promise<{data:unknown;error:{code?:string;message:string}|null}>;
type TestClient={from:(...args:unknown[])=>unknown;rpc:Rpc};
const ctx=vi.hoisted(()=>({url:'',actor:{id:'',org:'',role:'admin'},support:false,level:'aal2',recentSeconds:0,limiterError:false,auditError:false,claimGate:null as null|(()=>Promise<void>)}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/server/supabase-admin',async()=>{
 const {pgSupabase}=await import('@/tests/db/x149-support');const {Client}=await import('pg');return {createSupabaseAdminClient:()=>{
  const client=pgSupabase(ctx.url,{kind:'service'}) as unknown as TestClient,rpc=client.rpc.bind(client);
  return {...client,rpc:async(name:string,args?:Record<string,unknown>)=>{
   if(name==='auth_rate_hit'&&ctx.limiterError)return {data:null,error:{code:'08006',message:'Synthetic limiter unavailable'}};
   if(name==='auth_rate_hit'&&ctx.claimGate){
    // Real SQL RPC transaction; the barrier exposes a legal two-request pre-commit interleaving, never fabricates permission.
    const c=new Client({connectionString:ctx.url});await c.connect();try{await c.query('begin');await c.query('set local role service_role');
     const result=await c.query('select auth_rate_hit($1,$2,$3,$4) as allowed',[args!.p_bucket,args!.p_key_hash,args!.p_window_seconds,args!.p_max]);
     await ctx.claimGate();await c.query('commit');return {data:result.rows[0].allowed,error:null};
    }catch(e){await c.query('rollback');throw e;}finally{await c.end();}
   }
   return rpc(name,args);
  }};
 }};
});
vi.mock('@/lib/server/auth',async()=>{
 const actual=await vi.importActual<{jsonError:(message:string,status:number)=>Response}>('@/lib/server/auth');
 const {pgSupabase}=await import('@/tests/db/x149-support');
 return {...actual,requireProfile:async(roles:string[])=>{
  if(!roles.includes(ctx.actor.role))return actual.jsonError('Forbidden',403);
  const client=pgSupabase(ctx.url,{kind:'user',id:ctx.actor.id,recentCode:ctx.recentSeconds}) as unknown as TestClient,rpc=client.rpc.bind(client);
  return {supabase:{...client,rpc:(name:string,args?:Record<string,unknown>)=>ctx.auditError&&name==='write_audit'?Promise.resolve({data:null,error:{code:'42501',message:'Synthetic audit refusal'}}):rpc(name,args),auth:{mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:ctx.level,currentAuthenticationMethods:[{method:'totp',timestamp:Math.floor(Date.now()/1000)-ctx.recentSeconds}]},error:null})}}},user:{id:ctx.actor.id},profile:{organization_id:ctx.actor.org,role:ctx.actor.role},session:ctx.support?{support:true}:null};
 }};
});
export {ctx};
