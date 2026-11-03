import { preparePost144Backend } from "../support/post-144-release-fixture";
/**
 * NOT RUN for this PR: database/Docker checks are blocked. This proof requires
 * the separately reviewed N2 proposal on an isolated disposable database.
 * The verified fixture prepares releases 145/146 after baseline checks; synthetic data changes roll back.
 */
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

it("isolates company use, enforces the cap and keeps Tolra's key service-only",async()=>{
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
