import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {db,sql} from './fixture';
const release='supabase/release/151_xero_invite_hardening.release.sql',verify='supabase/verify/xero_invite_hardening_151.sql',rollback='supabase/release/151_xero_invite_hardening.rollback.sql';
it('proposal 151 applies, verifies and rolls back with prior audit rows preserved',async()=>{
 await db.query(sql(release));
 const rows=(await db.query(sql(verify))).rows;expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.ok===true)).toBe(true);
 writeFileSync('tests/reviews/night-151-package/evidence/verify-rows.json',JSON.stringify(rows,null,2)+'\n');
 const org=randomUUID(),admin=randomUUID();await db.query("insert into organizations(id,name,slug,status) values($1,'Synthetic151',$2,'active')",[org,'t-release151-'+org]);await db.query('insert into auth.users(id,email) values($1,$2)',[admin,admin+'@example.test']);
 // Direct owner fixture row exercises the rollback guard, not an application identity proof (covered by PR423).
 await db.query("insert into integration_connect_invites(organization_id,provider,created_by,ref,recipient_email,expires_at) values($1,'xero',$2,$3,'bound@example.test',now()+interval '1 hour')",[org,admin,'R'.repeat(22)]);
 await expect(db.query(sql(rollback))).rejects.toThrow(/open connect invites/);await db.query('rollback');
 expect((await db.query(sql(verify))).rows.every(r=>r.ok===true)).toBe(true);
 await db.query("update integration_connect_invites set revoked_at=now(),revoke_reason='cancelled',code_hash=null where organization_id=$1",[org]);
 const before=(await db.query('select to_jsonb(a) as row from security_audit.audit_log a order by id')).rows;
 await db.query(sql(rollback));expect((await db.query("select to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') is null as gone")).rows[0].gone).toBe(true);
 expect((await db.query('select to_jsonb(a) as row from security_audit.audit_log a order by id')).rows).toEqual(before);
 expect((await db.query('select count(*)::int as n from organizations where id=$1',[org])).rows[0].n).toBe(1);
 // The rollback explicitly drops refusal-log rows; it preserves the separate company audit log. Do not claim otherwise.
 expect((await db.query("select to_regclass('security_audit.integration_invite_refusals') is null as gone")).rows[0].gone).toBe(true);
 await db.query(sql(release));expect((await db.query(sql(verify))).rows.every(r=>r.ok===true)).toBe(true);
});

it('151 verification rejects a service security-definer callback with a temporary-schema-first search path',async()=>{
 await db.query('begin');try{
  await db.query('alter function public.integration_invite_code_verify(text,text,text,text) set search_path=pg_temp,public');
  const rows=(await db.query(sql(verify))).rows;
  expect(rows.some(r=>r.ok!==true),'the verifier claims a pinned search path, but pg_temp now precedes public').toBe(true);
 }finally{await db.query('rollback');}
});
