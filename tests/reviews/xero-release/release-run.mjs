import pg from 'pg';
import {spawnSync} from 'node:child_process';
import {readFile, readdir,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
const root=process.env.XERO_REVIEW_ROOT??'/workspace/work/xero-candidate-snapshot';
const out=path.resolve('tests/reviews/xero-release/evidence');await mkdir(out,{recursive:true});
const name='xero_verify_'+randomUUID().replaceAll('-','');
const admin=new pg.Client({host:'127.0.0.1',port:55449,user:'xero_test',database:'postgres'});await admin.connect();await admin.query(`create database ${name}`);
const db=new pg.Client({host:'127.0.0.1',port:55449,user:'xero_test',database:name});await db.connect();
const receipt={subject:'e42d927383513d1b98ce9cfca444884475622e2f',database:name,server:(await db.query('select version() as v')).rows[0].v,events:[],failed:0};
const record=async e=>{receipt.events.push(e);if(e.ok===false)receipt.failed++;await writeFile(path.join(out,'release-run.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(e));};
const file=async p=>readFile(path.join(root,p),'utf8');
async function apply(p,kind='apply') {const sql=await file(p),sha256=createHash('sha256').update(sql).digest('hex');try{await db.query(sql);await record({kind,file:p,sha256,ok:true});}catch(e){await db.query('rollback');await record({kind,file:p,sha256,ok:false,error:e.message,code:e.code});throw e;}}
async function verify(p){const sql=await file(p);const result=await db.query(sql);const last=Array.isArray(result)?result.at(-1):result;const bools=last.fields.filter(f=>f.dataTypeID===16).map(f=>f.name);const ok=last.rows.length>0&&bools.length>0&&last.rows.every(r=>bools.every(k=>r[k]===true));await record({kind:'verify',file:p,sha256:createHash('sha256').update(sql).digest('hex'),ok,rows:last.rows});if(!ok)throw Error('Verification failed: '+p);}
try{
 await db.query(await readFile('tests/reviews/xero-release/bootstrap.sql','utf8'));
 for(const p of (await readdir(path.join(root,'supabase/migrations'))).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=137).sort())await apply('supabase/migrations/'+p,'baseline');
 const plan=JSON.parse(await file('supabase/release-plan.json'));const releases=[...plan.jnr_cutover_numbered_order,...plan.phases];
 const requested=[138,140,141,143,144,145,146,147,149,150];if(JSON.stringify(releases.map(r=>r.number))!==JSON.stringify(requested))throw Error('Wrong release order');
 for(const r of releases){await apply(r.release);await verify(r.verify);}
 const pre=await db.query(await file('supabase/verify/release_preflight.sql'));const preOk=releases.every(r=>pre.rows.some(x=>x.check.endsWith(r.marker)&&x.value==='applied'));await record({kind:'final-preflight',ok:preOk,rows:pre.rows});if(!preOk)throw Error('Preflight marker missing');
 await db.query('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key)');
 const config=path.resolve('tests/reviews/xero-release/database.config.ts');
 const report=path.join(out,'database.json');
 const jwt='eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic';
 const child=spawnSync(path.resolve('node_modules/.bin/vitest'),['run','-c',config,'--reporter=json','--outputFile='+report],{cwd:root,env:{...process.env,TEST_DATABASE_URL:`postgres://xero_test@127.0.0.1:55449/${name}`,TEST_SUPABASE_URL:'http://127.0.0.1:54321',TEST_SUPABASE_ANON_KEY:jwt,TEST_SUPABASE_SERVICE_ROLE_KEY:jwt},encoding:'utf8',timeout:300000});
 await record({kind:'149-database-tests',ok:child.status===0,status:child.status,stdout:child.stdout,stderr:child.stderr});if(child.status!==0)throw Error('149 database tests failed');
 for(const r of releases.toReversed()){
 if(r.number===149){
  try{await db.query(await file(r.rollback));throw Error('Expected held-company rollback refusal');}catch(e){await db.query('rollback');if(!e.message.startsWith('149 rollback refused:'))throw e;await record({kind:'149-held-company-rollback-refusal',ok:true,message:e.message});}
  // Explicit acceptance is confined to this disposable rehearsal, never a production recommendation.
  await db.query("SET tolra.x149_accept_old_sending='yes'");
 }
 await apply(r.rollback,'rollback');
 if(r.number===146){
  try{await db.query(await file(r.release));throw Error('146 unexpectedly reapplied');}catch(e){await db.query('rollback');if(!/key_source|already|partial|existing|refus/i.test(e.message))throw e;await record({kind:'146-reapply-after-rollback-refusal',ok:true,message:e.message});}
 }
}
 await record({kind:'completed-reverse-rollback',ok:true,order:releases.toReversed().map(r=>r.number)});
}catch(e){console.error(e.message);process.exitCode=1;}finally{await db.end();await admin.query(`drop database ${name} with (force)`);await admin.end();}
