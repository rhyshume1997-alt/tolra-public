import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export const sourceRoot = path.resolve(process.env.AI_CONTRACT_SOURCE_ROOT ?? ".");
export const mode = process.env.AI_CONTRACT_MODE ?? "own";
if (!["own", "tolra"].includes(mode)) throw Error("AI_CONTRACT_MODE must be own or tolra");
export const read = (p: string) => readFileSync(path.join(sourceRoot,p),"utf8");
const root = new URL(process.env.AI_CONTRACT_ADMIN_URL ?? "postgresql://ai_test@127.0.0.1:55439/postgres");
if (!["127.0.0.1", "[::1]"].includes(root.hostname) || root.pathname !== "/postgres") throw Error("Only a disposable literal-loopback test cluster is permitted");
export const name = `ai_verify_${randomUUID().replaceAll("-","")}`;
let owner: Client;
export let db: Client;
const clients = new Set<Client>();
export async function connection() {
  const url = new URL(root); url.pathname = "/"+name;
  const c = new Client({connectionString:url.href});await c.connect();clients.add(c);return c;
}
export async function start() {
  owner=new Client({connectionString:root.href});await owner.connect();
  // CREATE in the caller's disposable cluster; never load SQL into the supplied admin database itself.
  await owner.query(`create database ${name}`); db=await connection();
  await db.query(readFileSync(path.join(import.meta.dirname,"bootstrap.sql"),"utf8"));
  for(const f of ["101_ai_helper.sql","103_ai_helper_service_role.sql","122_ai_helper_cap_default.sql","133_ai_helper_pre_enable.sql","134_ai_assistant.sql"]) await db.query(read("supabase/migrations/"+f));
  // Exact finance-switch section of 106; exclude its unrelated mail tables/functions.
  const finance=read("supabase/migrations/106_email_templates.sql");
  const from=finance.indexOf("ALTER TABLE public.ai_helper_settings ADD COLUMN IF NOT EXISTS finance_check_enabled");
  const through=finance.indexOf("GRANT EXECUTE ON FUNCTION public.ai_helper_set_finance_check(BOOLEAN) TO authenticated;",from);
  if(from<0||through<0)throw Error("Cannot locate the exact 106 finance-switch prerequisites");
  await db.query(finance.slice(from,through)+"GRANT EXECUTE ON FUNCTION public.ai_helper_set_finance_check(BOOLEAN) TO authenticated;");
  const overlays=JSON.parse(process.env.AI_CONTRACT_SQL_FILES ?? "[]") as string[];
  if(!Array.isArray(overlays)||overlays.some(p=>typeof p!=="string"))throw Error("AI_CONTRACT_SQL_FILES must be a JSON array of reviewed local paths");
  for(const file of overlays)await db.query(readFileSync(path.resolve(file),"utf8"));
  const receipt={database:name,sourceRoot,mode,version:(await db.query("select version() as v")).rows[0].v,
    overlays:overlays.map(file=>({file,sha256:createHash("sha256").update(readFileSync(path.resolve(file))).digest("hex")})),
    baseline:["101_ai_helper.sql","103_ai_helper_service_role.sql","122_ai_helper_cap_default.sql","133_ai_helper_pre_enable.sql","134_ai_assistant.sql"].map(file=>({file,sha256:createHash("sha256").update(read("supabase/migrations/"+file)).digest("hex")}))};
  if(process.env.AI_CONTRACT_RECEIPT)writeFileSync(process.env.AI_CONTRACT_RECEIPT,JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify(receipt));
}
export async function stop() {
  for(const c of clients){try{await c.query("rollback");await c.end();}catch{/* preserve original test outcome */}}
  if(owner){await owner.query(`drop database if exists ${name} with (force)`);await owner.end();}
}
export async function actor(c:Client,id:string,extra:Record<string,unknown>={}) {
  await c.query("reset role");await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role:"authenticated",aal:"aal2",...extra})]);await c.query("set role authenticated");
}
export type World={a:string;b:string;admin:string;other:string;office:string;viewer:string;owner:string};
export async function world():Promise<World>{
 await db.query("reset role");const w={a:randomUUID(),b:randomUUID(),admin:randomUUID(),other:randomUUID(),office:randomUUID(),viewer:randomUUID(),owner:randomUUID()};
 await db.query("insert into organizations values($1),($2)",[w.a,w.b]);
 for(const [id,org,role] of [[w.admin,w.a,"admin"],[w.other,w.b,"admin"],[w.office,w.a,"office"],[w.viewer,w.a,"viewer"],[w.owner,w.a,"admin"]]){
  await db.query("insert into auth.users values($1,$2)",[id,`${role}@example.test`]);await db.query("insert into user_profiles values($1,$2,$3,$4)",[id,`${role}@example.test`,org,role]);
 }
 await db.query("insert into security_audit.platform_admins values($1)",[w.owner]);return w;
}
export const digest="a".repeat(64);
export async function reserve(c:Client,feature:string,pence=1){
 const result=feature==="assistant"?await c.query("select ai_helper_reserve_assistant($1,$2,12) as v",[pence,digest]):await c.query("select ai_helper_reserve($3,$1,$2,12) as v",[pence,digest,feature]);return result.rows[0].v;
}
export async function switches(w:World){
 await db.query("reset role");return (await db.query("select roundup_enabled,rfq_enabled,assistant_enabled,finance_check_enabled from ai_helper_settings where organization_id=$1",[w.a])).rows[0];
}
export async function cap(w:World,pence:number){
 if(mode==="own"){await actor(db,w.admin);await db.query("select ai_helper_save_settings(true,true,$1)",[pence]);}
 else{await db.query("reset role");await db.query("set role service_role");await db.query("select ai_helper_tolra_set_cap($1,$2,$3)",[w.a,pence,w.owner]);}
}
export const cipher=(n=0)=>`v1.aaaaaaaa.bbbbbbbb.cccccccc${n}`;
export async function enable(w:World,pence=1000){
 if(mode==="tolra"){
  await db.query("reset role");await db.query("set role service_role");await db.query("select ai_helper_tolra_configure(true,$1,$2)",[cipher(),w.owner]);
  // 150 forces replacement OFF even when the first call requested ON. Explicit enable is a separate human action.
  await db.query("select ai_helper_tolra_configure(true,null,$1)",[w.owner]);
  await actor(db,w.admin);await db.query("select ai_helper_set_tolra_mode(true)");
 }else{await actor(db,w.admin);await db.query("select ai_helper_set_key($1,'0000')",[cipher()]);}
 await cap(w,pence);await actor(db,w.admin);await db.query("select ai_helper_set_assistant(true)");await db.query("select ai_helper_set_finance_check(true)");
}
export async function snapshot(w:World){
 await db.query("reset role");
 const collect=async(table:string)=> (await db.query(`select to_jsonb(t) as v from ${table} t where organization_id=$1 order by to_jsonb(t)::text`,[w.a])).rows.map(r=>r.v);
 return {usage:await collect("ai_helper_usage"),requests:await collect("ai_helper_requests"),audit:await collect("security_audit.audit_log")};
}
export async function replace(w:World,c:Client=db){
 if(mode==="own"){await actor(c,w.admin);await c.query("select ai_helper_set_key($1,'0001')",[cipher(1)]);}
 else{await c.query("reset role");await c.query("set role service_role");await c.query("select ai_helper_tolra_configure(true,$1,$2)",[cipher(1),w.owner]);}
}
/** Map the real Opus-owned removal RPC and phrase; absence is a failed contract, never an invented implementation. */
export async function clearPlatformKey(c:Client,ownerId:string,confirmation=process.env.AI_CONTRACT_TOLRA_CLEAR_CONFIRMATION){
 const fn=process.env.AI_CONTRACT_TOLRA_CLEAR_FUNCTION;
 if(!fn||!/^public\.[a-z_][a-z0-9_]*$/.test(fn))throw Error("No public Tolra key-removal interface supplied; map the actual 150 function via AI_CONTRACT_TOLRA_CLEAR_FUNCTION");
 if(!confirmation)throw Error("Supply the actual approved impact phrase via AI_CONTRACT_TOLRA_CLEAR_CONFIRMATION");
 const name=fn.slice('public.'.length);
 const functions=(await c.query("select oidvectortypes(p.proargtypes) as types from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",[name])).rows as Array<{types:string}>;
 const signatures=functions.filter(f=>['uuid, text','text, uuid'].includes(f.types));
 if(signatures.length!==1)throw Error("Published removal RPC must have one unambiguous owner-UUID and confirmation-text signature; map the actual interface before claiming a pass");
 const types=signatures[0].types.split(', '),args=types.map(t=>t==='uuid'?ownerId:confirmation);
 return c.query(`select ${fn}(${types.map((t,i)=>`$${i+1}::${t}`).join(',')})`,args);
}
export async function remove(w:World){
 if(mode==="own"){await actor(db,w.admin);await db.query("select ai_helper_set_key(null,null)");}
 else{await db.query("reset role");await db.query("set role service_role");await clearPlatformKey(db,w.owner);}
}
