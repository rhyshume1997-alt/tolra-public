import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Disposable } from './disposable';
const db=new Disposable(), J='11111111-1111-4111-8111-111111111111',M='22222222-2222-4222-8222-222222222222';
const snapshot=()=>db.ok("SELECT jsonb_build_object('notes',(SELECT jsonb_agg(n) FROM delivery_notes n),'holds',(SELECT jsonb_agg(h ORDER BY organization_id) FROM dln_numbering_pending h))::text");
beforeAll(async()=>{
 await db.start();
 db.ok(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE TABLE organizations(id uuid PRIMARY KEY);
 INSERT INTO organizations VALUES('${J}'),('${M}');CREATE TABLE delivery_notes(organization_id uuid,dn_number text);
 GRANT INSERT,UPDATE,SELECT ON delivery_notes TO authenticated;
 -- An allocator sentinel, not replacement allocator arithmetic: the held path must refuse BEFORE this is called.
 CREATE FUNCTION next_doc_number(text) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'ALLOCATOR REACHED';END$$;`);
 const release=execFileSync('git',['show','31f965e7f0cbb2d9caf336b0a2067411bec8fb45:supabase/release/147_job_delivery_note.release.sql'],{encoding:'utf8'});
 db.ok(release.slice(release.indexOf('CREATE TABLE public.dln_numbering_pending'),release.indexOf('-- 4. A delivery note')));
 console.log(`G06 evidence: ${db.evidence}`);
});
afterAll(()=>db.stop());
it.each([null,'DLN-9999'])('refuses number %s before the counter step, leaves both companies untouched and never reaches allocation',number=>{
 const before=snapshot();
 const result=db.sql(`BEGIN;SET LOCAL ROLE authenticated;INSERT INTO delivery_notes VALUES('${J}',${number===null?'NULL':`'${number}'`});COMMIT;`);
 expect(result.code).not.toBe(0);expect(result.error).toContain('dln_numbering_not_set');
 expect(result.error).not.toContain('ALLOCATOR REACHED');expect(snapshot()).toBe(before);
});
it('keeps the other company held when only JNR’s hold is lifted in a synthetic setup',()=>{
 db.ok(`DELETE FROM dln_numbering_pending WHERE organization_id='${J}'`);
 const before=snapshot(), result=db.sql(`BEGIN;SET LOCAL ROLE authenticated;INSERT INTO delivery_notes VALUES('${M}',NULL);COMMIT;`);
 expect(result.error).toContain('dln_numbering_not_set');expect(snapshot()).toBe(before);
});
