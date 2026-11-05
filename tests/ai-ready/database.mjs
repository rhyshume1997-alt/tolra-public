// A real PostgreSQL test of the existing AI policies/ledger plus the unnumbered proposal.
// Requires an operator-created empty disposable database, loopback only; NEVER a Supabase/production URL.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const url = new URL(process.env.AI_READY_TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/ai_ready_test_[a-z0-9_]+$/.test(url.pathname)) throw Error('Only an empty loopback ai_ready_test_* database is allowed');
const connect = async () => { const c = new pg.Client({ connectionString: url.href }); await c.connect(); return c; };
const db = await connect(); const clients = [db]; let passed=0;
const check = async (name, f) => { await f(); passed++; console.log(`PASS ${name}`); };
const sql = async p => readFile(new URL('../../'+p, import.meta.url), 'utf8');
const orgA=randomUUID(), orgB=randomUUID(), adminA=randomUUID(), adminB=randomUUID(), office=randomUUID(), viewer=randomUUID();
const who = async (c, id, extra={}) => { await c.query('reset role'); await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role:'authenticated',aal:'aal2',...extra})]); await c.query('set role authenticated'); };
const status = async c => (await c.query('select public.ai_helper_status() as v')).rows[0].v;
const save = (c,cap) => c.query('select public.ai_helper_save_settings(true,true,$1) as v',[cap]);
const reserve = async (c,feature,cost=10) => (await c.query(feature==='assistant' ? 'select public.ai_helper_reserve_assistant($1,$2,100) as v' : 'select public.ai_helper_reserve($3,$1,$2,100) as v',feature==='assistant'?[cost,'a'.repeat(64)]:[cost,'a'.repeat(64),feature])).rows[0].v;
try {
 await db.query(await sql('tests/ai-ready/bootstrap.sql'));
 for(const p of ['101_ai_helper.sql','103_ai_helper_service_role.sql','122_ai_helper_cap_default.sql','133_ai_helper_pre_enable.sql','134_ai_assistant.sql']) await db.query(await sql('supabase/migrations/'+p));
 await db.query('insert into public.organizations values ($1),($2)',[orgA,orgB]);
 for(const [id,org,role] of [[adminA,orgA,'admin'],[adminB,orgB,'admin'],[office,orgA,'office'],[viewer,orgA,'viewer']]) await db.query('insert into public.user_profiles values($1,$2,$3,$4)',[id,`${role}@example.test`,org,role]);
 await who(db,adminB); await save(db,2345); await db.query('reset role');
 await db.query(await sql('supabase/proposals/ai_ready_for_keys.sql'));
 await check('all proposal verify rows true; replay is guarded and idempotent',async()=> {assert((await db.query(await sql('supabase/verify/ai_ready_for_keys.sql'))).rows.every(r=>r.ok===true));await db.query(await sql('supabase/proposals/ai_ready_for_keys.sql'));});
 await check('unconfigured company defaults to 1000p, every feature OFF, no key',async()=>{await who(db,adminA);assert.deepEqual(await status(db),{roundup_enabled:false,rfq_enabled:false,monthly_cap_pence:1000,key_set:false,key_last4:null,month_spent_pence:0,month_reserved_pence:0,can_manage:true});});
 await check('existing explicitly saved company cap is unchanged',async()=>{await who(db,adminB);assert.equal((await status(db)).monthly_cap_pence,2345);});
 await check('setting own key creates default 1000p row but enables nothing',async()=>{await who(db,adminA);await db.query("select public.ai_helper_set_key('v1.aaaaaaaa.bbbbbbbb.cccccccc','cccc')");assert.equal((await status(db)).monthly_cap_pence,1000);assert.equal((await status(db)).rfq_enabled,false);});
 await check('own-key RFQ, roundup and assistant all refuse while OFF',async()=>{for(const f of ['rfq','roundup','assistant'])await assert.rejects(reserve(db,f),{code:'42501'});});
 await check('only own-company admin can set cap, office and viewer cannot',async()=>{for(const id of [office,viewer]){await who(db,id);await assert.rejects(save(db,999),{code:'42501'});}await who(db,adminA);await save(db,1000);await db.query('select public.ai_helper_set_assistant(true)');await who(db,adminB);assert.equal((await status(db)).monthly_cap_pence,2345);});
 await check('RLS returns only own company settings, usage and request rows',async()=>{await who(db,adminA);const q=await reserve(db,'rfq');assert(q.ok);for(const table of ['ai_helper_settings','ai_helper_usage','ai_helper_requests']){const rows=(await db.query(`select organization_id from public.${table}`)).rows;assert(rows.length);assert(rows.every(r=>r.organization_id===orgA));}await db.query('reset role');await db.query("select public.ai_helper_settle($1,'failed','unavailable',10,null,null)",[q.request_id]);});
 await check('no browser role may read encrypted keys, write ledgers or settle',async()=>{await who(db,adminA);await assert.rejects(db.query('select * from public.ai_helper_secrets'),{code:'42501'});await assert.rejects(db.query('update public.ai_helper_usage set spent_pence=0'),{code:'42501'});await assert.rejects(db.query("select public.ai_helper_settle($1,'failed','unavailable',0,null,null)",[randomUUID()]),{code:'42501'});});
 await check('viewer RLS sees no AI rows; anonymous has no table grant',async()=>{await who(db,viewer);for(const table of ['ai_helper_settings','ai_helper_usage','ai_helper_requests'])assert.equal((await db.query(`select * from public.${table}`)).rowCount,0);await db.query('reset role');await db.query('set role anon');await assert.rejects(db.query('select * from public.ai_helper_settings'),{code:'42501'});});
 await check('service-only settlement records validated usage/output and cost once in the existing company ledger',async()=>{await who(db,adminA);const r=await reserve(db,'assistant',5);assert(r.ok);await db.query('reset role');await db.query('set role service_role');await db.query("select public.ai_helper_settle($1,'suggested',null,2,'claude-sonnet-5-5',$2)",[r.request_id,JSON.stringify({kind:'assistant',answer:'Synthetic only',usage:{inputTokens:250,outputTokens:80}})]);await assert.rejects(db.query("select public.ai_helper_settle($1,'suggested',null,2,'claude-sonnet-5-5',$2)",[r.request_id,JSON.stringify({kind:'assistant'})]),{code:'42501'});await who(db,adminA);assert.equal((await status(db)).month_spent_pence,12);const row=(await db.query('select output,cost_pence from public.ai_helper_requests where id=$1',[r.request_id])).rows[0];assert.equal(row.cost_pence,2);assert.equal(row.output.usage.inputTokens,250);});
 await check('support and admin without MFA cannot set cap or reserve',async()=>{for(const extra of [{support:true},{aal:'aal1'}]){await who(db,adminA,extra);await assert.rejects(save(db,1000),{code:'42501'});await assert.rejects(reserve(db,'rfq'),{code:'42501'});}});
 await check('all three own-key paths spend one shared company allowance',async()=>{await who(db,adminA);await save(db,42);for(const f of ['rfq','roundup','assistant'])assert((await reserve(db,f,10)).ok);assert.equal((await status(db)).month_reserved_pence,30);for(const f of ['rfq','roundup','assistant'])assert.equal((await reserve(db,f,1)).reason,'cap');});
 await check('cap setter refuses below spent plus outstanding reservations',async()=>{await assert.rejects(save(db,41),{code:'22023'});assert.equal((await status(db)).monthly_cap_pence,42);});
 await check('switching off keeps cap, spend and reservations; no bypass',async()=>{await db.query('select public.ai_helper_save_settings(false,false,42)');await assert.rejects(reserve(db,'rfq'),{code:'42501'});assert.equal((await status(db)).month_reserved_pence,30);});
 // Restore an empty monthly allowance for the concurrent-reservation test, as TEST OWNER only.
 await db.query('reset role');await db.query('delete from public.ai_helper_requests where organization_id=$1',[orgA]);await db.query('delete from public.ai_helper_usage where organization_id=$1',[orgA]);await who(db,adminA);await save(db,10);
 const one=await connect(),two=await connect();clients.push(one,two);await who(one,office);await who(two,office);
 await check('two independent sessions cannot spend the last allowance twice',async()=>{const results=await Promise.all([reserve(one,'rfq',10),reserve(two,'assistant',10)]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.reason==='cap').length,1);assert.equal((await status(db)).month_reserved_pence,10);});
 await check('cap reduction waits for reservation then refuses below held cost',async()=>{
  await save(db,20);await one.query('begin');await reserve(one,'roundup',10);
  await two.query('reset role');await who(two,adminA);let finished=false;const pending=save(two,10).then(()=>({code:null}),e=>({code:e.code})).finally(()=>{finished=true;});
  // Query the actual lock wait rather than assuming a timer proves blocking.
  await db.query('reset role');let waiting=false;for(let i=0;i<50;i++){const rows=(await db.query("select wait_event_type from pg_stat_activity where pid=$1",[two.processID])).rows;if(rows[0]?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert(waiting);assert.equal(finished,false);await one.query('commit');assert.equal((await pending).code,'22023');await who(db,adminA);assert.equal((await status(db)).monthly_cap_pence,20);
 });
 await check('B allowance/key/request access remains independent after A races',async()=>{await who(db,adminB);const s=await status(db);assert.equal(s.monthly_cap_pence,2345);assert.equal(s.month_spent_pence,0);assert.equal(s.month_reserved_pence,0);assert.equal((await db.query('select * from public.ai_helper_requests')).rowCount,0);});
 console.log(`TOTAL ${passed} passed, 0 failed, 0 skipped (real PostgreSQL; synthetic auth/session/audit prerequisites)`);
} catch(e) {console.error(`FAIL after ${passed} passes`,e);process.exitCode=1;} finally {for(const c of clients) await c.end();}
