import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const ledger = vi.hoisted(() => ({ rpcs: [] as { name: string; args: Record<string, unknown> }[], reads: [] as string[], cap: false, settleThrows: false }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({
  from: () => {
    let org = "";
    const q = { select: () => q, eq: (_c: string, v: string) => { org = v; return q; }, maybeSingle: async () => {
      ledger.reads.push(org);
      return { data: { api_key_enc: encryptSecret("sk-ant-synthetic-never-live", { organizationId: org, provider: "anthropic", purpose: "api_key" }) }, error: null };
    } }; return q;
  },
  rpc: async (name: string, args: Record<string, unknown>) => { ledger.rpcs.push({ name, args }); if (ledger.settleThrows) throw Error("synthetic private provider data"); return { error: null }; },
}) }));

import { anthropicProvider } from "@/lib/ai-helper/anthropic";
import { AI_HELPER_MODELS, AI_REQUEST_TIMEOUT_MS, actualPence } from "@/lib/ai-helper/limits";
import { AiProviderError, type AiHelperProvider } from "@/lib/ai-helper/provider";
import { RFQ_OUTPUT_SCHEMA, RFQ_SYSTEM_PROMPT, sanitizeRfqAnswer } from "@/lib/ai-helper/rfq";
import { ROUNDUP_OUTPUT_SCHEMA, ROUNDUP_SYSTEM_PROMPT, checkedSummary } from "@/lib/ai-helper/roundup";
import { ASSISTANT_OUTPUT_SCHEMA, ASSISTANT_SYSTEM_PROMPT, assistantContext, checkedAnswer } from "@/lib/ai-helper/assistant";
import { aiHelperProvider, runAiHelper } from "@/lib/ai-helper/server";
import { encryptSecret } from "@/lib/integrations/crypto";

