import { preparePost144Backend } from "../support/post-144-release-fixture";
/**
 * NOT RUN for this PR: database/Docker checks are blocked. This proof requires
 * the separately reviewed N2 proposal on an isolated disposable database.
 * The verified fixture prepares releases 145/146 after baseline checks; synthetic data changes roll back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { beforeAll, expect, it } from "vitest";
import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

beforeAll(async()=>{await verifyBackendIdentity(); await preparePost144Backend();});
const KEY_ENC="v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";
const DIGEST="c".repeat(64);

async function refused(db:Client,sql:string,args:unknown[]=[]) {
  await db.query("SAVEPOINT refused_call");
  try { await db.query(sql,args); throw new Error("Expected refusal"); }
  catch(error) {
    await db.query("ROLLBACK TO SAVEPOINT refused_call");
    expect((error as {code?:string}).code).toBe("42501");
  }
  await db.query("RELEASE SAVEPOINT refused_call");
}

it("isolates company use, enforces the cap, keeps Tolra's key service-only and refuses rollback with an outstanding reservation",async()=>{
  await withDb(async db=>{
    await db.query("BEGIN");
    try {
      const present=await db.query("SELECT to_regclass('public.ai_helper_tolra_control') AS t");
      expect(present.rows[0].t,"Review/apply N2 separately on the disposable database first").not.toBeNull();
      const user=randomUUID(), session=randomUUID(), alpha=randomUUID(), beta=randomUUID();
      const email=`tolra-ai-${user}@example.test`;
      for(const [id,label] of [[alpha,"alpha"],[beta,"beta"]]) {
        await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')",[id,`Tolra AI ${label}`,`${SYNTHETIC_SLUG_PREFIX}tolra-ai-${id}`]);
      }
      await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)",[user,email]);
      await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic admin','admin',$3,TRUE,FALSE)",[user,email,alpha]);
      for(const org of [alpha,beta]) await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',TRUE)",[user,org]);
      await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)",[session,user]);
      await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)",[session,user,alpha]);
      await db.query("INSERT INTO security_audit.platform_admins(user_id) VALUES($1)",[user]);
      await db.query("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2)",[KEY_ENC,user]);
      const claims={sub:user,role:"authenticated",aud:"authenticated",aal:"aal2",email,session_id:session};
      await db.query("SELECT set_config('request.jwt.claims',$1,TRUE),set_config('request.jwt.claim.sub',$2,TRUE)",[JSON.stringify(claims),user]);
      await db.query("SET LOCAL ROLE authenticated");
      const initial=await db.query("SELECT public.ai_helper_status() AS s");
      expect(initial.rows[0].s).toMatchObject({tolra_available:true,tolra_enabled:false,month_spent_pence:0,month_reserved_pence:0});
      await db.query("SELECT public.ai_helper_set_tolra_mode(TRUE)");
      const reserve=()=>db.query("SELECT public.ai_helper_reserve('rfq',400,$1,10) AS r",[DIGEST]);
      const first=(await reserve()).rows[0].r;
      expect(first).toMatchObject({ok:true,key_source:"tolra"});
      await db.query("RESET ROLE");
      await assertOutstandingRollbackRefuses(db, first.request_id, alpha);
      await db.query("SET LOCAL ROLE authenticated");
      expect((await reserve()).rows[0].r.ok).toBe(true);
      expect((await reserve()).rows[0].r).toMatchObject({ok:false,reason:"cap"});
      await refused(db,"SELECT api_key_enc FROM public.ai_helper_tolra_control");
      await refused(db,"SELECT public.ai_helper_tolra_key($1,$2)",[first.request_id,alpha]);
      await refused(db,"UPDATE public.ai_helper_tolra_companies SET monthly_cap_pence=99999 WHERE organization_id=$1",[alpha]);
      await db.query("RESET ROLE");
      await db.query("UPDATE security_audit.session_company SET organization_id=$1 WHERE session_id=$2",[beta,session]);
      await db.query("SET LOCAL ROLE authenticated");
      const other=await db.query("SELECT public.ai_helper_status() AS s");
      expect(other.rows[0].s).toMatchObject({tolra_enabled:false,month_spent_pence:0,month_reserved_pence:0});
      await db.query("SELECT public.ai_helper_set_tolra_mode(TRUE)");
      expect((await reserve()).rows[0].r.ok).toBe(true);
      await db.query("RESET ROLE");
      const foreign=await db.query("SELECT public.ai_helper_tolra_key($1,$2) AS k",[first.request_id,beta]);
      expect(foreign.rows[0].k).toBeNull();
      expect((await db.query("SELECT public.ai_helper_tolra_key($1,$2) AS k",[first.request_id,alpha])).rows[0].k).toBe(KEY_ENC);
      await db.query("SELECT public.ai_helper_tolra_configure(FALSE,NULL,$1)",[user]);
      await db.query("SET LOCAL ROLE authenticated");
      await refused(db,"SELECT public.ai_helper_reserve('rfq',1,$1,10)",[DIGEST]);
    } finally { await db.query("ROLLBACK"); }
  });
});

function releaseBody(file: string) {
 const sql=readFileSync(path.resolve(__dirname,"../../supabase/release",file),"utf8");
 expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
 expect(sql.match(/^COMMIT;\s*$/gm)).toHaveLength(1);
 return sql.replace(/^BEGIN;$/m,"").replace(/^COMMIT;\s*$/m,"");
}
async function assertOutstandingRollbackRefuses(db: Client, request: string, org: string) {
 const before=(await db.query("SELECT id,status,key_source,reserved_pence FROM public.ai_helper_requests WHERE id=$1",[request])).rows;
 expect(before).toHaveLength(1);expect(before[0]).toMatchObject({status:"reserved",key_source:"tolra"});
 const usage=(await db.query("SELECT * FROM public.ai_helper_usage WHERE organization_id=$1 ORDER BY month",[org])).rows;
 const definitions=(await db.query("SELECT oid,prosrc FROM pg_proc WHERE oid IN (to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'),to_regprocedure('public._ai_helper_reserve_own_key(text,integer,text,integer)')) ORDER BY oid")).rows;
 await db.query("SAVEPOINT outstanding_rollback");
 await expect(db.query(releaseBody("146_tolra_provided_ai.rollback.sql"))).rejects.toMatchObject({code:"P0001",message:"Settle outstanding Tolra requests before rollback."});
 await db.query("ROLLBACK TO SAVEPOINT outstanding_rollback");
 expect((await db.query("SELECT id,status,key_source,reserved_pence FROM public.ai_helper_requests WHERE id=$1",[request])).rows).toEqual(before);
 expect((await db.query("SELECT * FROM public.ai_helper_usage WHERE organization_id=$1 ORDER BY month",[org])).rows).toEqual(usage);
 expect((await db.query("SELECT oid,prosrc FROM pg_proc WHERE oid IN (to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'),to_regprocedure('public._ai_helper_reserve_own_key(text,integer,text,integer)')) ORDER BY oid")).rows).toEqual(definitions);
 expect((await db.query("SELECT to_regclass('public.ai_helper_tolra_control') IS NOT NULL AS control,to_regclass('public.ai_helper_tolra_companies') IS NOT NULL AS companies")).rows[0]).toEqual({control:true,companies:true});
}
it("release 146 refuses a second install without changing wrappers or retained history",async()=>{
 await withDb(async db=>{
  await db.query("BEGIN");
  try {
   const snapshot=()=>db.query("SELECT p.proname,md5(p.prosrc) AS body,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE '%ai_helper%' ORDER BY p.oid");
   const before=(await snapshot()).rows;
   const history=(await db.query("SELECT id,status,key_source,reserved_pence,cost_pence FROM public.ai_helper_requests ORDER BY id")).rows;
   await db.query("SAVEPOINT second_install");
   await expect(db.query(releaseBody("146_tolra_provided_ai.release.sql"))).rejects.toMatchObject({code:"P0001",message:"Review the existing reserve functions before applying N2; expected 133 and 134."});
   await db.query("ROLLBACK TO SAVEPOINT second_install");
   expect((await snapshot()).rows).toEqual(before);
   expect((await db.query("SELECT id,status,key_source,reserved_pence,cost_pence FROM public.ai_helper_requests ORDER BY id")).rows).toEqual(history);
  } finally {await db.query("ROLLBACK");}
 });
});

it("provided mode with no global key refuses every reservation and never falls back to a working company key",async()=>{
 await withDb(async db=>{
  await db.query("BEGIN");
  try {
   const org=randomUUID(),user=randomUUID(),session=randomUUID(),email=`no-global-key-${user}@example.test`;
   await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Synthetic no global key',$2,'active')",[org,`${SYNTHETIC_SLUG_PREFIX}no-global-${org}`]);
   await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)",[user,email]);
   await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic admin','admin',$3,TRUE,FALSE)",[user,email,org]);
   await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',TRUE)",[user,org]);
   await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)",[session,user]);
   await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)",[session,user,org]);
   await db.query("SELECT set_config('request.jwt.claims',$1,TRUE),set_config('request.jwt.claim.sub',$2,TRUE)",[JSON.stringify({sub:user,role:"authenticated",aud:"authenticated",aal:"aal2",email,session_id:session}),user]);
   await db.query("SET LOCAL ROLE authenticated");
   await db.query("SELECT public.ai_helper_set_key($1,'abcd')",[KEY_ENC]);
   await db.query("SELECT public.ai_helper_save_settings(TRUE,TRUE,1000)");
   await db.query("SELECT public.ai_helper_set_assistant(TRUE)");
   const reservations=[
    "SELECT public.ai_helper_reserve('roundup',10,$1,10) AS r",
    "SELECT public.ai_helper_reserve('rfq',10,$1,10) AS r",
    "SELECT public.ai_helper_reserve_assistant(10,$1,10) AS r",
   ];
   // Positive controls prove the same company key, features and caller can reserve.
   for(const sql of reservations)expect((await db.query(sql,[DIGEST])).rows[0].r).toMatchObject({ok:true});
   await db.query("RESET ROLE");
   expect((await db.query("SELECT key_source FROM public.ai_helper_requests WHERE organization_id=$1",[org])).rows).toEqual([{key_source:"own"},{key_source:"own"},{key_source:"own"}]);
   // Model an existing selection whose platform key is subsequently removed.
   // These owner-only fixture changes and all synthetic data roll back below.
   await db.query("UPDATE public.ai_helper_tolra_control SET enabled=TRUE,api_key_enc=$1 WHERE singleton",[KEY_ENC]);
   await db.query("SET LOCAL ROLE authenticated");
   await db.query("SELECT public.ai_helper_set_tolra_mode(TRUE)");
   await db.query("RESET ROLE");
   await db.query("UPDATE public.ai_helper_tolra_control SET enabled=FALSE,api_key_enc=NULL WHERE singleton");
   expect((await db.query("SELECT enabled,api_key_enc IS NULL AS no_key FROM public.ai_helper_tolra_control WHERE singleton")).rows).toEqual([{enabled:false,no_key:true}]);
   const snapshot=async()=>({
    requests:(await db.query("SELECT * FROM public.ai_helper_requests WHERE organization_id=$1 ORDER BY id",[org])).rows,
    usage:(await db.query("SELECT * FROM public.ai_helper_usage WHERE organization_id=$1 ORDER BY month",[org])).rows,
    ownKey:(await db.query("SELECT * FROM public.ai_helper_secrets WHERE organization_id=$1",[org])).rows,
   });
   expect((await db.query("SELECT roundup_enabled,rfq_enabled,assistant_enabled FROM public.ai_helper_settings WHERE organization_id=$1",[org])).rows).toEqual([{roundup_enabled:true,rfq_enabled:true,assistant_enabled:true}]);
   const before=await snapshot();
   for(const sql of reservations){
    await db.query("SET LOCAL ROLE authenticated");
    expect((await db.query("SELECT public.ai_helper_status() AS s")).rows[0].s).toMatchObject({key_set:true,roundup_enabled:true,rfq_enabled:true,tolra_enabled:true,tolra_available:false});
    await db.query("SAVEPOINT missing_global_key");
    await expect(db.query(sql,[DIGEST])).rejects.toMatchObject({code:"42501",hint:"ai_helper_off",message:"Tolra AI is off."});
    await db.query("ROLLBACK TO SAVEPOINT missing_global_key");
    await db.query("RELEASE SAVEPOINT missing_global_key");
    await db.query("RESET ROLE");
    // No fallback request, money reservation or replacement company key is allowed.
    expect(await snapshot()).toEqual(before);
   }
  } finally {await db.query("ROLLBACK");}
 });
});

// AV: rollback business-data proof; NOT RUN under the no-SQL rule.
const rollbackBusinessTables = ['organizations', 'customers', 'invoices', 'invoice_payments', 'jobs', 'purchase_orders'];
async function snapshot(db: Client) {
  const result: Record<string, unknown[]> = {};
  for (const table of rollbackBusinessTables) {
    result[table] = (await db.query(`SELECT to_jsonb(t) - ARRAY['payment_claimed_at','payment_claim_source','payment_claim_evidence','payment_claim_message_id'] AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
function rollbackBody(number: string, name: string) {
  const sql = readFileSync(path.resolve(__dirname, `../../supabase/release/${number}_${name}.rollback.sql`), 'utf8');
  expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
  expect(sql.match(/^COMMIT;\s*$/gm)).toHaveLength(1);
  return sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;\s*$/m, '');
}
for (const [number, name] of [['138', 'chase_steps'], ['144', 'accounting_connections'], ['145', 'company_setup'], ['146', 'tolra_provided_ai']]) {
  it(`release ${number} rollback preserves existing business rows or refuses without changing them`, async () => {
    await withDb(async db => {
      await db.query('BEGIN');
      try {
        const org = randomUUID();
        await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Rollback fake company',$2,'active')", [org, `${SYNTHETIC_SLUG_PREFIX}rollback-${org}`]);
        await db.query("INSERT INTO public.customers(organization_id,name) VALUES($1,'Rollback fake customer')", [org]);
        await db.query("INSERT INTO public.invoices(organization_id,customer,status,subtotal,vat,total) VALUES($1,'Rollback fake customer','draft',1,0.2,1.2)", [org]);
        const before = await snapshot(db);
        expect(before.customers.length).toBeGreaterThan(0);
        expect(before.invoices.length).toBeGreaterThan(0);
        // A non-empty positive control prevents a vacuous empty-database pass.
        expect(before.organizations.length).toBeGreaterThan(0);
        await db.query('SAVEPOINT rollback_attempt');
        try {
          await db.query(rollbackBody(number, name));
        } catch (error) {
          // Refusal is valid only for the named documented safety guards.
          await db.query('ROLLBACK TO SAVEPOINT rollback_attempt');
          expect((error as { code?: string }).code).toBe('P0001');
          expect((error as Error).message).toMatch(/stop and compare|Disconnect cloud connections|Settle outstanding Tolra requests/);
        }
        expect(await snapshot(db)).toEqual(before);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });
}
