import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Disposable } from './disposable';
const db = new Disposable();
const J='11111111-1111-4111-8111-111111111111', M='22222222-2222-4222-8222-222222222222', U='33333333-3333-4333-8333-333333333333';
const source = (p: string) => readFileSync(p,'utf8');
const tableNames = ['customers','suppliers','stock','quotes','quote_line_items','quote_attachments','rfqs','purchase_orders','email_history','invoices','invoice_line_items','sales_orders','jobs','delivery_notes','delivery_note_items','machines'];
const role = (sql: string) => `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated","aal":"aal1","session_id":"44444444-4444-4444-8444-444444444444"}',true); ${sql}; ROLLBACK;`;
const last = (text: string) => text.split('\n').filter(x=>x && !['BEGIN','ROLLBACK'].includes(x)).at(-1);
const fingerprint = (org: string) => `SELECT jsonb_build_array(${tableNames.map(t=>`(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.${t} t WHERE organization_id='${org}')`).join(',')},(SELECT jsonb_agg(to_jsonb(t)) FROM public.dln_numbering_pending t WHERE organization_id='${org}'))::text`;
beforeAll(async () => {
  await db.start();
  db.ok(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA security_audit;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (auth.jwt()->>'sub')::uuid$$;
    CREATE TABLE auth.users(id uuid,banned_until timestamptz);
    CREATE TABLE organizations(id uuid PRIMARY KEY,status text);
    CREATE TABLE user_profiles(id uuid,active boolean,must_change_password boolean);
    CREATE TABLE organization_members(user_id uuid,organization_id uuid,role text,secondary_role text,support boolean,expires_at timestamptz,hidden_sections text[],support_grant uuid,active boolean);
    CREATE TABLE security_audit.platform_admins(user_id uuid);
    CREATE TABLE security_audit.session_company(user_id uuid,session_id uuid,organization_id uuid,elevated_until timestamptz,grant_id uuid);
    INSERT INTO organizations VALUES('${J}','active'),('${M}','active');
    INSERT INTO user_profiles VALUES('${U}',true,false);
    INSERT INTO organization_members VALUES('${U}','${J}','admin',null,false,null,'{}',null,true);
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
    ${tableNames.map(t=>`CREATE TABLE public.${t}(id uuid PRIMARY KEY,organization_id uuid,value text,drafted_by uuid); INSERT INTO public.${t} VALUES('${J}','${J}','Synthetic JNR','${U}'),('${M}','${M}','Synthetic Marpet','${U}');`).join('\n')}`);
  const resolver = source('supabase/migrations/121_rls_helper_speed.sql');
  db.ok(resolver.slice(resolver.indexOf('CREATE OR REPLACE FUNCTION public._session_membership()'),resolver.indexOf('-- 3. Self-check')));
  const helpers=source('supabase/migrations/036_two_level_access.sql');
  db.ok(helpers.slice(helpers.indexOf('CREATE OR REPLACE FUNCTION public.section_allowed'),helpers.indexOf('-- TRUE while the caller')));
  const rbac=source('supabase/migrations/006_production_hardening.sql');
  const start=rbac.indexOf("DO $do$\nDECLARE\n  a    TEXT[]");
  db.ok(rbac.slice(start,rbac.indexOf('END\n$do$;',start)+11));
  // Read only an immutable public blob; never checks out or modifies #359 or its branch.
  const release=execFileSync('git',['show','31f965e7f0cbb2d9caf336b0a2067411bec8fb45:supabase/release/147_job_delivery_note.release.sql'],{encoding:'utf8'});
  db.ok(release.slice(release.indexOf('CREATE TABLE public.dln_numbering_pending'),release.indexOf('-- 3. Numbering guard')));
  console.log(`X4 evidence: ${db.evidence}`);
});
afterAll(()=>db.stop());
it.each(tableNames)('JNR cannot read, update, delete or move a Marpet row in %s under the selected real RLS policies', table => {
  expect(last(db.ok(role(`SELECT count(*) FROM public.${table} WHERE organization_id='${M}'`)))).toBe('0');
  expect(db.ok(role(`UPDATE public.${table} SET value='hostile' WHERE organization_id='${M}'; DELETE FROM public.${table} WHERE organization_id='${M}'`))).toContain('UPDATE 0');
  expect(db.sql(role(`UPDATE public.${table} SET organization_id='${M}' WHERE organization_id='${J}'`)).code).not.toBe(0);
  expect(db.ok(`SELECT value FROM public.${table} WHERE organization_id='${M}'`)).toBe('Synthetic Marpet');
});
it('JNR cannot read or change either company’s private numbering hold', () => {
  for (const statement of ['SELECT * FROM','DELETE FROM','UPDATE']) {
    const q=statement==='UPDATE' ? `UPDATE public.dln_numbering_pending SET organization_id='${J}' WHERE organization_id='${M}'` : `${statement} public.dln_numbering_pending`;
    expect(db.sql(role(q)).code).not.toBe(0);
  }
  expect(db.ok('SELECT count(*) FROM dln_numbering_pending')).toBe('2');
});
it('forging a company choice without membership does not grant Marpet access', () => {
  db.ok(`INSERT INTO security_audit.session_company VALUES('${U}','44444444-4444-4444-8444-444444444444','${M}',null,null)`);
  expect(last(db.ok(role('SELECT public.current_user_organization_id()')))).toBe(J);
});
it('a fixture-only JNR purge leaves all sampled Marpet rows and BOTH numbering holds byte-identical', () => {
  const before=db.ok(fingerprint(M)), holds=db.ok('SELECT jsonb_agg(t ORDER BY organization_id)::text FROM dln_numbering_pending t');
  db.ok(`BEGIN; ${tableNames.map(t=>`DELETE FROM public.${t} WHERE organization_id='${J}';`).join('\n')} COMMIT;`);
  expect(db.ok(fingerprint(M))).toBe(before);
  expect(db.ok('SELECT jsonb_agg(t ORDER BY organization_id)::text FROM dln_numbering_pending t')).toBe(holds);
});
it('detects a bad global wipe and rolls the attempted change back', () => {
  const before=db.ok(fingerprint(M));
  const r=db.sql(`BEGIN; DELETE FROM delivery_notes; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM delivery_notes WHERE organization_id='${M}') THEN RAISE EXCEPTION 'Marpet fingerprint changed: refuse'; END IF; END $$; COMMIT;`);
  expect(r.code).not.toBe(0); expect(db.ok(fingerprint(M))).toBe(before);
});
