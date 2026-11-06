// Disposable PostgreSQL only. Executes every verifier in READ ONLY transactions at pinned schema stages.
const {Client}=require('pg');const fs=require('node:fs'),crypto=require('node:crypto');
if(process.env.VERIFY_AUDIT_SOURCE_ROOT)process.chdir(process.env.VERIFY_AUDIT_SOURCE_ROOT);
const root=process.cwd(),prefix='verify_adv_'+crypto.randomBytes(6).toString('hex');
const files=fs.readdirSync('supabase/verify').filter(f=>f.endsWith('.sql')).sort();
const baseFiles=fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)&&+f.slice(0,3)<=137).sort();
const admin=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:'postgres'});
const sql=f=>fs.readFileSync(f,'utf8');const result={source:require('child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:[],stages:[]};
for(const f of files){const text=sql('supabase/verify/'+f);result.files.push({file:f,sha256:crypto.createHash('sha256').update(text).digest('hex'),literalRegclass:(text.match(/'[^']+'::regclass/g)||[]).length,literalRegprocedure:(text.match(/'[^']+'::regprocedure/g)||[]).length,queryToXml:text.includes('query_to_xml')});}
(async()=>{await admin.connect();const name=prefix;await admin.query('create database '+name);const db=new Client({host:'127.0.0.1',port:54849,user:'xero_test',database:name});await db.connect();
try{await db.query(sql('tests/reviews/night-151-package/bootstrap.sql'));
const run=async stage=>{const rows=[];for(const f of files){await db.query('begin read only');try{const r=await db.query(sql('supabase/verify/'+f));const sets=Array.isArray(r)?r:[r];rows.push({file:f,status:'executed',rows:sets.reduce((n,x)=>n+x.rows.length,0),notTrue:sets.flatMap(x=>x.rows).filter(r=>('ok'in r&&r.ok!==true)||('passed'in r&&r.passed!==true)).length});}catch(e){rows.push({file:f,status:'error',code:e.code,message:e.message,position:e.position});}finally{await db.query('rollback');}}
 result.stages.push({stage,results:rows});fs.writeFileSync(process.env.VERIFY_AUDIT_OUTPUT||'tests/reviews/verify-old-base/evidence/before.json',JSON.stringify(result,null,2)+'\n');console.log(stage,rows.filter(r=>r.status==='executed').length,'executed',rows.filter(r=>r.status==='error').length,'errors');};
for(const f of baseFiles){await db.query(sql('supabase/migrations/'+f));if([13,83,137].includes(+f.slice(0,3)))await run(+f.slice(0,3));}
const plan=JSON.parse(sql('supabase/release-plan.json'));for(const phase of plan.jnr_cutover_numbered_order)await db.query(sql(phase.release));await run(144);
for(const phase of plan.phases.filter(p=>p.number<=150))await db.query(sql(phase.release));await run(150);
await db.query(sql('supabase/release/151_xero_invite_hardening.release.sql'));await run(151);
}finally{await db.end();await admin.query('drop database '+name+' with(force)');await admin.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
