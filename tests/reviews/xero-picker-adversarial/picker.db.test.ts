/** Actual callback/choose routes, SQL nonce limiter, store RPC and MFA policy; only Xero and authenticated identity/assurance projection are fixtures. */
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {ctx} from './route.setup';
import {as,company,db,start,stop,type Actor} from './fixture';
import {GET,POST} from '@/app/api/integrations/xero/choose/route';
import {GET as callback} from '@/app/api/integrations/xero/callback/route';
import {sealPicker,openPicker,pickerCsrf,PICKER_COOKIE} from '@/lib/integrations/xero/picker';
import {hashKey} from '@/lib/server/login';
import {newAuthorisation} from '@/lib/integrations/xero/oauth';
import {encryptSecret} from '@/lib/integrations/crypto';
import {runXeroSweepPass} from '@/lib/integrations/xero-pass';
const SITE='https://tolra.example.test',KEY=Buffer.alloc(32,7);
let a:Actor,b:Actor,orgs:Array<{id:string;tenantId:string;tenantName:string}>,current:Array<Record<string,unknown>>,event:string,created:string,refreshFails:boolean,onRefresh:(()=>Promise<void>)|undefined;
const calls:Array<{url:string;method:string;body:string}>=[];
beforeAll(start);afterAll(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await stop();});
beforeEach(async()=>{a=await company('A');b=await company('B');ctx.actor=a;ctx.support=false;ctx.level='aal2';ctx.recentSeconds=0;ctx.limiterError=false;ctx.auditError=false;ctx.claimGate=null;calls.length=0;event=randomUUID();created=new Date().toISOString();refreshFails=false;onRefresh=undefined;
 orgs=[{id:randomUUID(),tenantId:randomUUID(),tenantName:'Synthetic A'},{id:randomUUID(),tenantId:randomUUID(),tenantName:'Synthetic B'}];current=orgs.map(o=>({...o,tenantType:'ORGANISATION',authEventId:event,createdDateUtc:created}));
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';calls.push({url,method,body:String(init?.body??'')});
  if(url==='https://identity.xero.com/connect/token'){if(onRefresh)await onRefresh();if(refreshFails)return Response.json({error:'invalid_grant',error_description:'synthetic-provider-secret'},{status:400});return Response.json({access_token:`e30.${Buffer.from(JSON.stringify({authentication_event_id:event})).toString('base64url')}.synthetic`,refresh_token:'synthetic-new-refresh',expires_in:1800});}
  if(url==='https://api.xero.com/connections')return Response.json(current);
  if(url.startsWith('https://api.xero.com/connections/')&&method==='DELETE')return new Response(null,{status:204});
  throw Error('Unexpected HTTP is blocked '+new URL(url).hostname);
 });
});
const offer=()=>({refreshToken:'synthetic-old-refresh',eventId:event,orgs});
function sealed(age=0){return sealPicker(a.org,a.id,offer(),KEY,Date.now()-age);}
function req(cookie:string,body?:unknown,origin=SITE){return new Request(SITE+'/api/integrations/xero/choose',{method:body===undefined?'GET':'POST',headers:{cookie:`${PICKER_COOKIE}=${cookie}`,origin,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const chosen=async(org=a.org)=>(await db.query("select tenant_id,status from integration_connections where organization_id=$1 and provider='xero'",[org])).rows;
const queue=async()=>(await db.query('select id,status,attempts,external_id from integration_sends where organization_id=$1 order by id',[a.org])).rows;
const nonceHits=async(n:string)=>(await db.query("select count(*)::int as n from auth_rate_limits where bucket='xero_picker_use' and key_hash=$1",[hashKey('xero_picker_use',n)])).rows[0].n;
async function pick(cookie=sealed()){const response=await GET(req(cookie.cookie));expect(response.status).toBe(200);const data=await response.json();return {cookie,data,body:{tenantId:orgs[0].tenantId,csrf:data.csrf}};}

it('callback offers only this consent, stores nothing, and sets a private path-limited ten-minute cookie',async()=>{
 const auth=newAuthorisation();await as(a,"select integration_oauth_begin('xero',$1,$2)",[auth.stateHash,encryptSecret(auth.verifier,{organizationId:a.org,provider:'xero',purpose:'pkce'},KEY)]);
 current.push({id:randomUUID(),tenantId:randomUUID(),tenantName:'Unrelated old consent',tenantType:'ORGANISATION',authEventId:randomUUID(),createdDateUtc:new Date(Date.now()-86400000).toISOString()});
 const r=await callback(new Request(SITE+'/api/integrations/xero/callback?'+new URLSearchParams({state:auth.state,code:'synthetic-code'})));
 expect(r.status).toBe(303);expect(r.headers.get('location')).toBe(SITE+'/admin/integrations/xero-organisation');expect(await chosen()).toEqual([]);
 const header=r.headers.get('set-cookie')!;for(const part of ['HttpOnly','Secure','SameSite=lax','Path=/api/integrations/xero','Max-Age=600'])expect(header.toLowerCase()).toContain(part.toLowerCase());
 const value=decodeURIComponent(header.split(';')[0].slice((PICKER_COOKIE+'=').length));const p=openPicker(value,KEY);expect(p.ok).toBe(true);if(!p.ok)throw Error('No offer');expect(p.payload.t.map(x=>x.t)).toEqual(orgs.map(o=>o.tenantId));expect(header).not.toContain('synthetic-new-refresh');
});
it('GET returns offered names and CSRF, never the token, connection secret or an implicit selected tenant',async()=>{const {data}=await pick();expect(data.organisations).toEqual(orgs.map(o=>({tenantId:o.tenantId,name:o.tenantName})));expect(data.selected).toBeUndefined();expect(JSON.stringify(data)).not.toMatch(/synthetic-old-refresh|synthetic-new-refresh|refreshToken/);});
it('an omitted or unoffered tenant is refused before claiming the nonce or contacting Xero',async()=>{const {cookie,data}=await pick();for(const body of [{csrf:data.csrf},{tenantId:randomUUID(),csrf:data.csrf}])expect((await POST(req(cookie.cookie,body))).status).toBe(400);expect(await nonceHits(cookie.payload.n)).toBe(0);expect(calls).toEqual([]);});
it('wrong and missing CSRF are refused without consuming the valid choice',async()=>{const {cookie,body}=await pick();expect((await POST(req(cookie.cookie,{...body,csrf:'wrong'}))).status).toBe(403);expect((await POST(req(cookie.cookie,{tenantId:body.tenantId}))).status).toBe(403);expect(await nonceHits(cookie.payload.n)).toBe(0);expect((await POST(req(cookie.cookie,body))).status).toBe(200);});
it('foreign company and other initiating admin cannot read or use the offer',async()=>{const {cookie,body}=await pick();ctx.actor=b;expect((await GET(req(cookie.cookie))).status).toBe(410);expect((await POST(req(cookie.cookie,body))).status).toBe(410);ctx.actor={...a,id:b.id};expect((await GET(req(cookie.cookie))).status).toBe(410);expect((await POST(req(cookie.cookie,body))).status).toBe(410);expect(calls).toEqual([]);expect(await chosen(b.org)).toEqual([]);});
it('support access and non-admin roles are refused before provider work',async()=>{const {cookie,body}=await pick();ctx.support=true;expect((await GET(req(cookie.cookie))).status).toBe(403);expect((await POST(req(cookie.cookie,body))).status).toBe(403);ctx.support=false;ctx.actor={...a,role:'office'};expect((await POST(req(cookie.cookie,body))).status).toBe(403);expect(calls).toEqual([]);});
it('actual forced recent-MFA policy rejects aal1 and a stale authenticator code without consuming the nonce',async()=>{const {cookie,body}=await pick();ctx.level='aal1';let r=await POST(req(cookie.cookie,body));expect(r.status).toBe(403);expect((await r.json()).code).toBe('mfa_required');ctx.level='aal2';ctx.recentSeconds=901;r=await POST(req(cookie.cookie,body));expect(r.status).toBe(403);expect((await r.json()).code).toBe('mfa_recent_required');expect(await nonceHits(cookie.payload.n)).toBe(0);expect(calls).toEqual([]);});
it('actual same-origin policy rejects a cross-origin submission before nonce or provider work',async()=>{const {cookie,body}=await pick();expect((await POST(req(cookie.cookie,body,'https://attacker.example.test'))).status).toBe(403);expect(await nonceHits(cookie.payload.n)).toBe(0);expect(calls).toEqual([]);});
it('expired and tampered cookies fail closed',async()=>{const old=sealed(601000),fresh=sealed();expect((await GET(req(old.cookie))).status).toBe(410);expect((await POST(req(old.cookie,{tenantId:orgs[0].tenantId,csrf:pickerCsrf(old.payload,KEY)}))).status).toBe(410);expect((await GET(req(fresh.cookie+'tampered'))).status).toBe(410);expect(calls).toEqual([]);});
it('sequential replay is refused by the REAL database limiter after the first successful choice',async()=>{const {cookie,body}=await pick();expect((await POST(req(cookie.cookie,body))).status).toBe(200);const count=calls.length;expect((await POST(req(cookie.cookie,body))).status).toBe(410);expect(calls).toHaveLength(count);expect(await chosen()).toHaveLength(1);});
it('two independent SQL transactions cannot both claim a single-use picker nonce',async()=>{
 const n=sealed().payload.n,one=new Client({connectionString:ctx.url}),two=new Client({connectionString:ctx.url});await one.connect();await two.connect();
 try{await one.query('begin');await two.query('begin');await one.query('set local role service_role');await two.query('set local role service_role');
  const pids=await Promise.all([one.query('select pg_backend_pid() as id'),two.query('select pg_backend_pid() as id')]);expect(pids[0].rows[0].id).not.toBe(pids[1].rows[0].id);
  // Both RPC transactions have executed, neither has committed yet: a legal concurrency interleaving.
  const result=await Promise.all([one,two].map(c=>c.query("select auth_rate_hit('xero_picker_use',$1,3600,1) as allowed",[hashKey('xero_picker_use',n)])));
  expect(result.filter(r=>r.rows[0].allowed),'single-use cannot be implemented by a non-atomic rate counter').toHaveLength(1);
 }finally{await one.query('rollback');await two.query('rollback');await one.end();await two.end();}
});
it('two concurrent actual picker POSTs cannot both pass a single-use claim before either RPC transaction commits',async()=>{
 const {cookie,body}=await pick();let arrivals=0;let release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
 ctx.claimGate=async()=>{if(++arrivals===2)release();await both;};
 try{const results=await Promise.all([POST(req(cookie.cookie,body)),POST(req(cookie.cookie,body))]);
  expect(arrivals).toBe(2);expect(results.filter(r=>r.status===200),'both actual routes must not accept the same sealed choice').toHaveLength(1);
 }finally{ctx.claimGate=null;}
});
it('limiter outage refuses without contacting Xero and permits a later explicit retry',async()=>{const {cookie,body}=await pick();ctx.limiterError=true;expect((await POST(req(cookie.cookie,body))).status).toBe(503);expect(calls).toEqual([]);ctx.limiterError=false;expect((await POST(req(cookie.cookie,body))).status).toBe(200);});
it('successful selection keeps transfers OFF, held documents unchanged, and the sweep sends nothing',async()=>{await db.query("insert into integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) values($1,'xero','invoice',$2,'SYN-PICKER-HELD','create')",[a.org,randomUUID()]);const before=await queue(),{cookie,body}=await pick();const r=await POST(req(cookie.cookie,body));expect(r.status).toBe(200);expect((await chosen())[0].tenant_id).toBe(body.tenantId);expect((await db.query('select integration_xero_transfer_enabled($1) as enabled',[a.org])).rows[0].enabled).toBe(false);expect(await queue()).toEqual(before);const count=calls.length;await runXeroSweepPass();expect(calls).toHaveLength(count);expect(await queue()).toEqual(before);expect(r.headers.get('set-cookie')).toContain('Max-Age=0');});
it('actual choice and connection audit rows are recorded under the correct company/admin',async()=>{const {cookie,body}=await pick();expect((await POST(req(cookie.cookie,body))).status).toBe(200);const rows=(await db.query("select actor_user_id,organization_id,action,metadata from security_audit.audit_log where organization_id=$1 and action in ('INTEGRATION_CONNECTED','ORGANIZATION_SETTINGS_UPDATE')",[a.org])).rows;expect(rows.some(r=>r.action==='INTEGRATION_CONNECTED'&&(r.actor_user_id===a.id||r.metadata?.by===a.id))).toBe(true);expect(rows.some(r=>r.action==='ORGANIZATION_SETTINGS_UPDATE'&&r.actor_user_id===a.id)).toBe(true);expect(JSON.stringify(rows)).not.toContain('synthetic-old-refresh');});
it('changed or disappeared offered connection IDs are refused after the live re-list',async()=>{const {cookie,body}=await pick();current[0]={...current[0],id:randomUUID()};expect((await POST(req(cookie.cookie,body))).status).toBe(409);expect(await chosen()).toEqual([]);});
it('an offered tenant owned by another company cannot be claimed or deleted',async()=>{await db.query("insert into integration_connections(organization_id,provider,status,tenant_id,tenant_name,connected_by,connected_at) values($1,'xero','connected',$2,'Synthetic B',$3,now())",[b.org,orgs[0].tenantId,b.id]);const {cookie,body}=await pick();expect((await POST(req(cookie.cookie,body))).status).toBe(409);expect(await chosen()).toEqual([]);expect((await chosen(b.org))[0].tenant_id).toBe(orgs[0].tenantId);expect(calls.some(c=>c.method==='DELETE'&&c.url.endsWith(orgs[0].id))).toBe(false);});
it('creator demotion during token refresh is refused by the final SQL write',async()=>{const {cookie,body}=await pick();onRefresh=async()=>{await db.query("update organization_members set role='office' where organization_id=$1 and user_id=$2",[a.org,a.id]);};expect((await POST(req(cookie.cookie,body))).status).toBe(409);expect(await chosen()).toEqual([]);});
it('provider refresh failure cannot store anything or expose provider error text',async()=>{const {cookie,body}=await pick();refreshFails=true;const r=await POST(req(cookie.cookie,body));expect(r.status).toBe(409);expect(await r.text()).not.toContain('synthetic-provider-secret');expect(await chosen()).toEqual([]);});
it('unselected consent connections are removed even when the admin chooses after six minutes within the ten-minute offer',async()=>{created=new Date(Date.now()-360000).toISOString();current=current.map(c=>({...c,createdDateUtc:created}));const {cookie,body}=await pick(sealed(360000));expect((await POST(req(cookie.cookie,body))).status).toBe(200);expect(calls.some(c=>c.method==='DELETE'&&c.url.endsWith(orgs[1].id)),'UI promises the unselected organisation is disconnected').toBe(true);});
