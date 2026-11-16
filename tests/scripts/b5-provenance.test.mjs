import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyProvenance } from "../../scripts/reviewer-evidence/verify-provenance.mjs";
const expected="a".repeat(40),hash=createHash("sha256").update("synthetic log\n").digest("hex");
function fixture(fn) {
 const dir=mkdtempSync(join(tmpdir(),"b5-provenance-"));writeFileSync(join(dir,"log.txt"),"synthetic log\n");
 const all=["prod","realistic","x100"].map((profile,i)=>({artifact_id:`fake-${i}`,profile,synthetic_only:true,checkout_sha:expected,executed_sha:expected,exit_code:0,environment:"synthetic local fixture",sql_sha256:"b".repeat(64),start_utc:"2026-11-04T00:00:00Z",end_utc:"2026-11-04T00:00:01Z",total:1,passed:1,failed:0,skipped:0,todo:0,identity:{kind:"disposable",nonce:"synthetic-nonce-123456",image_digest:"c".repeat(64),container_id:"d".repeat(64)},log_path:"log.txt",log_sha256:hash}));
 try {fn(all,dir);} finally {rmSync(dir,{recursive:true});}
}
test("complete synthetic manifests verify without running any commands",()=>fixture((all,dir)=>assert.equal(verifyProvenance(all,expected,dir).verified_artifacts,3)));
for(const [name,mutate] of [
 ["wrong checkout",a=>a[0].checkout_sha="e".repeat(40)], ["wrong executed head",a=>a[0].executed_sha="e".repeat(40)],
 ["nonzero exit",a=>a[0].exit_code=1], ["missing profile",a=>a.pop()], ["zero tests",a=>a[0].total=0],
 ["skipped tests",a=>a[0].skipped=1], ["missing SQL hash",a=>delete a[0].sql_sha256],
 ["localhost alone",a=>a[0].identity={host:"localhost"}], ["real-data profile",a=>a[0].synthetic_only=false],
 ["missing artifact ID",a=>delete a[0].artifact_id], ["mismatched log bytes",a=>a[0].log_sha256="f".repeat(64)],
 ["missing log",a=>a[0].log_path="absent.log"], ["reversed time",a=>a[0].start_utc="2026-11-05T00:00:00Z"],
]) test(`refuses ${name}`,()=>fixture((all,dir)=>{mutate(all);assert.throws(()=>verifyProvenance(all,expected,dir));}));
