import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertDisposableIdentity } from "../../scripts/demo-seed/identity.mjs";
const nonce="a31144a2-49c3-45ec-993b-706be2737cc0";
function database(overrides:Record<string,unknown>={}) {
 const calls:string[]=[];
 return {calls,query:async(sql:string,args?:unknown[])=>{calls.push(sql);
  if(sql.includes('to_regclass'))return {rows:[{marker:'demo_seed_guard.identity'}]};
  if(sql.includes('database_matches')){expect(args).toEqual([nonce]);return {rows:[{owner:true,database_matches:true,nonce_matches:true,fresh:true,...overrides}]};}
  expect(args).toEqual(['tolra-demo','Tolra Demo']);return {rows:[{foreign_companies:overrides.foreign_companies??0}]};
 }};
}
it("accepts only the matching unexpired server-side identity and fake-company scope",async()=>{const db=database();await assertDisposableIdentity(db,nonce);expect(db.calls).toHaveLength(3);});
it.each(['owner','database_matches','nonce_matches','fresh'])("refuses an invalid %s proof before any company or data change",async(field)=>{const db=database({[field]:false});await expect(assertDisposableIdentity(db,nonce)).rejects.toThrow('Refusing');expect(db.calls).toHaveLength(2);});
it("refuses every non-demo company even on localhost",async()=>{await expect(assertDisposableIdentity(database({foreign_companies:1}),nonce)).rejects.toThrow('other than Tolra Demo');});
it("refuses missing identity before any SQL and a missing marker before any seed write",async()=>{const db=database();await expect(assertDisposableIdentity(db,undefined)).rejects.toThrow('DEMO_DISPOSABLE_ID');expect(db.calls).toEqual([]);await expect(assertDisposableIdentity({query:async()=>({rows:[{marker:null}]})},nonce)).rejects.toThrow('marker is missing');});
it("the CLI checks identity before any auth API call and retains the original guards/tests",()=>{
 const source=readFileSync('scripts/demo-seed/cli.mjs','utf8');expect(source.indexOf('await assertDisposableIdentity')).toBeLessThan(source.indexOf('const user = await api'));
 expect(source).toContain('assertThrowaway({ argv: process.argv.slice(2), env })');
 expect(source).toContain('if (existing.rowCount) throw');
});
