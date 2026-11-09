import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { actor, cap, cipher, clearPlatformKey, connection, db, enable, mode, remove, replace, reserve, snapshot, start, stop, switches, world, type World } from "./database";
let w:World;
beforeAll(start);afterAll(stop);beforeEach(async()=>{w=await world();});
const paid=["rfq","roundup","assistant"];
async function effectiveOff(){
 await db.query("reset role");
 if(mode==="tolra")return (await db.query("select not enabled as off from ai_helper_tolra_control where singleton")).rows[0].off;
 return Object.values(await switches(w)).every(value=>value===false);
}
async function assertOldRowsKept(before:Awaited<ReturnType<typeof snapshot>>){
 const after=await snapshot(w);expect(after.usage).toEqual(before.usage);expect(after.requests).toEqual(before.requests);
 for(const old of before.audit)expect(after.audit.find(row=>row.id===old.id)).toEqual(old);
}
async function seedHistory(){
 const first=await reserve(db,"assistant",15);
 await db.query("reset role");await db.query("set role service_role");
 await db.query("select ai_helper_settle($1,'failed','unavailable',7,null,null)",[first.request_id]);
 await actor(db,w.admin);await reserve(db,"rfq",11);
}

it("the actual effective column default is 1000p, including own-key",async()=>{
 const table=mode==="own"?"ai_helper_settings":"ai_helper_tolra_companies";
 const r=await db.query("select column_default from information_schema.columns where table_schema='public' and table_name=$1 and column_name='monthly_cap_pence'",[table]);
 expect(r.rows[0]?.column_default).toBe("1000");
});
it("no-settings status reports a 1000p effective allowance",async()=>{
 await actor(db,w.admin);const r=(await db.query("select ai_helper_status() as v")).rows[0].v;
 expect(mode==="own"?r.monthly_cap_pence:r.tolra_cap_pence).toBe(1000);
});
it("a newly created settings row receives 1000p without specifying a cap",async()=>{
 if(mode==="own"){await actor(db,w.admin);await db.query("select ai_helper_set_key($1,'0000')",[cipher()]);}
 else await db.query("insert into ai_helper_tolra_companies(organization_id) values($1)",[w.a]);
 await db.query("reset role");const table=mode==="own"?"ai_helper_settings":"ai_helper_tolra_companies";
 expect((await db.query(`select monthly_cap_pence from ${table} where organization_id=$1`,[w.a])).rows[0].monthly_cap_pence).toBe(1000);
});
it("new company starts OFF on RFQ, roundup and assistant without any usage",async()=>{
 await actor(db,w.admin);const s=(await db.query("select ai_helper_status() as v")).rows[0].v;
 expect(s.roundup_enabled).toBe(false);expect(s.rfq_enabled).toBe(false);if(mode==="tolra")expect(s.tolra_enabled).toBe(false);
 for(const f of paid)await expect(reserve(db,f)).rejects.toMatchObject({code:"42501"});
 const saved=await snapshot(w);expect(saved.usage).toEqual([]);expect(saved.requests).toEqual([]);
});
it.each(paid)("%s cannot reserve beyond the same company's selected 1000p cap",async f=>{
 await enable(w);expect((await reserve(db,f,1000)).ok).toBe(true);expect((await reserve(db,f,1)).reason).toBe("cap");
});
it("all paid features share one 1000p month row, not 1000p each",async()=>{
 await enable(w);for(const f of paid)expect((await reserve(db,f,333)).ok).toBe(true);
 expect((await reserve(db,"assistant",1)).ok).toBe(true);expect((await reserve(db,"rfq",1)).reason).toBe("cap");
 const s=await snapshot(w);expect(s.usage).toHaveLength(1);expect(s.usage[0].reserved_pence+s.usage[0].spent_pence).toBe(1000);
});
it("two real independent sessions cannot reserve the last allowance twice",async()=>{
 await enable(w,1000);await reserve(db,"roundup",985);
 const a=await connection(),b=await connection();await actor(a,w.admin);await actor(b,w.office);
 const results=await Promise.all([reserve(a,"rfq",10),reserve(b,"assistant",10)]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>r.reason==="cap")).toHaveLength(1);
 const state=await snapshot(w);expect(state.usage[0].spent_pence+state.usage[0].reserved_pence).toBe(995);
});
it("replacing the selected key forces AI OFF inside the key transaction",async()=>{
 await enable(w);await db.query("reset role");await db.query("begin");
 try{await replace(w);expect(await effectiveOff()).toBe(true);}finally{await db.query("rollback");}
});
it("removing the selected key forces AI OFF in that same transaction",async()=>{
 await enable(w);await db.query("reset role");await db.query("begin");
 try{await remove(w);expect(await effectiveOff()).toBe(true);}finally{await db.query("rollback");}
});
it("replacement alone cannot run any feature; explicit human re-enable is required",async()=>{
 await enable(w);await replace(w);await actor(db,w.admin);
 for(const f of paid)await expect(reserve(db,f)).rejects.toMatchObject({code:"42501"});
 await enable(w);expect((await reserve(db,"rfq")).ok).toBe(true);
});
it("remove then save a replacement key cannot silently re-enable AI",async()=>{
 await enable(w);await remove(w);await replace(w);expect(await effectiveOff()).toBe(true);await actor(db,w.admin);
 for(const f of paid)await expect(reserve(db,f)).rejects.toMatchObject({code:"42501"});
});
it("key replacement preserves every existing usage/request/audit row",async()=>{
 await enable(w);await seedHistory();const before=await snapshot(w);expect(before.usage[0]).toMatchObject({spent_pence:7,reserved_pence:11});await replace(w);await assertOldRowsKept(before);
});
it("key removal preserves every existing usage/request/audit row",async()=>{
 await enable(w);await seedHistory();const before=await snapshot(w);expect(before.usage[0]).toMatchObject({spent_pence:7,reserved_pence:11});await remove(w);await assertOldRowsKept(before);
});
it("a rolled-back key change also rolls back its state/audit changes",async()=>{
 await enable(w);await seedHistory();const before=await snapshot(w);const flags=await switches(w);
 const old=mode==="own"?(await db.query("select api_key_enc from ai_helper_secrets where organization_id=$1",[w.a])).rows:(await db.query("select enabled,api_key_enc from ai_helper_tolra_control")).rows;
 await db.query("begin");await replace(w);await db.query("rollback");
 await assertOldRowsKept(before);expect(await switches(w)).toEqual(flags);
 const current=mode==="own"?(await db.query("select api_key_enc from ai_helper_secrets where organization_id=$1",[w.a])).rows:(await db.query("select enabled,api_key_enc from ai_helper_tolra_control")).rows;
 expect(current).toEqual(old);
});
it("key replacement does not change another company's allowance or spending",async()=>{
 await enable(w);
 if(mode==="own"){
  const other={...w,a:w.b,admin:w.other};await enable(other,2345);await reserve(db,"assistant",7);
 }else{await actor(db,w.other);await db.query("select ai_helper_save_settings(false,false,2345)");}
 await db.query("reset role");const before=(await db.query("select to_jsonb(s) as v from ai_helper_settings s where organization_id=$1",[w.b])).rows;
 const used=(await db.query("select to_jsonb(s) as v from ai_helper_usage s where organization_id=$1",[w.b])).rows;
 await replace(w);await db.query("reset role");expect((await db.query("select to_jsonb(s) as v from ai_helper_settings s where organization_id=$1",[w.b])).rows).toEqual(before);
 expect((await db.query("select to_jsonb(s) as v from ai_helper_usage s where organization_id=$1",[w.b])).rows).toEqual(used);
});
it("another company's settings and request log cannot be read through RLS",async()=>{
 await enable(w);await reserve(db,"rfq",11);await actor(db,w.other);
 for(const t of ["ai_helper_settings","ai_helper_usage","ai_helper_requests"])expect((await db.query(`select * from ${t} where organization_id=$1`,[w.a])).rows).toEqual([]);
});
it.each(paid)("support session cannot reserve %s or change the key",async f=>{
 await enable(w);const before=await snapshot(w);await actor(db,w.admin,{support:true});
 await expect(reserve(db,f)).rejects.toMatchObject({code:"42501"});
 if(mode==="own")await expect(db.query("select ai_helper_set_key($1,'0001')",[cipher(1)])).rejects.toMatchObject({code:"42501"});
 else await expect(db.query("select ai_helper_tolra_configure(true,$1,$2)",[cipher(1),w.owner])).rejects.toMatchObject({code:"42501"});
 await assertOldRowsKept(before);
});
it("no ordinary browser identity can directly change usage or settle cheaply",async()=>{
 await enable(w);await expect(db.query("update ai_helper_usage set spent_pence=0")).rejects.toMatchObject({code:"42501"});
 await expect(db.query("select ai_helper_settle($1,'failed','unavailable',0,null,null)",[w.a])).rejects.toMatchObject({code:"42501"});
});
it("cap cannot be lowered below already spent plus reserved usage",async()=>{
 await enable(w,1000);await reserve(db,"rfq",25);await expect(cap(w,24)).rejects.toMatchObject({code:"22023"});
});
it("changing key/mode cannot select a separate higher company allowance",async()=>{
 await enable(w,25);
 if(mode==="tolra"){
  // The requirement is one company setting across funding modes. Historical 146 has separate 500p/1000p defaults.
  await db.query("select ai_helper_set_key($1,'0000')",[cipher()]);
  await db.query("select ai_helper_set_tolra_mode(true)");await reserve(db,"rfq",25);
  await db.query("select ai_helper_set_tolra_mode(false)");
  const status=(await db.query("select ai_helper_status() as v")).rows[0].v;
  // The admin re-enables own-key features with the allowance currently reported by status, not a new requested budget.
  await db.query("select ai_helper_save_settings(true,true,$1)",[status.monthly_cap_pence]);
  await db.query("select ai_helper_set_assistant(true)");
  const next=await reserve(db,"assistant",1);
  expect(next.ok,`25p already reserved under the selected 25p allowance; mode switch returned ${JSON.stringify(next)}`).toBe(false);
  expect(next.reason,"mode switching must not select a higher separate cap").toBe("cap");

 }else{
  await reserve(db,"rfq",25);await replace(w);await enable(w,25);await actor(db,w.admin);expect((await reserve(db,"assistant",1)).reason).toBe("cap");
 }
});

