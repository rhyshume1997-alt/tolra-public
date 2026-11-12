import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({supabase:null}));
vi.mock("@/lib/use-user", () => ({useUser:()=>({profile:{organization_id:"company-a"},activeRole:"admin"})}));
const state = vi.hoisted(()=>({
  role:"admin",support:false,owner:true,origin:true,mode:"tolra",globalOn:true,cap:false,keyAllowed:true,settleFails:false,
  encrypted:"",ownEncrypted:"",calls:[] as {fn:string;args:Record<string,unknown>}[],ownerResult:{enabled:true,key_set:true},
}));
const ORG="00000000-0000-4000-8000-0000000000a1";
const OTHER="00000000-0000-4000-8000-0000000000b2";
const REQ="33333333-3333-4333-8333-333333333333";
const KEY="sk-ant-SYNTHETIC-Tolra-private-provider-key";
const rpc=async(fn:string,args:Record<string,unknown>={})=>{
  state.calls.push({fn,args});
  if(fn==="ai_helper_reserve"||fn==="ai_helper_reserve_assistant") {
    if(state.mode==="tolra"&&!state.globalOn)return {data:null,error:{hint:"ai_helper_off"}};
    return {data:state.cap?{ok:false,reason:"cap",request_id:REQ}:{ok:true,request_id:REQ,key_source:state.mode},error:null};
  }
  if(fn==="ai_helper_tolra_key")return {data:state.keyAllowed&&state.globalOn&&args.p_org===ORG&&args.p_request===REQ?state.encrypted:null,error:null};
  if(fn==="ai_helper_tolra_configure"||fn==="ai_helper_tolra_owner_status")return {data:state.ownerResult,error:null};
  return {data:null,error:fn==="ai_helper_settle"&&state.settleFails?{code:"unavailable"}:null};
};
const service={rpc,from:(table:string)=>({select:()=>({eq:(col:string,org:string)=>({maybeSingle:async()=>({data:table==="ai_helper_secrets"&&col==="organization_id"&&org===ORG?{api_key_enc:state.ownEncrypted}:null,error:null})})})})};
vi.mock("@/lib/server/supabase-admin",()=>({createSupabaseAdminClient:()=>service}));
vi.mock("@/lib/server/auth",()=>({
  sameOrigin:()=>state.origin,
  forbiddenOrigin:()=>NextResponse.json({error:"Forbidden"},{status:403}),
  isErrorResponse:(r:unknown)=>r instanceof NextResponse,
  jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),
  readJson:async(r:Request)=>({ok:true,data:await r.json()}),
  requireProfile:async(roles:string[])=>roles.includes(state.role)?{supabase:{rpc},profile:{organization_id:ORG},session:{support:state.support}}:NextResponse.json({error:"Forbidden"},{status:403}),
}));
vi.mock("@/lib/server/platform",()=>({requirePlatformOwner:async()=>state.owner&&state.origin?{admin:service,user:{id:ORG}}:NextResponse.json({error:"Forbidden"},{status:403})}));

import { runAiHelper, outcomeMessage } from "@/lib/ai-helper/server";
import { encryptSecret, decryptSecret } from "@/lib/integrations/crypto";
import { TOLRA_AI_KEY_CONTEXT } from "@/lib/ai-helper/tolra-key-context";
import { POST as configure, GET as ownerStatus } from "@/app/api/platform/tolra-ai/route";
import { POST as companyToggle } from "@/app/api/ai-helper/tolra-mode/route";
import { TolraAiCard } from "@/components/integrations/tolra-ai-card";
import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import type { AiCompletionRequest } from "@/lib/ai-helper/provider";

