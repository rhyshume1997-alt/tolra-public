import { NextResponse } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only",()=>({}));
const fixture=vi.hoisted(()=>({
  actor:"00000000-0000-4000-8000-0000000000a1",
  rows:new Map<string,{roundup_enabled:boolean;rfq_enabled:boolean;monthly_cap_pence:number}>(),
  mutations:[] as {name:string;args:Record<string,unknown>}[],reads:[] as string[],
}));
const rpc=async(name:string,args:Record<string,unknown>)=>{
  if(name!=="ai_helper_save_settings")throw new Error(`Unexpected mutation: ${name}`);
  fixture.mutations.push({name,args});
  // Like the real RPC, the fake derives company from the authenticated session.
  // A new organization argument would fail the exact-call assertion below.
  const row={roundup_enabled:args.p_roundup===true,rfq_enabled:args.p_rfq===true,monthly_cap_pence:Number(args.p_cap_pence)};
  fixture.rows.set(fixture.actor,row);return {data:row,error:null};
};
const from=(table:string)=>{
  if(table!=="ai_helper_settings")throw new Error(`Unexpected read: ${table}`);
  let org:unknown;
  const query={select:()=>query,eq:(field:string,value:unknown)=>{expect(field).toBe("organization_id");org=value;return query;},maybeSingle:async()=>{
    expect(org).toBe(fixture.actor);fixture.reads.push(String(org));
    return {data:{...fixture.rows.get(String(org)),finance_check_enabled:false},error:null};
  }};return query;
};
vi.mock("@/lib/server/auth",()=>({
  sameOrigin:()=>true,forbiddenOrigin:()=>NextResponse.json({}, {status:403}),
  isErrorResponse:(value:unknown)=>value instanceof NextResponse,
  jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),
  readJson:async(request:Request)=>({ok:true,data:await request.json()}),
  requireProfile:async(roles:string[])=>{
    expect(roles).toEqual(["admin"]);
    return {supabase:{rpc,from},profile:{organization_id:fixture.actor},session:{support:false}};
  },
}));
import { POST } from "@/app/api/ai-helper/settings/route";
afterEach(()=>vi.unstubAllEnvs());

it("Company A cannot change B's AI settings by supplying B in the body or URL; legitimate changes still update A only",async()=>{
  vi.stubEnv("AI_HELPER_ENABLED","true");vi.stubEnv("AI_ASSISTANT_ENABLED","false");
  const A=fixture.actor,B="00000000-0000-4000-8000-0000000000b2";
  const beforeA={roundup_enabled:false,rfq_enabled:false,monthly_cap_pence:500};
  const beforeB={roundup_enabled:true,rfq_enabled:false,monthly_cap_pence:900};
  fixture.rows.clear();fixture.rows.set(A,{...beforeA});fixture.rows.set(B,{...beforeB});fixture.mutations=[];fixture.reads=[];
  const values={roundupEnabled:true,rfqEnabled:true,monthlyCapPence:750};
  const post=(body:unknown,query="")=>POST(new Request(`http://localhost/api/ai-helper/settings${query}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
  for(const field of ["organizationId","organization_id","companyId","p_org"]) {
    expect((await post({...values,[field]:B})).status).toBe(400);
    expect(fixture.rows.get(A)).toEqual(beforeA);expect(fixture.rows.get(B)).toEqual(beforeB);
  }
  expect(fixture.mutations).toEqual([]);
  // A URL company selector is ignored, not forwarded as an RPC target.
  const response=await post(values,`?organizationId=${B}&organization_id=${B}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({roundup_enabled:true,rfq_enabled:true,monthly_cap_pence:750});
  expect(fixture.mutations).toEqual([{name:"ai_helper_save_settings",args:{p_roundup:true,p_rfq:true,p_cap_pence:750}}]);
  expect(fixture.rows.get(A)).toEqual({roundup_enabled:true,rfq_enabled:true,monthly_cap_pence:750});
  expect(fixture.rows.get(B)).toEqual(beforeB);expect(fixture.reads).toEqual([A]);
});
