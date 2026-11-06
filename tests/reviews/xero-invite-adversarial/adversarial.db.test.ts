/** Independent actual-route/real-PostgreSQL proof. Only external Xero, mail transport, identity projection and rate-limit transport are stubbed. */
import {randomUUID,createHash} from 'node:crypto';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ctx} from './route.setup';
import {company,db,start,stop,sql,release151,verify151,rollback151,type Actor} from './fixture';
import {POST as create,DELETE as revoke} from '@/app/api/integrations/invite/route';
import {GET as page,POST as submit} from '@/app/api/integrations/invite/[ref]/route';
import {GET as callback} from '@/app/api/integrations/invite/callback/route';
import {inviteCodeHash,inviteVerifierContext} from '@/lib/integrations/invite';
import {encryptSecret} from '@/lib/integrations/crypto';
import {newAuthorisation} from '@/lib/integrations/xero/oauth';
import {runXeroSweepPass} from '@/lib/integrations/xero-pass';
const SITE='https://tolra.example.test',KEY=Buffer.alloc(32,7);
const calls:Array<{url:string;method:string}>=[];
let a:Actor,b:Actor,chosenTenant:string,expectedChallenge:string|undefined;
let tenantCount=1,chosenName='Synthetic A';
let onToken:(()=>Promise<void>)|undefined;
type Invite={id:string;ref:string;email:string};
beforeAll(start);afterAll(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await stop();});
beforeEach(async()=>{
 a=await company('A');b=await company('B');ctx.actor=a;ctx.mail.length=0;ctx.limit=true;calls.length=0;chosenTenant=randomUUID();tenantCount=1;chosenName='Synthetic A';expectedChallenge=undefined;onToken=undefined;
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input),method=init?.method??'GET';calls.push({url,method});
  if(url==='https://identity.xero.com/connect/token'){
   const form=new URLSearchParams(init?.body as URLSearchParams);expect(form.get('redirect_uri')).toBe(SITE+'/api/integrations/invite/callback');expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(expectedChallenge);if(onToken)await onToken();return Response.json({access_token:`e30.${Buffer.from(JSON.stringify({authentication_event_id:'synthetic-event'})).toString('base64url')}.synthetic`,refresh_token:'synthetic-refresh',expires_in:1800});}
  if(url==='https://api.xero.com/connections')return Response.json(Array.from({length:tenantCount},(_,n)=>({id:randomUUID(),tenantId:n===0?chosenTenant:randomUUID(),tenantName:chosenName,tenantType:'ORGANISATION',authEventId:'synthetic-event',createdDateUtc:new Date().toISOString()})));
  if(url.startsWith('https://api.xero.com/connections/')&&method==='DELETE')return new Response(null,{status:204});
  throw Error('BLOCKED unexpected HTTP transport '+new URL(url).hostname);
 });
});
const params=(ref:string)=>({params:Promise.resolve({ref})});
const request=(ref:string,action:string,code='',extra:Record<string,string>={})=>{const form=new FormData();for(const [k,v] of Object.entries({action,code,...extra}))form.set(k,v);return new Request(`${SITE}/api/integrations/invite/${ref}`,{method:'POST',body:form});};
const oauth=(r:Response)=>r.status===303&&r.headers.get('location')?.startsWith('https://login.xero.com/identity/connect/authorize')===true;
async function invite(email='accountant@example.test'):Promise<Invite>{
 ctx.actor=a;const response=await create(new Request(SITE+'/api/integrations/invite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})}));
 expect(response.status,'fixture: a valid company admin must be able to create an invite').toBe(200);
 const body=await response.json(),mail=ctx.mail.find(m=>m.inviteId===body.id)!;expect(mail?.to).toBe(email);expect(body.url).toBeUndefined();return {id:body.id,ref:new URL(mail.url!).pathname.split('/').at(-1)!,email};
}
async function send(i:Invite,extra:Record<string,string>={}){const response=await submit(request(i.ref,'send','',extra),params(i.ref));expect(response.status).toBe(200);const mail=ctx.mail.filter(m=>m.code&&m.to===i.email).at(-1)!;expect(mail).toBeDefined();return mail.code!;}
const verify=async(i:Invite,code:string,extra:Record<string,string>={})=>{const response=await submit(request(i.ref,'verify',code,extra),params(i.ref));if(oauth(response))expectedChallenge=new URL(response.headers.get('location')!).searchParams.get('code_challenge')!;return response;};
async function begin(i:Invite){const code=await send(i),response=await verify(i,code);expect(oauth(response)).toBe(true);return {code,response,state:new URL(response.headers.get('location')!).searchParams.get('state')!};}
const finish=(state:string,extra:Record<string,string>={})=>callback(new Request(SITE+'/api/integrations/invite/callback?'+new URLSearchParams({state,code:'synthetic-code',...extra})));
const connections=async(org=a.org)=>(await db.query("select organization_id,tenant_id,status from integration_connections where organization_id=$1 and provider='xero'",[org])).rows;
const queue=async()=>(await db.query('select id,status,attempts,external_id from integration_sends where organization_id=$1 order by id',[a.org])).rows;
const logs=async()=>(await db.query('select correlation_id,step,reason,ref_hash,organization_id from security_audit.integration_invite_refusals order by id')).rows;
const expired=async(i:Invite)=>db.query("update integration_connect_invites set created_at=now()-interval '23 hours',expires_at=now()-interval '1 second' where id=$1",[i.id]);

describe('1 recipient identity and forwarded invitations',()=>{
 it('a forwarded reference without its bound-address code cannot start OAuth',async()=>{const i=await invite();expect(oauth(await verify(i,''))).toBe(false);expect(calls).toEqual([]);expect(await connections()).toEqual([]);});
 it('the code only goes to the bound address even when the forwarded-link visitor supplies another address',async()=>{const i=await invite(),code=await send(i,{email:'attacker@example.test',recipient:'attacker@example.test'});expect(ctx.mail.filter(m=>m.code).map(m=>m.to)).toEqual([i.email]);const response=await page(new Request(SITE+'/api/integrations/invite/'+i.ref),params(i.ref));expect(await response.text()).not.toContain(code);});
 it('another person\'s code cannot redeem a different invitation',async()=>{const i=await invite('first@example.test'),j=await invite('second@example.test'),code=await send(i);expect(oauth(await verify(j,code))).toBe(false);expect(await connections()).toEqual([]);});
 it('a wrong code is refused; the valid bound code remains a positive control',async()=>{const i=await invite(),code=await send(i),wrong=(code[0]==='0'?'1':'0')+code.slice(1);expect(oauth(await verify(i,wrong))).toBe(false);expect(oauth(await verify(i,code))).toBe(true);});
 it('five wrong codes lock the invite even if the correct code is subsequently supplied',async()=>{const i=await invite(),code=await send(i),wrong=(code[0]==='0'?'1':'0')+code.slice(1);for(let n=0;n<5;n++)await verify(i,wrong);expect(oauth(await verify(i,code))).toBe(false);expect((await db.query('select locked_at is not null as locked from integration_connect_invites where id=$1',[i.id])).rows[0].locked).toBe(true);});
});

describe('2 replay, actual concurrent redemption, expiry and revocation',()=>{
 it('recipient code and invitation redemption are single use',async()=>{const i=await invite(),{code}=await begin(i);expect(oauth(await verify(i,code))).toBe(false);});
 it('two actual route requests concurrently redeeming the same code yield exactly one OAuth redirect',async()=>{const i=await invite(),code=await send(i);const results=await Promise.all([verify(i,code),verify(i,code)]);expect(results.filter(oauth)).toHaveLength(1);});
 it('two independent PostgreSQL sessions cannot both redeem the same bound code',async()=>{
  const i=await invite(),code=await send(i),one=new Client({connectionString:ctx.url}),two=new Client({connectionString:ctx.url});await one.connect();await two.connect();
  try{const pids=await Promise.all([one.query('select pg_backend_pid() as p'),two.query('select pg_backend_pid() as p')]);expect(pids[0].rows[0].p).not.toBe(pids[1].rows[0].p);
   await one.query('set role service_role');await two.query('set role service_role');const results=await Promise.all([one,two].map(c=>{const auth=newAuthorisation();return c.query('select integration_invite_code_verify($1,$2,$3,$4) as r',[i.ref,inviteCodeHash(KEY,i.ref,code),auth.stateHash,encryptSecret(auth.verifier,inviteVerifierContext(auth.stateHash),KEY)]);}));expect(results.filter(r=>r.rows[0].r.ok)).toHaveLength(1);
  }finally{await one.end();await two.end();}
 });
 it('replaying the OAuth callback repeats neither token exchange nor connection storage',async()=>{const i=await invite(),{state}=await begin(i);await finish(state);expect(await connections()).toHaveLength(1);const before=calls.length;await finish(state);expect(calls).toHaveLength(before);expect(await connections()).toHaveLength(1);});
 it('expired invite is refused at page, code request and verification',async()=>{const i=await invite(),code=await send(i);await expired(i);expect((await page(new Request(SITE+'/api/integrations/invite/'+i.ref),params(i.ref))).status).toBe(404);expect((await submit(request(i.ref,'send'),params(i.ref))).status).toBe(404);expect(oauth(await verify(i,code))).toBe(false);});
 it('a code expiring after delivery is refused at verification',async()=>{const i=await invite(),code=await send(i);await db.query("update integration_connect_invites set code_expires_at=now()-interval '1 second' where id=$1",[i.id]);expect(oauth(await verify(i,code))).toBe(false);});
 it('parent invite expiry is enforced again after OAuth begins',async()=>{const i=await invite(),{state}=await begin(i);await expired(i);await finish(state);expect(calls).toEqual([]);expect(await connections()).toEqual([]);});
 it('invite expiry during the provider token exchange is enforced again before connection storage',async()=>{const i=await invite(),{state}=await begin(i);onToken=async()=>{await expired(i);};await finish(state);expect(await connections(),'the callback consumed state before expiry, but the invite expired before storage').toEqual([]);});
 it('revocation during token exchange is enforced atomically at final storage',async()=>{const i=await invite(),{state}=await begin(i);onToken=async()=>{ctx.actor=a;expect((await revoke(new Request(SITE+'/api/integrations/invite?id='+i.id,{method:'DELETE'}))).status).toBe(200);};await finish(state);expect(await connections()).toEqual([]);});
 it('state expiry during token exchange prevents final storage',async()=>{const i=await invite(),{state}=await begin(i);onToken=async()=>{await db.query("update integration_oauth_states set created_at=now()-interval '15 minutes',expires_at=now()-interval '1 second' where state_hash=$1",[createHash('sha256').update(state).digest('hex')]);};await finish(state);expect(await connections()).toEqual([]);});
 it('OAuth state expiry is enforced at callback',async()=>{const i=await invite(),{state}=await begin(i);await db.query("update integration_oauth_states set created_at=now()-interval '15 minutes',expires_at=now()-interval '1 second' where state_hash=$1",[createHash('sha256').update(state).digest('hex')]);await finish(state);expect(calls).toEqual([]);expect(await connections()).toEqual([]);});
 it('revoking a delivered code before redemption prevents OAuth',async()=>{const i=await invite(),code=await send(i);ctx.actor=a;expect((await revoke(new Request(SITE+'/api/integrations/invite?id='+i.id,{method:'DELETE'}))).status).toBe(200);expect(oauth(await verify(i,code))).toBe(false);});
 it('revocation remains possible during OAuth and prevents the final connection',async()=>{const i=await invite(),{state}=await begin(i);ctx.actor=a;const response=await revoke(new Request(SITE+'/api/integrations/invite?id='+i.id,{method:'DELETE'}));await finish(state);expect.soft(response.status,'a pending OAuth consent must remain revocable').toBe(200);expect.soft(await connections(),'a refused revoke must not leave a usable callback').toEqual([]);});
});

describe('3 company, creating-admin and selected-Xero-organisation bindings',()=>{
 it('the signed-in creator cannot move an invite into a request-supplied company',async()=>{ctx.actor=a;const r=await create(new Request(SITE+'/api/integrations/invite',{method:'POST',body:JSON.stringify({email:'accountant@example.test',organization_id:b.org})}));expect(r.status).toBe(400);expect((await db.query('select id from integration_connect_invites where organization_id=$1',[b.org])).rows).toEqual([]);});
 it('company B cannot revoke company A\'s invitation',async()=>{const i=await invite();ctx.actor=b;expect((await revoke(new Request(SITE+'/api/integrations/invite?id='+i.id,{method:'DELETE'}))).status).toBe(404);expect(oauth(await verify(i,await send(i)))).toBe(true);});
 it('changing a hidden company/admin form value cannot change the binding',async()=>{const i=await invite(),code=await send(i),response=await verify(i,code,{organization_id:b.org,user_id:b.id});expect(oauth(response)).toBe(true);const state=new URL(response.headers.get('location')!).searchParams.get('state')!;await finish(state);expect(await connections()).toHaveLength(1);expect(await connections(b.org)).toEqual([]);});
 it('a demoted creating admin cannot complete a previously-started OAuth flow',async()=>{const i=await invite(),{state}=await begin(i);await db.query("update organization_members set role='office' where organization_id=$1 and user_id=$2",[a.org,a.id]);await finish(state);expect(calls).toEqual([]);expect(await connections()).toEqual([]);});
 it('demoting the creator during token exchange is enforced at final connection storage',async()=>{const i=await invite(),{state}=await begin(i);onToken=async()=>{await db.query("update organization_members set role='office' where organization_id=$1 and user_id=$2",[a.org,a.id]);};await finish(state);expect(await connections()).toEqual([]);});
 it('a Xero organisation already bound to company B cannot be stored for company A',async()=>{const foreign=randomUUID();await db.query("insert into integration_connections(organization_id,provider,status,tenant_id,tenant_name,connected_by,connected_at) values($1,'xero','connected',$2,'Synthetic B',$3,now())",[b.org,foreign,b.id]);const i=await invite(),{state}=await begin(i);chosenTenant=foreign;await finish(state);expect(await connections()).toEqual([]);expect((await connections(b.org))[0].tenant_id).toBe(foreign);});
 it.each([0,2])('selecting %s Xero organisations is refused without storing a connection',async count=>{const i=await invite(),{state}=await begin(i);tenantCount=count;await finish(state);expect(await connections()).toEqual([]);});
 it('consent for one unbound but incorrect Xero organisation requires an explicit company identity decision before storing',async()=>{const i=await invite(),{state}=await begin(i);chosenTenant=randomUUID();chosenName='Unrelated Company Ltd';await finish(state);expect(await connections(),'single result is not proof it belongs to the invited company').toEqual([]);});
});

describe('4 OAuth state, PKCE, exact redirects and refusal security log',()=>{
 it('unknown state never reaches the token endpoint and has a traceable security refusal',async()=>{await finish('synthetic-unknown-state');expect(calls).toEqual([]);expect((await logs()).at(-1)).toMatchObject({step:'callback',reason:'callback_state'});});
 it('another state\'s PKCE ciphertext cannot be substituted',async()=>{const i=await invite(),{state}=await begin(i);await db.query('update integration_oauth_states set verifier_enc=$1 where state_hash=$2',[encryptSecret('synthetic-verifier',inviteVerifierContext('b'.repeat(64)),KEY),createHash('sha256').update(state).digest('hex')]);await finish(state);expect(calls).toEqual([]);expect(await connections()).toEqual([]);});
 it('request-supplied redirect destinations do not change the exact approved callback',async()=>{const i=await invite(),code=await send(i);const r=await verify(i,code,{redirect_uri:'https://attacker.example.test/callback',returnTo:'https://attacker.example.test'});expect(new URL(r.headers.get('location')!).searchParams.get('redirect_uri')).toBe(SITE+'/api/integrations/invite/callback');});
 it('missing exact redirect allow list fails closed before consuming the invitation',async()=>{const i=await invite(),code=await send(i);vi.stubEnv('XERO_INVITE_REDIRECT_URIS','');try{expect(oauth(await verify(i,code))).toBe(false);expect((await db.query('select used_at from integration_connect_invites where id=$1',[i.id])).rows[0].used_at).toBeNull();}finally{vi.stubEnv('XERO_INVITE_REDIRECT_URIS',SITE+'/api/integrations/invite/callback');}});
 it('every malformed-code refusal has a security-log correlation id without keeping the code or reference',async()=>{const i=await invite(),before=(await logs()).length;const response=await verify(i,'not-a-code');const after=await logs();expect(response.status).toBe(400);expect(after.length).toBeGreaterThan(before);const row=after.at(-1)!;expect(row.correlation_id).toMatch(/^[0-9a-f-]{36}$/);expect(await response.clone().text()).toContain(row.correlation_id);expect(JSON.stringify(row)).not.toContain(i.ref);expect(JSON.stringify(row)).not.toContain('not-a-code');});
 it('unknown-action refusals are security logged, not silent responses',async()=>{const i=await invite(),before=(await logs()).length;await submit(request(i.ref,'unexpected'),params(i.ref));expect((await logs()).length).toBeGreaterThan(before);});
 it('missing redirect-allow-list refusal is security logged with a correlation id',async()=>{const i=await invite(),code=await send(i),before=(await logs()).length;vi.stubEnv('XERO_INVITE_REDIRECT_URIS','');try{const r=await verify(i,code);expect(r.status).toBe(503);expect((await logs()).length).toBeGreaterThan(before);}finally{vi.stubEnv('XERO_INVITE_REDIRECT_URIS',SITE+'/api/integrations/invite/callback');}});
 it('wrong-code logging keeps only reference hash, correlation and reason, never OTP/full recipient/state',async()=>{const i=await invite(),code=await send(i),wrong=(code[0]==='0'?'1':'0')+code.slice(1);const response=await verify(i,wrong),row=(await logs()).at(-1)!;expect(row.reason).toBe('wrong_code');expect(await response.text()).toContain(row.correlation_id);for(const secret of [code,wrong,i.ref,i.email])expect(JSON.stringify(row)).not.toContain(secret);});
});

describe('5 successful consent keeps transfers OFF and held documents held',()=>{
 it('consent alone neither activates transfers nor releases held pending sends, including a subsequent sweep',async()=>{await db.query("insert into integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) values($1,'xero','invoice',$2,'SYN-HELD','create')",[a.org,randomUUID()]);const before=await queue(),i=await invite(),{state}=await begin(i);await finish(state);expect(await connections()).toHaveLength(1);expect((await db.query('select integration_xero_transfer_enabled($1) as enabled',[a.org])).rows[0].enabled).toBe(false);expect(await queue()).toEqual(before);const count=calls.length;await runXeroSweepPass();expect(calls).toHaveLength(count);expect(await queue()).toEqual(before);});
});

describe('6 migration 151 actual verification and rollback',()=>{
 it('the actual verification file returns true on every row',async()=>{const rows=(await db.query(sql(verify151))).rows;expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.ok===true)).toBe(true);});
 it('rollback refuses open invitations, then succeeds after they are cancelled; reapplying restores verified 151',async()=>{await invite();await expect(db.query(sql(rollback151))).rejects.toThrow(/open connect invites/);await db.query('rollback');await db.query("update integration_connect_invites set revoked_at=now(),revoke_reason='cancelled',code_hash=null where revoked_at is null");const audit=(await db.query('select count(*)::int as n from security_audit.audit_log')).rows[0].n;await db.query(sql(rollback151));expect((await db.query("select to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') is null as gone")).rows[0].gone).toBe(true);expect((await db.query('select count(*)::int as n from security_audit.audit_log')).rows[0].n).toBe(audit);await db.query(sql(release151));expect((await db.query(sql(verify151))).rows.every(r=>r.ok===true)).toBe(true);});
});