const provider={id:"mock" as const,complete:vi.fn(async(request:AiCompletionRequest)=>({json:{answer:"Suggestion only"},usage:{inputTokens:10,outputTokens:10},model:request.model}))};
const post=(body:unknown)=>new Request("http://localhost/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const run=(organizationId=ORG,feature:"rfq"|"assistant"="rfq")=>runAiHelper({supabase:{rpc} as unknown as SupabaseClient,organizationId,feature,system:"Suggest only",data:"Synthetic data",schema:{type:"object"},validate:json=>({value:json,store:{kind:"rfq"}}),provider});
beforeEach(()=>{
  vi.stubEnv("AI_HELPER_ENABLED","true");
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY",Buffer.alloc(32,7).toString("base64"));
  Object.assign(state,{role:"admin",support:false,owner:true,origin:true,mode:"tolra",globalOn:true,cap:false,keyAllowed:true,settleFails:false,calls:[],ownerResult:{enabled:true,key_set:true}});
  state.encrypted=encryptSecret(KEY,TOLRA_AI_KEY_CONTEXT);
  state.ownEncrypted=encryptSecret("sk-ant-SYNTHETIC-company-key",{organizationId:ORG,provider:"anthropic",purpose:"api_key"});
  provider.complete.mockClear();
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

it.each(["rfq","assistant"] as const)("reserves %s under the caller before reading the Tolra key or calling the provider",async feature=>{
  expect(await run(ORG,feature)).toMatchObject({kind:"ok",requestId:REQ});
  expect(state.calls.map(c=>c.fn)).toEqual([feature==="assistant"?"ai_helper_reserve_assistant":"ai_helper_reserve","ai_helper_tolra_key","ai_helper_settle"]);
  expect(state.calls[1].args).toEqual({p_request:REQ,p_org:ORG});
  expect(provider.complete.mock.calls[0][0]).toMatchObject({apiKey:KEY});
  expect(JSON.stringify(state.calls)).not.toContain(KEY);
});
it("does no key read or provider call when the monthly allowance is full",async()=>{
  state.cap=true;expect(await run()).toMatchObject({kind:"cap"});
  expect(state.calls.map(c=>c.fn)).toEqual(["ai_helper_reserve"]);expect(provider.complete).not.toHaveBeenCalled();
});
it("refuses globally disabled provided AI without falling back to the company key",async()=>{
  state.globalOn=false;expect(await run()).toEqual({kind:"off"});
  expect(state.calls.map(c=>c.fn)).toEqual(["ai_helper_reserve"]);expect(provider.complete).not.toHaveBeenCalled();
});
it("cannot use a Tolra reservation with another company's identity",async()=>{
  expect(await run(OTHER)).toMatchObject({kind:"failed",detail:"tolra_key"});
  expect(provider.complete).not.toHaveBeenCalled();
  expect(state.calls.at(-1)).toMatchObject({fn:"ai_helper_settle",args:{p_status:"failed",p_cost_pence:0}});
});
it("cannot substitute a company ciphertext for the Tolra key",async()=>{
  state.encrypted=state.ownEncrypted;
  expect(await run()).toMatchObject({kind:"failed",detail:"tolra_key"});expect(provider.complete).not.toHaveBeenCalled();
});
it("keeps the old own-key path and never reads the Tolra key for it",async()=>{
  state.mode="own";expect(await run()).toMatchObject({kind:"ok"});
  expect(state.calls.map(c=>c.fn)).toEqual(["ai_helper_reserve","ai_helper_settle"]);
  expect(provider.complete.mock.calls[0][0]).toMatchObject({apiKey:"sk-ant-SYNTHETIC-company-key"});
});
it("does not show a suggestion whose usage could not be settled",async()=>{
  vi.spyOn(console,"error").mockImplementation(()=>{});state.settleFails=true;
  expect(await run()).toEqual({kind:"unavailable"});
});
it("keeps the full reservation for a Tolra request that may have been worked on",async()=>{
  vi.spyOn(console,"error").mockImplementation(()=>{});
  provider.complete.mockRejectedValueOnce(new Error("Synthetic timeout"));
  expect(await run()).toEqual({kind:"failed",failure:"unavailable",detail:undefined});
  expect(state.calls.at(-1)).toMatchObject({fn:"ai_helper_settle",args:{p_status:"failed",p_cost_pence:state.calls[0].args.p_estimate_pence}});
});
it("directs unreadable provided-account keys to Tolra instead of asking the company to replace them",()=>{
  const message=outcomeMessage({kind:"failed",failure:"unavailable",detail:"tolra_key"});
  expect(message.error).toContain("Ask Tolra to check it");expect(message.code).toBe("tolra_key_unavailable");
});
it("encrypts Rhys's key before saving, and never returns the saved value",async()=>{
  const logs=vi.spyOn(console,"error").mockImplementation(()=>{});
  const result=await configure(post({enabled:true,key:KEY}));expect(result.status).toBe(200);
  expect(await result.json()).toEqual({enabled:true,key_set:true});
  const saved=state.calls.find(c=>c.fn==="ai_helper_tolra_configure")!.args;
  expect(saved).toMatchObject({p_enabled:true,p_owner:ORG});
  expect(String(saved.p_key_enc)).toMatch(/^v1\./);expect(String(saved.p_key_enc)).not.toContain(KEY);
  expect(decryptSecret(String(saved.p_key_enc),TOLRA_AI_KEY_CONTEXT)).toBe(KEY);
  expect(await (await ownerStatus(post({}))).json()).toEqual({enabled:true,key_set:true});
  expect(JSON.stringify(logs.mock.calls)).not.toContain(KEY);
});
it("does not save anything when encryption is unavailable",async()=>{
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY","");expect((await configure(post({enabled:true,key:KEY}))).status).toBe(503);
  expect(state.calls).toEqual([]);
});
it("strips even unexpected key fields from both owner responses",async()=>{
  Object.assign(state.ownerResult,{api_key_enc:state.encrypted,key:KEY});
  for(const response of [await ownerStatus(post({})),await configure(post({enabled:false}))]) {
    expect(await response.json()).toEqual({enabled:true,key_set:true});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});
it("does not accept cap or billing settings in the global control",async()=>{
  expect((await configure(post({enabled:true,monthlyCapPence:99999}))).status).toBe(400);
  expect(state.calls).toEqual([]);
});
it("requires the platform-owner guard for both reading and changing global controls",async()=>{
  state.owner=false;expect((await configure(post({enabled:true,key:KEY}))).status).toBe(403);
  expect((await ownerStatus(post({}))).status).toBe(403);expect(state.calls).toEqual([]);
});
it("keeps the saved key when switching off without a replacement",async()=>{
  await configure(post({enabled:false}));expect(state.calls[0]).toEqual({fn:"ai_helper_tolra_configure",args:{p_enabled:false,p_key_enc:null,p_owner:ORG}});
});
it.each(["office","workshop","viewer"])("%s cannot change company mode",async role=>{
  state.role=role;expect((await companyToggle(post({enabled:true}))).status).toBe(403);expect(state.calls).toEqual([]);
});
it("refuses support and cross-origin company changes",async()=>{
  state.support=true;expect((await companyToggle(post({enabled:true}))).status).toBe(403);
  state.support=false;state.origin=false;expect((await companyToggle(post({enabled:true}))).status).toBe(403);expect(state.calls).toEqual([]);
});
it.each([{enabled:true,monthlyCapPence:99999},{enabled:true,organizationId:OTHER},{enabled:true,key:KEY}])("company settings accept on/off only: %j",async body=>{
  expect((await companyToggle(post(body))).status).toBe(400);expect(state.calls).toEqual([]);
});
it("lets the admin toggle only the caller's company, without an organization parameter",async()=>{
  expect((await companyToggle(post({enabled:true}))).status).toBe(200);
  expect(state.calls).toEqual([{fn:"ai_helper_set_tolra_mode",args:{p_enabled:true}}]);
});
it("refuses company changes while the existing server AI switch is off",async()=>{
  vi.stubEnv("AI_HELPER_ENABLED","false");
  expect((await companyToggle(post({enabled:true}))).status).toBe(404);expect(state.calls).toEqual([]);
});
it("hides the option before Rhys enables it and gives companies no key or allowance editor",()=>{
  const status:AiHelperStatus={roundup_enabled:false,rfq_enabled:false,monthly_cap_pence:500,key_set:false,key_last4:null,month_spent_pence:12,month_reserved_pence:3,can_manage:true};
  const render=(s:AiHelperStatus)=>renderToStaticMarkup(createElement(TolraAiCard,{status:s,onChanged:vi.fn()}));
  expect(render(status)).toBe("");expect(render({...status,tolra_available:false})).toBe("");
  const visible=render({...status,tolra_available:true,tolra_cap_pence:1000});
  expect(visible).toContain("Turn Tolra AI on");expect(visible).not.toMatch(/<input|<select|sk-ant-/);
  expect(render({...status,tolra_available:true,can_manage:false})).not.toContain("<button");
});
it("SQL preserves the original cap ledger, scopes by the caller and reserves atomically",()=>{
  const sql=readFileSync("supabase/proposals/n2_tolra_provided_ai.sql","utf8");
  expect(sql).toContain("v_org    UUID := public._ai_helper_caller(ARRAY['admin', 'office'])");
  expect(sql).toContain("u.organization_id = v_org AND u.month = v_month");
  expect(sql).toMatch(/u\.reserved_pence \+ u\.spent_pence \+ p_estimate_pence\s+<= v_cap/);
  expect(sql).toContain("WHERE r.id = p_request AND r.organization_id = p_org");
  expect(sql).toContain("r.status = 'reserved' AND r.key_source = 'tolra'");
  expect(sql).toContain("enabled BOOLEAN NOT NULL DEFAULT FALSE");
  expect(sql).toContain("monthly_cap_pence INTEGER NOT NULL DEFAULT 1000");
  expect(sql).toContain("REVOKE ALL ON public.ai_helper_tolra_control FROM PUBLIC, anon, authenticated");
});
