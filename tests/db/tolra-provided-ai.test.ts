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
