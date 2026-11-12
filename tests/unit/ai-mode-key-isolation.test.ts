import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { pinClock, unpinClock } from "../support/fixed-price-clock";

vi.mock("server-only", () => ({}));
beforeAll(pinClock);
afterAll(unpinClock);
const db = vi.hoisted(() => ({
  org: "00000000-0000-4000-8000-0000000000a1", tolra: false, enabled: true,
  ownCipher: "", tolraCipher: "", requests: 0,
  reservations: new Map<string, string>(), keyReads: [] as string[],
}));
function status() { return { roundup_enabled: db.enabled, rfq_enabled: db.enabled, tolra_enabled: db.tolra, key_set: true }; }
const rpc = async (name: string, args: Record<string, unknown>) => {
  if (name === "ai_helper_set_tolra_mode") { db.tolra = args.p_enabled === true; db.enabled = db.tolra; return {data:null,error:null}; }
  if (name === "ai_helper_save_settings") { db.enabled = args.p_rfq === true; return {data:status(),error:null}; }
  if (name === "ai_helper_reserve") {
    if (!db.enabled) return {data:null,error:{hint:"ai_helper_off"}};
    const id = `request-${++db.requests}`;
    const source = db.tolra ? "tolra" : "own";
    db.reservations.set(id, source);
    return {data:{ok:true,request_id:id,key_source:source},error:null};
  }
  if (name === "ai_helper_tolra_key") {
    db.keyReads.push("tolra");
    return {data:args.p_org === db.org && db.reservations.get(String(args.p_request)) === "tolra" ? db.tolraCipher : null,error:null};
  }
  if (name === "ai_helper_settle") return {data:null,error:null};
  throw new Error(`Unexpected RPC: ${name}`);
};
function from(table: string) {
  const filters: Record<string, unknown> = {};
  const query = {
    select: () => query,
    eq: (name:string,value:unknown) => { filters[name] = value; return query; },
    maybeSingle: async () => {
      if (filters.organization_id !== db.org) throw new Error("Unscoped company read");
      if (table === "ai_helper_settings") return {data:{finance_check_enabled:false},error:null};
      if (table !== "ai_helper_secrets") throw new Error(`Unexpected table: ${table}`);
      db.keyReads.push("own");return {data:{api_key_enc:db.ownCipher},error:null};
    },
  };
  return query;
}
vi.mock("@/lib/server/supabase-admin", () => ({createSupabaseAdminClient:()=>({rpc,from})}));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin:()=>true, forbiddenOrigin:()=>NextResponse.json({}, {status:403}),
  isErrorResponse:(value:unknown)=>value instanceof NextResponse,
  jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),
  readJson:async(request:Request)=>({ok:true,data:await request.json()}),
  requireProfile:async()=>({supabase:{rpc,from},profile:{organization_id:db.org},session:{support:false}}),
}));

import { POST as setMode } from "@/app/api/ai-helper/tolra-mode/route";
import { POST as saveOwnSettings } from "@/app/api/ai-helper/settings/route";
import { runAiHelper } from "@/lib/ai-helper/server";
import { TOLRA_AI_KEY_CONTEXT } from "@/lib/ai-helper/tolra-key-context";
import type { AiCompletionRequest } from "@/lib/ai-helper/provider";
import { encryptSecret } from "@/lib/integrations/crypto";

afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
it("uses only the selected account with both keys configured, never leaks keys or falls back to the other account while switching",async()=>{
  vi.stubEnv("AI_HELPER_ENABLED","true");vi.stubEnv("AI_ASSISTANT_ENABLED","false");
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY",Buffer.alloc(32,23).toString("base64"));
  const logs=vi.spyOn(console,"error").mockImplementation(()=>{});
  const OWN="sk-ant-SYNTHETIC-own-account-private-key";
  const TOLRA="sk-ant-SYNTHETIC-Tolra-account-private-key";
  const ownCipher=encryptSecret(OWN,{organizationId:db.org,provider:"anthropic",purpose:"api_key"});
  const tolraCipher=encryptSecret(TOLRA,TOLRA_AI_KEY_CONTEXT);
  Object.assign(db,{tolra:false,enabled:true,ownCipher,tolraCipher,requests:0,keyReads:[]});db.reservations.clear();
  const usedKeys:string[]=[];
  const provider={id:"mock" as const,complete:vi.fn(async(request:AiCompletionRequest)=>{
    usedKeys.push(request.apiKey);return {json:{text:"A suggestion"},model:request.model,usage:{inputTokens:10,outputTokens:5}};
  })};
  const outputs:unknown[]=[];
  const run=async()=>{
    const result=await runAiHelper({supabase:{rpc} as unknown as SupabaseClient,organizationId:db.org,feature:"rfq",system:"Suggest only",data:"Synthetic input",schema:{type:"object"},validate:json=>({value:json,store:{kind:"rfq"}}),provider});
    outputs.push(result);return result;
  };
  const post=(body:unknown)=>new Request("http://localhost/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const toggle=async(enabled:boolean)=>{
    const response=await setMode(post({enabled}));expect(response.status).toBe(200);outputs.push(await response.json());
  };
  const ownOn=async()=>{
    const response=await saveOwnSettings(post({roundupEnabled:true,rfqEnabled:true,monthlyCapPence:500}));
    expect(response.status).toBe(200);outputs.push(await response.json());
  };
  expect(await run()).toMatchObject({kind:"ok"});
  await toggle(true);expect(await run()).toMatchObject({kind:"ok"});
  await toggle(false);expect(await run()).toEqual({kind:"off"});
  expect(usedKeys).toEqual([OWN,TOLRA]); // off must not silently start using the own key
  await ownOn();expect(await run()).toMatchObject({kind:"ok"});
  expect(usedKeys).toEqual([OWN,TOLRA,OWN]);
  expect([db.ownCipher,db.tolraCipher]).toEqual([ownCipher,tolraCipher]);

  // Even a usable alternative key is forbidden when the selected slot cannot
  // decrypt: no cross-account ciphertext substitution or key cache fallback.
  await toggle(true);db.tolraCipher=ownCipher;
  expect(await run()).toMatchObject({kind:"failed",detail:"tolra_key"});
  db.tolraCipher=tolraCipher;await toggle(false);await ownOn();db.ownCipher=tolraCipher;
  expect(await run()).toMatchObject({kind:"failed",detail:"key"});
  expect(provider.complete).toHaveBeenCalledTimes(3);
  expect(db.keyReads).toEqual(["own","tolra","own","tolra","own"]);
  for(const secret of [OWN,TOLRA,ownCipher,tolraCipher]) {
    expect(JSON.stringify(outputs)).not.toContain(secret);expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
  }
});
