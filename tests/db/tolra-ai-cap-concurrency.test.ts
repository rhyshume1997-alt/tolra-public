import { preparePost144Backend } from "../support/post-144-release-fixture";
/** Review-only DB proof. NOT RUN here: DB/Docker checks are blocked. Requires
 * the updated N2 proposal applied separately on the disposable backend. The verified fixture prepares releases 145/146 after the baseline. Uses real independent connections and a held ledger lock. */
import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { createSyntheticWorld,destroySyntheticWorld,verifyBackendIdentity,withDb,type SyntheticWorld } from "../support/fixtures";

it("owner-set caps isolate companies and concurrent reservations cannot exceed the cap",async()=>{
  await verifyBackendIdentity();
  await preparePost144Backend();
  let world:SyntheticWorld|undefined;
  let control:{enabled:boolean;api_key_enc:string|null;updated_by:string|null;updated_at:string}|undefined;
  try {
    await withDb(async db=>{control=(await db.query("SELECT enabled,api_key_enc,updated_by,updated_at FROM public.ai_helper_tolra_control WHERE singleton")).rows[0];expect(control).toBeDefined();});
    world=await createSyntheticWorld();
    const A=world.tenants.alpha.id,B=world.tenants.beta.id,owner=world.tenants.alpha.users.admin;
    const session=randomUUID(),label=`tolra-cap-${randomUUID()}`;
    const claims={sub:owner.id,role:"authenticated",aud:"authenticated",aal:"aal2",email:owner.email,session_id:session};
    await withDb(async db=>{
      await db.query("INSERT INTO security_audit.platform_admins(user_id) VALUES($1)",[owner.id]);
      await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)",[session,owner.id]);
      await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)",[session,owner.id,A]);
      await db.query("SELECT public.ai_helper_tolra_configure(TRUE,$1,$2)",["v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc",owner.id]);
      await db.query("SELECT public.ai_helper_tolra_set_cap($1,15,$2)",[A,owner.id]);
      const caps=(await db.query("SELECT * FROM public.ai_helper_tolra_caps() WHERE organization_id IN ($1,$2)",[A,B])).rows;
      expect(caps.find(c=>c.organization_id===A).monthly_cap_pence).toBe(15);
      expect(caps.find(c=>c.organization_id===B).monthly_cap_pence).toBe(1000);
    });
    const asAdmin=(sql:string,params:unknown[]=[],application=label)=>withDb(async db=>{
      await db.query("BEGIN");
      try {
        await db.query("SELECT set_config('application_name',$1,TRUE)",[application]);
        await db.query("SET LOCAL ROLE authenticated");
        await db.query("SELECT set_config('request.jwt.claims',$1,TRUE),set_config('request.jwt.claim.sub',$2,TRUE)",[JSON.stringify(claims),owner.id]);
        const result=await db.query(sql,params);await db.query("COMMIT");return result;
      } catch(error) {await db.query("ROLLBACK");throw error;}
    });
    await asAdmin("SELECT public.ai_helper_set_tolra_mode(TRUE)");
    await expect(asAdmin("SELECT public.ai_helper_tolra_set_cap($1,99999,$2)",[A,owner.id])).rejects.toMatchObject({code:"42501"});
    // The old own-account limit cannot override the provided-account cap.
    await asAdmin("SELECT public.ai_helper_save_settings(TRUE,TRUE,100000)");
    const reserve=(pence:number,application=label)=>asAdmin("SELECT public.ai_helper_reserve('rfq',$1,$2,10) AS r",[pence,"c".repeat(64)],application);
    expect((await reserve(16)).rows[0].r).toMatchObject({ok:false,reason:"cap"});

    const results=await withDb(async blocker=>{
      await blocker.query("BEGIN");
      await blocker.query("SELECT * FROM public.ai_helper_usage WHERE organization_id=$1 FOR UPDATE",[A]);
      let failed:unknown;
      const pending=Promise.all([reserve(10,`${label}-1`),reserve(10,`${label}-2`)]);
      void pending.catch(error=>{failed=error;});
      try {
        const deadline=Date.now()+15_000;
        while(true) {
          if(failed)throw failed;
          const count=await withDb(db=>db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN ($1,$2) AND wait_event_type='Lock'",[`${label}-1`,`${label}-2`]));
          if(count.rows[0].n===2)break;
          if(Date.now()>deadline)throw new Error("Both independent reservations must contend on the held ledger lock");
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        await blocker.query("COMMIT");
      } catch(error) {await blocker.query("ROLLBACK");await pending.catch(()=>{});throw error;}
      return await pending;
    });
    const answers=results.map(result=>result.rows[0].r);
    expect(answers.filter(answer=>answer.ok)).toHaveLength(1);
    expect(answers.filter(answer=>answer.reason==="cap")).toHaveLength(1);
    await withDb(async db=>{
      const usage=(await db.query("SELECT spent_pence,reserved_pence FROM public.ai_helper_usage WHERE organization_id=$1",[A])).rows[0];
      expect(usage.spent_pence+usage.reserved_pence).toBe(10);
      await expect(db.query("SELECT public.ai_helper_tolra_set_cap($1,9,$2)",[A,owner.id])).rejects.toMatchObject({code:"22023",hint:"cap_below_usage"});
      expect((await db.query("SELECT monthly_cap_pence FROM public.ai_helper_tolra_companies WHERE organization_id=$1",[A])).rows[0].monthly_cap_pence).toBe(15);
      const request=answers.find(answer=>answer.ok).request_id;
      await db.query("SELECT public.ai_helper_settle($1,'failed','unavailable',10,NULL,NULL)",[request]);
    });
    expect((await reserve(6)).rows[0].r).toMatchObject({ok:false,reason:"cap"});
  } finally {
    if(control)await withDb(db=>db.query("UPDATE public.ai_helper_tolra_control SET enabled=$1,api_key_enc=$2,updated_by=$3,updated_at=$4 WHERE singleton",[control!.enabled,control!.api_key_enc,control!.updated_by,control!.updated_at]));
    if(world)await destroySyntheticWorld(world.runId);
  }
},120_000);
