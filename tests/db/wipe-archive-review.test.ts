/** Requires separately reviewed archive/KEEP schemas. No installer, skip or live provider. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {expect,it} from 'vitest';
import {verifyBackendIdentity,withDb} from '../support/fixtures';
const proposal=readFileSync('tests/WIPE-KIT-PROPOSED-LINES.md','utf8');
const body=proposal.split('```sql\nDECLARE\n')[1]?.split('```')[0];
if(!body)throw new Error('Missing proposed archive block');
// Only source relations are redirected; archive, permission checks and audit append are real.
const archiveSql='DO $review$\nDECLARE\n'+body.replaceAll('public.chase_sends','pg_temp.review_sends').replaceAll('public.invoices','pg_temp.review_invoices').replaceAll('public.email_history','pg_temp.review_emails')+'\n$review$;';
async function transaction(fn:(db:Client)=>Promise<void>){await verifyBackendIdentity();await withDb(async db=>{await db.query('BEGIN');try{expect((await db.query("SELECT to_regclass('security_audit.chase_approval_evidence') IS NOT NULL AS ready")).rows[0].ready,'Reviewed archive must be prepared separately').toBe(true);await fn(db);}finally{await db.query('ROLLBACK');}});}
async function denied(db:Client,sql:string,code:string){await db.query('SAVEPOINT denial');await expect(db.query(sql)).rejects.toMatchObject({code});await db.query('ROLLBACK TO SAVEPOINT denial');await db.query('RELEASE SAVEPOINT denial');}
async function seed(db:Client){
 const orgs=[randomUUID(),randomUUID()];
 for(const [index,org] of orgs.entries()){
  const user=randomUUID(),email=`${user}@example.test`;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')",[org,index?'Synthetic Marpet':'Synthetic JNR',`t-wipe-${org}`]);
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[user,email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic','admin',$3,true,false)",[user,email,org]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',true)",[user,org]);
  await db.query("INSERT INTO public.organization_settings(organization_id,hidden_nav) VALUES($1,ARRAY['synthetic-setting']) ON CONFLICT(organization_id) DO UPDATE SET hidden_nav=EXCLUDED.hidden_nav",[org]);
  await db.query("INSERT INTO public.doc_counters(organization_id,prefix,last) VALUES($1,'INV',123)",[org]);
 }
 await db.query('CREATE TEMP TABLE b11_cfg(org_txt text)');await db.query('INSERT INTO b11_cfg VALUES($1)',[orgs[0]]);
 return orgs;
}
async function twins(db:Client,orgs:string[]){
 await db.query('CREATE TEMP TABLE review_sends(id uuid,organization_id uuid,invoice_id uuid,draft_history_id uuid,sent_history_id uuid,status text,approved_by uuid,approved_at timestamptz); CREATE TEMP TABLE review_invoices(id uuid,organization_id uuid,total numeric); CREATE TEMP TABLE review_emails(id uuid,organization_id uuid,subject text,body text);');
 const sends=[];
 for(const org of orgs){const invoice=randomUUID(),draft=randomUUID(),sent=randomUUID(),id=randomUUID();sends.push(id);
  await db.query('INSERT INTO review_invoices VALUES($1,$2,123.45)',[invoice,org]);
  await db.query("INSERT INTO review_emails VALUES($1,$2,'Exact subject',E'Exact body\\n'),($3,$2,'Exact subject',E'Exact body\\n')",[draft,org,sent]);
  await db.query("INSERT INTO review_sends VALUES($1,$2,$3,$4,$5,'sent',$6,now())",[id,org,invoice,draft,sent,randomUUID()]);
 }
 return sends;
}
async function protectedRows(db:Client){
 const names=['public.organizations','public.organization_settings','public.user_profiles','public.organization_members','public.doc_counters','auth.users','auth.sessions','public.chase_steps','public.costing_materials','public.costing_machines','public.costing_defaults','public.company_setup_progress','public.ai_helper_tolra_companies','public.ai_helper_tolra_control'];
 const rows:Record<string,unknown[]>={};
 for(const table of names){expect((await db.query('SELECT to_regclass($1) IS NOT NULL AS ready',[table])).rows[0].ready,`Required KEEP table ${table}`).toBe(true);rows[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;}
 return rows;
}
it('archive API roles have no read/write rights and even its owner cannot update delete or truncate',async()=>transaction(async db=>{
 const orgs=await seed(db),id=randomUUID();
 await db.query("INSERT INTO security_audit.chase_approval_evidence(organization_id,chase_send_id,evidence,evidence_sha256) VALUES($1,$2,'{}',encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'))",[orgs[0],id]);
 for(const role of ['anon','authenticated','service_role']){
  await db.query('SET LOCAL ROLE '+role);
  for(const sql of ['SELECT * FROM security_audit.chase_approval_evidence','INSERT INTO security_audit.chase_approval_evidence DEFAULT VALUES','UPDATE security_audit.chase_approval_evidence SET archived_at=now()','DELETE FROM security_audit.chase_approval_evidence','TRUNCATE security_audit.chase_approval_evidence'])await denied(db,sql,'42501');
  await db.query('RESET ROLE');
 }
 for(const sql of ['UPDATE security_audit.chase_approval_evidence SET archived_at=now()','DELETE FROM security_audit.chase_approval_evidence','TRUNCATE security_audit.chase_approval_evidence'])await denied(db,sql,'P0001');
 expect((await db.query('SELECT count(*)::int AS n FROM security_audit.chase_approval_evidence WHERE chase_send_id=$1',[id])).rows[0].n).toBe(1);
}));
it.each(['missing invoice','changed approval','incomplete archive'])('the whole archival operation refuses %s and rolls back partial evidence',async failure=>transaction(async db=>{
 const orgs=await seed(db),sends=await twins(db,orgs);
 if(failure==='missing invoice')await db.query('DELETE FROM review_invoices WHERE organization_id=$1',[orgs[0]]);
 if(failure==='changed approval')await db.query("INSERT INTO security_audit.chase_approval_evidence(organization_id,chase_send_id,evidence,evidence_sha256) VALUES($1,$2,'{}',encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'))",[orgs[0],sends[0]]);
 if(failure==='incomplete archive'){
  // Suppress insertion without weakening/disabling the real immutable trigger.
  await db.query('CREATE FUNCTION pg_temp.suppress_review_copy() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END;$$; CREATE TRIGGER review_suppress BEFORE INSERT ON security_audit.chase_approval_evidence FOR EACH ROW EXECUTE FUNCTION pg_temp.suppress_review_copy();');
 }
 const before=(await db.query('SELECT * FROM security_audit.chase_approval_evidence ORDER BY organization_id,chase_send_id')).rows;
 await denied(db,archiveSql,'P0001');
 expect((await db.query('SELECT * FROM security_audit.chase_approval_evidence ORDER BY organization_id,chase_send_id')).rows).toEqual(before);
 expect((await db.query('SELECT count(*)::int AS n FROM review_sends')).rows[0].n).toBe(2);
}));
it('two-company before/after keeps Marpet logins settings numbering KEEP tables and prior audit unchanged',async()=>transaction(async db=>{
 const orgs=await seed(db);await twins(db,orgs);
 const before=await protectedRows(db),audit=(await db.query('SELECT to_jsonb(a) AS row FROM security_audit.audit_log a ORDER BY id')).rows;
 const marpetSnapshot=async()=>{const snapshot:Record<string,unknown[]>={};for(const table of ['review_sends','review_invoices','review_emails'])snapshot[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text`,[orgs[1]])).rows;return snapshot;};
 const marpet=await marpetSnapshot();
 await db.query(archiveSql);
 expect((await db.query('SELECT organization_id FROM security_audit.chase_approval_evidence WHERE organization_id=ANY($1::uuid[])',[orgs])).rows).toEqual([{organization_id:orgs[0]}]);
 // Copy verified first; only then delete JNR source twins, children before invoice.
 await db.query('DELETE FROM review_sends WHERE organization_id=$1',[orgs[0]]);await db.query('DELETE FROM review_invoices WHERE organization_id=$1',[orgs[0]]);
 expect(await protectedRows(db)).toEqual(before);
 expect(await marpetSnapshot()).toEqual(marpet);
 const after=(await db.query('SELECT to_jsonb(a) AS row FROM security_audit.audit_log a ORDER BY id')).rows;
 for(const row of audit)expect(after).toContainEqual(row);
 expect(after.filter(row=>!audit.some(old=>JSON.stringify(old)===JSON.stringify(row)))).toHaveLength(1);
}));
it.each(['xero','sage','quickbooks'])('disconnect preflight checks %s for JNR only and leaves Marpet connected',async provider=>transaction(async db=>{
 const orgs=await seed(db);
 await db.query('CREATE TEMP TABLE review_connections(organization_id uuid,provider text,status text)');
 await db.query("INSERT INTO review_connections VALUES($1,$3,'disconnected'),($2,$3,'connected')",[orgs[0],orgs[1],provider]);
 const check=()=>db.query("SELECT EXISTS(SELECT 1 FROM review_connections WHERE organization_id=$1 AND provider IN ('xero','sage','quickbooks') AND status IS DISTINCT FROM 'disconnected') AS blocked",[orgs[0]]);
 expect((await check()).rows[0].blocked).toBe(false);
 await db.query("UPDATE review_connections SET status='connected' WHERE organization_id=$1",[orgs[0]]);
 expect((await check()).rows[0].blocked).toBe(true);
 expect((await db.query('SELECT status FROM review_connections WHERE organization_id=$1',[orgs[1]])).rows).toEqual([{status:'connected'}]);
}));