if(mode==='tolra'){
 it('a company admin cannot remove the shared platform key, even with the correct impact phrase',async()=>{
  await enable(w);await actor(db,w.admin);
  await expect(clearPlatformKey(db,w.admin)).rejects.toMatchObject({code:'42501'});
  await db.query('reset role');expect((await db.query('select enabled,api_key_enc is not null as key_set from ai_helper_tolra_control')).rows[0]).toEqual({enabled:true,key_set:true});
 });
 it('a service-role caller cannot nominate a company admin as the platform key owner',async()=>{
  await enable(w);await db.query('reset role');await db.query('set role service_role');
  await expect(clearPlatformKey(db,w.admin)).rejects.toMatchObject({code:'42501'});
  await db.query('reset role');expect((await db.query('select enabled,api_key_enc is not null as key_set from ai_helper_tolra_control')).rows[0]).toEqual({enabled:true,key_set:true});
 });
 it('the platform owner must supply the correct impact confirmation; refusal changes no control, usage or history',async()=>{
  await enable(w);await seedHistory();const before=await snapshot(w);
  const control=(await db.query('select to_jsonb(c) as v from ai_helper_tolra_control c')).rows;
  await db.query('set role service_role');
  await expect(clearPlatformKey(db,w.owner,'not approved')).rejects.toMatchObject({code:'22023'});
  await assertOldRowsKept(before);expect((await db.query('select to_jsonb(c) as v from ai_helper_tolra_control c')).rows).toEqual(control);
 });
 it('confirmed platform key removal deletes the key, forces OFF and appends an owner audit without rewriting old audit rows',async()=>{
  await enable(w);await seedHistory();const before=await snapshot(w);
  const old=(await db.query('select to_jsonb(a) as v from security_audit.audit_log a')).rows.map(r=>r.v);
  await remove(w);await assertOldRowsKept(before);
  expect((await db.query('select enabled,api_key_enc from ai_helper_tolra_control')).rows[0]).toEqual({enabled:false,api_key_enc:null});
  const after=(await db.query('select to_jsonb(a) as v from security_audit.audit_log a')).rows.map(r=>r.v);
  for(const row of old)expect(after.find(r=>r.id===row.id)).toEqual(row);
  const added=after.filter(r=>!old.some(a=>a.id===r.id));
  expect(added.some(r=>r.actor_user_id===w.owner&&r.organization_id===null),'platform removal needs an owner-attributed audit event').toBe(true);
  expect(JSON.stringify(added)).not.toContain(cipher());
 });
}