const org = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000002";
const session = { rpc: async (name: string, args: Record<string, unknown>) => {
  ledger.rpcs.push({ name, args }); return { data: { ok: !ledger.cap, reason: ledger.cap ? "cap" : undefined, request_id: requestId }, error: null };
} };
const usage = { input_tokens: 250, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const reply = (json: unknown, over: Record<string, unknown> = {}) => ({ id: "msg_synthetic", type: "message", role: "assistant", model: AI_HELPER_MODELS.rfq,
  content: [{ type: "text", text: JSON.stringify(json), citations: null }], stop_reason: "end_turn", stop_sequence: null, usage, ...over });
const answer = { customer: "Synthetic Works", suspicious_text: false, lines: [{ description: "Bracket", part_number: "BR-1", material: "6082", finish: null, quantity: 5, due_date: null, unclear: ["finish"], similar_quote_ref: null }] };
const provider = (response: unknown) => anthropicProvider((() => ({ messages: { create: async () => response } })) as never);
const base = { supabase: session as never, organizationId: org, feature: "rfq" as const, system: RFQ_SYSTEM_PROMPT,
  data: JSON.stringify({ rfq_email: "5 synthetic brackets", past_quote_lines: [] }), schema: RFQ_OUTPUT_SCHEMA,
  validate: (raw: unknown) => { const value = sanitizeRfqAnswer(raw, { knownRefs: new Set(), inputSuspicious: false, maxLines: 20 }); return { value, store: { kind: "rfq", ...value } }; } };
const settle = () => ledger.rpcs.find(r => r.name === "ai_helper_settle")!.args;
const estimate = () => ledger.rpcs[0].args.p_estimate_pence;

beforeEach(() => { ledger.rpcs=[]; ledger.reads=[]; ledger.cap=false; ledger.settleThrows=false;
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("real SDK adapter -> existing helper validation -> existing request/cost ledger (no network)", () => {
  it("records a realistic structured RFQ and token/cost usage, scoped to this company, without business writes", async () => {
    const result = await runAiHelper({ ...base, provider: provider(reply(answer)) });
    expect(result).toMatchObject({ kind: "ok", requestId, value: { customer: "Synthetic Works" } });
    expect(ledger.reads).toEqual([org]);
    expect(ledger.rpcs.map(r => r.name)).toEqual(["ai_helper_reserve", "ai_helper_settle"]);
    expect(settle()).toMatchObject({ p_request: requestId, p_status: "suggested", p_cost_pence: actualPence(AI_HELPER_MODELS.rfq,{inputTokens:250,outputTokens:80}),
      p_output: { kind: "rfq", usage: { inputTokens: 250, outputTokens: 80 } } });
    expect(JSON.stringify(result)).not.toContain("sk-ant");
  });

  it("roundup and assistant use the same SDK/helper/settlement path, suggestions only", async () => {
    const facts = { period: "daily" as const, today: "2026-11-05", sections: [{title:"Late jobs",count:2,failed:false,items:[],href:"/jobs"}] };
    expect(await runAiHelper({ ...base, feature: "roundup", system: ROUNDUP_SYSTEM_PROMPT, schema: ROUNDUP_OUTPUT_SCHEMA,
      provider: provider(reply({summary:"2 jobs need checking."},{model:AI_HELPER_MODELS.roundup})),
      validate: raw => {const summary=checkedSummary(raw,facts);return {value:summary,store:{kind:"roundup",summary}};} })).toMatchObject({kind:"ok",value:"2 jobs need checking."});
    const ctx=assistantContext("jobs",[{id:"j1",organization_id:org,job_no:"J-1",stage:"waiting"}],org,"2026-11-05");
    const result=await runAiHelper({...base,feature:"assistant",system:ASSISTANT_SYSTEM_PROMPT,schema:ASSISTANT_OUTPUT_SCHEMA,
      provider:provider(reply({answer:"J-1 is waiting.",refs:["J-1"],draft:null,review:[]},{model:AI_HELPER_MODELS.assistant})),
      validate:raw=>{const checked=checkedAnswer(raw,ctx);return {value:checked.shown,store:checked.stored};}});
    expect(result).toMatchObject({kind:"ok"});
    expect(ledger.rpcs.map(r=>r.name)).toEqual(["ai_helper_reserve","ai_helper_settle","ai_helper_reserve_assistant","ai_helper_settle"]);
  });

  it("cap refusal prevents key access and the SDK call", async () => {
    ledger.cap=true; const complete=vi.fn();
    expect(await runAiHelper({...base,provider:{id:"mock",complete}})).toMatchObject({kind:"cap"});
    expect(complete).not.toHaveBeenCalled();expect(ledger.reads).toEqual([]);expect(ledger.rpcs).toHaveLength(1);
  });

  it.each([undefined, {}, {input_tokens:-1,output_tokens:0}, {input_tokens:NaN,output_tokens:10}, {input_tokens:1,output_tokens:Infinity}, {input_tokens:1.5,output_tokens:10}])("missing/malformed billed usage settles the full reservation (%j)",async bad=>{
    expect(await runAiHelper({...base,provider:provider(reply(answer,{usage:bad}))})).toMatchObject({kind:"failed"});
    expect(settle()).toMatchObject({p_status:"failed",p_output:null,p_cost_pence:estimate()});
  });

  it.each(["refusal","max_tokens"])("provider %s keeps billed usage and returns no suggestion",async reason=>{
    expect(await runAiHelper({...base,provider:provider(reply(answer,{stop_reason:reason}))})).toMatchObject({kind:"failed"});
    expect(settle()).toMatchObject({p_status:"failed",p_output:null,p_cost_pence:actualPence(AI_HELPER_MODELS.rfq,{inputTokens:250,outputTokens:80})});
  });

  it("malformed JSON/structure is rejected; provider text never reaches user or ledger",async()=>{
    for(const response of [reply(null,{content:[{type:"text",text:"private bad answer"}]}),reply({wrong:"shape"})]){
      ledger.rpcs=[]; expect(await runAiHelper({...base,provider:provider(response)})).toMatchObject({kind:"failed",failure:"invalid"});
      expect(settle().p_output).toBeNull();expect(JSON.stringify(settle())).not.toContain("private bad answer");
    }
  });

  it("an adapter exceeding its token budget or answering with a different model cannot undercharge",async()=>{
    for(const response of [reply(answer,{usage:{input_tokens:1,output_tokens:8001}}),reply(answer,{model:"another-model"})]){
      ledger.rpcs=[]; expect(await runAiHelper({...base,provider:provider(response)})).toMatchObject({kind:"failed",failure:"invalid"});
      expect(settle().p_cost_pence).toBe(estimate());
    }
  });

  it("times out even a stuck adapter, charges the held reservation once, and never retries",async()=>{
    vi.useFakeTimers();const complete=vi.fn(()=>new Promise<never>(()=>{}));
    const pending=runAiHelper({...base,provider:{id:"mock",complete}});
    await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS+1);
    expect(await pending).toMatchObject({kind:"failed",failure:"unavailable"});
    expect(complete).toHaveBeenCalledTimes(1);expect(settle().p_cost_pence).toBe(estimate());
  });

  it("a certain pre-work rejection refunds zero, an uncertain error with broken usage holds full cost",async()=>{
    for(const [error,certain] of [[new AiProviderError("unavailable",undefined,"auth",true),true],[new AiProviderError("invalid",{inputTokens:NaN,outputTokens:0}),false]] as const){
      ledger.rpcs=[];const p:AiHelperProvider={id:"mock",complete:async()=>{throw error;}};
      expect(await runAiHelper({...base,provider:p})).toMatchObject({kind:"failed"});
      expect(settle().p_cost_pence).toBe(certain?0:estimate());
    }
  });

  it("settlement transport failure hides an unaudited answer and leaves the reservation held",async()=>{
    ledger.settleThrows=true;expect(await runAiHelper({...base,provider:provider(reply(answer))})).toEqual({kind:"unavailable"});
  });

  it("unknown provider and deployed mock configuration fail closed",()=>{
    expect(aiHelperProvider({AI_HELPER_PROVIDER:"unknown"})).toBeNull();
    expect(aiHelperProvider({AI_HELPER_PROVIDER:"mock",VERCEL_ENV:"production"})).toBeNull();
  });
});
