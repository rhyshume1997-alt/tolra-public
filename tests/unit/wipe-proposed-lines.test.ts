import { readFileSync } from "node:fs";
import { expect,it } from "vitest";
import { parseWipeRows,validateWipeRows } from "../support/wipe-proposed-lines";
const source=readFileSync('tests/WIPE-KIT-PROPOSED-LINES.md','utf8');
const existing=JSON.parse(readFileSync('tests/fixtures/wipe-kit/reviewed-table-list.json','utf8')).rows;
const proposed=parseWipeRows(source);
it("parses nine decisions, protected archive and AI history against the reviewed table list",()=>{expect(proposed).toHaveLength(12);expect(validateWipeRows(existing,proposed)).toEqual([]);});
it("rejects a wrong decision, duplicate ordinal, unscoped wipe and deletion after parent",()=>{
 expect(validateWipeRows(existing,proposed.map(r=>r.table==='public.chase_sends'?{...r,action:'KEEP'}:r))).toContain('Wrong/missing reviewer decision: chase_sends');
 expect(validateWipeRows(existing,[...proposed,proposed[0]])).toContain('Duplicate ordinal 89');
 expect(validateWipeRows(existing,proposed.map(r=>r.table==='public.chase_sends'?{...r,predicate:'TRUE'}:r))).toContain('Unscoped wipe: public.chase_sends');
 expect(validateWipeRows(existing,proposed.map(r=>r.table==='public.chase_sends'?{...r,ord:999}:r))).toContain('Unsafe parent order: chase_sends before invoices');
});
it("preserves exact evidence before protected capture and keeps immutable history out of FK cascades",()=>{
 expect(source).toContain('before section 2 captures protected fingerprints');
 expect(source).toContain("a.evidence = r.evidence");expect(source).toContain("ON CONFLICT (organization_id, chase_send_id) DO NOTHING");
 expect(source).toContain('REFUSED: archived approval evidence differs');expect(source).toContain('CHASE_EVIDENCE_ARCHIVED');
 const ddl=source.split('CREATE TABLE security_audit.chase_approval_evidence')[1].split('```')[0];
 expect(ddl).not.toMatch(/REFERENCES public\.(invoices|email_history|chase_sends)/);
 expect(ddl).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');expect(ddl).toContain('ENABLE ROW LEVEL SECURITY');
 expect(source).toContain("provider IN ('xero', 'sage', 'quickbooks')");expect(source).toContain('WHERE organization_id = c_jnr');
 expect(source).not.toMatch(/ALTER TABLE[^\n]*DISABLE|DELETE FROM public\./);
});
