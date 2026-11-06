/** Public-interface preparation probes, not verification of unpublished 151. No HTTP transport is available. */
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {afterAll,beforeEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const spies=vi.hoisted(()=>({complete:vi.fn()}));
vi.mock('@/lib/integrations/server',()=>{
 class DbError extends Error{constructor(message:string,readonly code?:string,readonly hint?:string){super(message);}}
 return {DbError,completeConnect:spies.complete,serviceDb:(client:SupabaseClient)=>({rpc:async(fn:string,args:Record<string,unknown>)=>{const r=await client.rpc(fn,args);if(r.error)throw new DbError(r.error.message,r.error.code,r.error.hint);return r.data;}})};
});
import {decryptSecret,encryptSecret} from '@/lib/integrations/crypto';
import {finishInviteConnect,hashInviteToken,inviteConfig,inviteVerifierContext,newInviteToken,peekInvite,redeemInvite,inviteCodeHash,inviteRedirectAllowed} from '@/lib/integrations/invite';
import {authorizeUrl,hashState,newAuthorisation} from '@/lib/integrations/xero/oauth';
import {validRedirectUri} from '@/lib/integrations/app-credentials';
const key=Buffer.alloc(32,7),token='A'.repeat(22),code='31415926';
const env={XERO_INVITE_REDIRECT_URIS:'https://tolra.example.test/api/integrations/invite/callback'};
const ready={key,config:{clientId:'synthetic-client',clientSecret:'synthetic-client-secret',redirectUri:'https://tolra.example.test/api/integrations/xero/callback'}};
afterAll(()=>vi.unstubAllGlobals());
const rpc=vi.fn();
const service={rpc} as unknown as SupabaseClient;
beforeEach(()=>{rpc.mockReset();spies.complete.mockReset().mockResolvedValue({ok:true,tenantName:'Synthetic'});vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network: preparation tests are offline');}));});
it('tokens are fresh 32-byte URL-safe values; only their SHA-256 enters the existing SQL interface',async()=>{
 const a=newInviteToken(),b=newInviteToken();expect(a.token).not.toBe(b.token);expect(Buffer.from(a.token,'base64url')).toHaveLength(32);
 expect(a.tokenHash).toBe(createHash('sha256').update(a.token).digest('hex'));
 expect(hashInviteToken(a.token)).toBe(a.tokenHash);
});
it.each(['','../token','A'.repeat(42),'A'.repeat(44),'<script>'.padEnd(43,'A')])('malformed link %j never reaches a privileged RPC',async bad=>{
 expect(await peekInvite(service,bad)).toBeNull();expect(await redeemInvite(service,bad,code,ready,env)).toMatchObject({ok:false,reason:'invalid'});expect(rpc.mock.calls.some(c=>c[0]==='integration_invite_code_verify')).toBe(false);
});
it('PKCE uses S256 and fresh state; the real encrypted verifier is bound to that state only',async()=>{
 rpc.mockResolvedValue({data:{ok:true},error:null});const result=await redeemInvite(service,token,code,ready,env);expect(result.ok).toBe(true);if(!result.ok)throw Error('No authorisation');
 const url=new URL(result.url),args=rpc.mock.calls[0][1] as {p_ref:string;p_code_hash:string;p_state_hash:string;p_verifier_enc:string};
 expect(url.origin+url.pathname).toBe('https://login.xero.com/identity/connect/authorize');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
 expect(url.searchParams.get('redirect_uri')).toBe('https://tolra.example.test/api/integrations/invite/callback');
 expect(args.p_ref).toBe(token);expect(args.p_code_hash).toBe(inviteCodeHash(key,token,code));expect(args.p_state_hash).toBe(hashState(url.searchParams.get('state')!));
 const verifier=decryptSecret(args.p_verifier_enc,inviteVerifierContext(args.p_state_hash),key);
 expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
 expect(()=>decryptSecret(args.p_verifier_enc,inviteVerifierContext('b'.repeat(64)),key)).toThrow();expect(url.toString()).not.toContain(ready.config.clientSecret);expect(url.toString()).not.toContain(verifier);
});
it('a refused or expired SQL redemption cannot produce an OAuth redirect',async()=>{
 rpc.mockResolvedValue({data:null,error:{code:'42501',hint:'invite_invalid',message:'Synthetic refusal'}});
 expect(await redeemInvite(service,token,code,ready,env)).toMatchObject({ok:false,reason:'invalid'});expect(spies.complete).not.toHaveBeenCalled();
});
it('an unknown/consumed callback state never reaches token exchange or connection storage',async()=>{
 rpc.mockResolvedValue({data:null,error:null});expect(await finishInviteConnect(service,'synthetic-state','synthetic-code',ready,{env})).toMatchObject({ok:false,reason:'expired'});
 expect(spies.complete).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('swapping another state\'s ciphertext is rejected before connection completion',async()=>{
 const cipher=encryptSecret('synthetic-verifier',inviteVerifierContext(hashState('state-a')),key);
 rpc.mockResolvedValue({data:{organization_id:'synthetic-org',user_id:'synthetic-admin',verifier_enc:cipher},error:null});
 await expect(finishInviteConnect(service,'state-b','synthetic-code',ready,{env})).rejects.toThrow();expect(spies.complete).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('callback completion uses the consumed company/admin, never request-supplied identities',async()=>{
 const state='synthetic-state',verifier='synthetic-verifier';
 rpc.mockResolvedValue({data:{organization_id:'company-a',user_id:'admin-a',verifier_enc:encryptSecret(verifier,inviteVerifierContext(hashState(state)),key)},error:null});
 await finishInviteConnect(service,state,'synthetic-code',ready,{env});
 expect(spies.complete).toHaveBeenCalledWith(service,'company-a','admin-a',verifier,'synthetic-code',{config:inviteConfig(ready.config),key},{env,inviteStateHash:hashState(state)});
});
it.each(['/api/integrations/xero/callback/extra','/prefix/api/integrations/xero/callback','/api/integrations/xero/callback?next=https://attacker.example.test','/api/integrations/xero/callback#fragment'])('redirect config rejects non-exact callback path/query %s',suffix=>{
 expect(validRedirectUri('xero',`https://tolra.example.test${suffix}`)).toBeNull();
});
it('the configured callback and PKCE inputs are preserved exactly in the authorization request',()=>{
 const auth=newAuthorisation(),config=inviteConfig(ready.config),url=new URL(authorizeUrl(config,auth.state,auth.challenge));
 expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);expect(url.searchParams.get('state')).toBe(auth.state);expect(url.searchParams.get('code_challenge')).toBe(auth.challenge);
});

it('the exact invite redirect allow list rejects lookalikes, userinfo, non-normal forms, query/fragment and wildcard entries',()=>{
 const allowed=env.XERO_INVITE_REDIRECT_URIS;expect(inviteRedirectAllowed(allowed,env)).toBe(true);
 for(const value of [allowed+'/',allowed+'?next=elsewhere',allowed+'#x','https://tolra.example.test.attacker.example.test/api/integrations/invite/callback','https://user@tolra.example.test/api/integrations/invite/callback'])expect(inviteRedirectAllowed(value,env)).toBe(false);
 for(const value of ['http://tolra.example.test/api/integrations/invite/callback','https://*.example.test/api/integrations/invite/callback','https://TOLRA.example.test/api/integrations/invite/callback',allowed+'?x=y',allowed+'#x'])expect(inviteRedirectAllowed(value,{XERO_INVITE_REDIRECT_URIS:value})).toBe(false);
 expect(inviteRedirectAllowed(allowed,{})).toBe(false);
});
it('one-time code hashes are bound to both the invitation reference and server key',()=>{
 expect(inviteCodeHash(key,token,code)).not.toBe(inviteCodeHash(key,'B'.repeat(22),code));
 expect(inviteCodeHash(key,token,code)).not.toBe(inviteCodeHash(Buffer.alloc(32,8),token,code));
});
