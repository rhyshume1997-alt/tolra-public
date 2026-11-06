/** Only identity projection, mail delivery and rate-limit transport are fixtures. Invite routes/helper, crypto, engine and SQL are actual. */
import {vi} from 'vitest';
const ctx=vi.hoisted(()=>({url:'',actor:{id:'',org:'',role:'admin'},mail:[] as Array<{to:string;code?:string;url?:string;inviteId?:string}>,limit:true}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/server/supabase-admin',async()=>{
 const {pgSupabase}=await import('@/tests/db/x149-support');return {createSupabaseAdminClient:()=>pgSupabase(ctx.url,{kind:'service'})};
});
vi.mock('@/lib/server/auth',async()=>{
 const {pgSupabase}=await import('@/tests/db/x149-support');
 return {sameOrigin:(r:Request)=>new URL(r.url).origin==='https://tolra.example.test',forbiddenOrigin:()=>Response.json({error:'Forbidden'},{status:403}),isErrorResponse:(r:unknown)=>r instanceof Response,jsonError:(error:string,status:number)=>Response.json({error},{status}),readJson:async(r:Request)=>({ok:true,data:await r.json()}),requireProfile:async(roles:string[])=>roles.includes(ctx.actor.role)?{supabase:pgSupabase(ctx.url,{kind:'user',id:ctx.actor.id}),user:{id:ctx.actor.id},profile:{organization_id:ctx.actor.org,role:ctx.actor.role},session:null}:Response.json({error:'Forbidden'},{status:403})};
});
vi.mock('@/lib/server/login',()=>({withinLimit:async()=>ctx.limit,clientIp:()=> '203.0.113.42',LimiterUnavailableError:class extends Error{}}));
vi.mock('@/lib/integrations/invite-mail',()=>({sendInviteCodeEmail:async(input:{to:string;code:string})=>{ctx.mail.push(input);return {ok:true};},sendInviteLinkEmail:async(input:{to:string;url:string;inviteId:string})=>{ctx.mail.push(input);return {ok:true};}}));

export {ctx};
