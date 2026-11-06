// Disposable, immutable Code-baseline SQL diagnostics; these are defect reproductions, not passing release gates.
const {execFileSync}=require('node:child_process');
const {readFileSync,writeFileSync}=require('node:fs');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {Client}=require('pg');
const base='e7c4b6380964386e66e5d6a67ed37ad0aaed8da5';
const name='overnight_baseline_'+randomUUID().replaceAll('-','');
const admin=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:'postgres'});
const db=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:name});
const evidence={base,database:name,scope:'Synthetic disposable PostgreSQL; actual baseline SQL; no provider HTTP',files:[],probes:[]};
function source(file){const text=execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8',maxBuffer:8e6});evidence.files.push({file,sha256:createHash('sha256').update(text).digest('hex')});return text;}
async function probe(id,query,args=[]){try{const r=await db.query(query,args);evidence.probes.push({id,sqlstate:'00000',rows:r.rows});}catch(e){evidence.probes.push({id,sqlstate:e.code,message:e.message});}}
async function main(){await admin.connect();await admin.query(`create database ${name}`);await db.connect();try{
 await db.query(readFileSync('tests/reviews/xero-invite-adversarial/bootstrap.sql','utf8'));
 for(const file of execFileSync('git',['ls-tree','--name-only',`${base}:supabase/migrations`],{encoding:'utf8'}).trim().split('\n').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=137).sort())await db.query(source('supabase/migrations/'+file));
 const plan=JSON.parse(source('supabase/release-plan.json'));for(const p of [...plan.jnr_cutover_numbered_order,...plan.phases])await db.query(source(p.release));
 await probe('missing_guarded_invite_store',"select public.integration_invite_store_connection(null::text,null::uuid,null::uuid,null::text,null::text,null::text,null::text,null::text,null::text,null::timestamptz,null::integer)");
 await probe('missing_atomic_picker_claim',"select public.integration_xero_picker_claim('xero_picker_use',$1,60,1)",['a'.repeat(64)]);
 await probe('half_penny_rounding','select job_cost_round(1,2) as actual_pence,1 as required_pence');
 const org=randomUUID(),uid=randomUUID(),session=randomUUID(),ref=randomBytes(16).toString('base64url'),state=randomBytes(32).toString('hex');
 await db.query("insert into organizations(id,name,slug,status) values($1,'Synthetic Baseline Probe',$2,'active')",[org,'probe-'+org]);
 await db.query('insert into auth.users(id,email) values($1,$2)',[uid,uid+'@example.test']);
 await db.query("insert into user_profiles(id,email,full_name,role,organization_id,active,must_change_password) values($1,$2,'Synthetic','admin',$3,true,false)",[uid,uid+'@example.test',org]);
 await db.query("insert into organization_members(user_id,organization_id,role,active) values($1,$2,'admin',true)",[uid,org]);
 await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,uid]);await db.query('insert into security_audit.session_company(session_id,user_id,organization_id) values($1,$2,$3)',[session,uid,org]);
 await db.query('set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid,session_id:session,role:'authenticated',aal:'aal2',amr:[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]})]);
 const invite=(await db.query("select integration_invite_create('xero',$1,'bound@example.test') as r",[ref])).rows[0].r;
 await db.query('reset role');await db.query('set role service_role');await db.query('select integration_invite_code_issue($1,$2)',[ref,'a'.repeat(64)]);
 // Structural synthetic ciphertext: no decryption/provider exchange is part of this predicate diagnostic.
 await db.query("select integration_invite_code_verify($1,$2,$3,'v1.dGVzdA.dGVzdA.dGVzdA')",[ref,'a'.repeat(64),state]);await db.query('reset role');
 await db.query('set role authenticated');await probe('pending_oauth_revocation', 'select integration_invite_revoke($1) as revoked',[invite.id]);await db.query('reset role');
 const rows=(await db.query(readFileSync('supabase/verify/xero_invite_hardening_151.sql','utf8'))).rows;evidence.probes.push({id:'active_151_verifier',sqlstate:'00000',falseRows:rows.filter(r=>r.ok!==true)});
 }finally{await db.end();await admin.query(`drop database if exists ${name} with (force)`);await admin.end();writeFileSync('tests/reviews/overnight-151/evidence/baseline-probes.json',JSON.stringify(evidence,null,2)+'\n');}}
main().catch(e=>{console.error(e.code??e.message);process.exitCode=1});
