import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only",()=>({}));
const A="00000000-0000-4000-8000-0000000000a1",B="00000000-0000-4000-8000-0000000000b2";
const fixture=vi.hoisted(()=>({owner:true,mfa:true,calls:[] as {name:string;args:Record<string,unknown>}[],caps:new Map<string,number>(),used:new Map<string,number>()}));
const rpc=async(name:string,args:Record<string,unknown>={})=>{
  fixture.calls.push({name,args});
  if(name==="ai_helper_tolra_caps")return {data:[A,B].map(organization_id=>({organization_id,monthly_cap_pence:fixture.caps.get(organization_id)??1000,spent_pence:fixture.used.get(organization_id)??0,reserved_pence:0})),error:null};
  if(name!=="ai_helper_tolra_set_cap")throw new Error(`Unexpected RPC ${name}`);
  const org=String(args.p_org),cap=Number(args.p_cap_pence);
  if(cap<(fixture.used.get(org)??0))return {data:null,error:{code:"22023",hint:"cap_below_usage"}};
  fixture.caps.set(org,cap);return {data:null,error:null};
};
vi.mock("@/lib/server/platform",()=>({requirePlatformOwner:async()=>fixture.owner&&fixture.mfa?{admin:{rpc},user:{id:A},companies:[{organization_id:A,name:"Company A"},{organization_id:B,name:"Company B"}]}:NextResponse.json({error:"Forbidden"},{status:403})}));
vi.mock("@/lib/server/auth",()=>({isErrorResponse:(v:unknown)=>v instanceof NextResponse,jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),readJson:async(r:Request)=>({ok:true,data:await r.json()})}));
import { GET,POST } from "@/app/api/platform/tolra-ai/caps/route";
const request=(body:unknown)=>new Request("https://tolra.example.test/api/platform/tolra-ai/caps",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{fixture.owner=true;fixture.mfa=true;fixture.calls=[];fixture.caps.clear();fixture.used.clear();});
afterEach(()=>vi.restoreAllMocks());

it("starts at 1000p, shows the maximum, and changing A's cap leaves B at its default",async()=>{
  expect((await (await GET(request({}))).json())).toMatchObject({defaultCapPence:1000,maximumCapPence:100000,companies:[{organizationId:A,monthlyCapPence:1000},{organizationId:B,monthlyCapPence:1000}]});
  const result=await POST(request({organizationId:A,monthlyCapPence:1500}));expect(result.status).toBe(200);
  expect(await result.json()).toEqual({organizationId:A,monthlyCapPence:1500});
  expect(fixture.caps.get(A)).toBe(1500);expect(fixture.caps.has(B)).toBe(false);
  expect(fixture.calls.at(-1)).toEqual({name:"ai_helper_tolra_set_cap",args:{p_org:A,p_cap_pence:1500,p_owner:A}});
});
it.each(["company admin","owner without MFA"])("refuses %s before any cap read/write",async actor=>{
  fixture.owner=actor!=="company admin";fixture.mfa=actor!=="owner without MFA";
  expect((await GET(request({}))).status).toBe(403);
  expect((await POST(request({organizationId:A,monthlyCapPence:9999}))).status).toBe(403);expect(fixture.calls).toEqual([]);
});
it.each([-1,1.5,100001,"1000",null])("refuses invalid cap %j",async monthlyCapPence=>{
  expect((await POST(request({organizationId:A,monthlyCapPence}))).status).toBe(400);expect(fixture.calls).toEqual([]);
});
it("refuses unknown companies and limits below already committed usage",async()=>{
  expect((await POST(request({organizationId:"00000000-0000-4000-8000-0000000000c3",monthlyCapPence:1000}))).status).toBe(404);
  expect(fixture.calls).toEqual([]);fixture.used.set(A,800);fixture.caps.set(A,1000);
  expect((await POST(request({organizationId:A,monthlyCapPence:799}))).status).toBe(409);expect(fixture.caps.get(A)).toBe(1000);
});
it("SQL bounds caps, locks cap edits against reservations and keeps the conditional ledger update",()=>{
  const sql=readFileSync("supabase/proposals/n2_tolra_provided_ai.sql","utf8");
  expect(sql).toContain("monthly_cap_pence INTEGER NOT NULL DEFAULT 1000 CHECK (monthly_cap_pence BETWEEN 0 AND 100000)");
  expect(sql).toContain("WHERE c.organization_id = p_org FOR UPDATE");
  expect(sql).toContain("s.organization_id = v_org AND s.enabled FOR SHARE");
  expect(sql).toMatch(/u\.reserved_pence \+ u\.spent_pence \+ p_estimate_pence\s+<= v_cap/);
  expect(sql).toContain("IF p_cap_pence < v_used THEN");
  expect(sql).toContain("REVOKE ALL ON FUNCTION public.ai_helper_tolra_caps(), public.ai_helper_tolra_set_cap(UUID,INTEGER,UUID) FROM PUBLIC, anon, authenticated");
});
