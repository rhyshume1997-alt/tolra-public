import { NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only",()=>({}));
type Provider="sage"|"quickbooks";
type Row={organization_id:string;provider:Provider;tenant_id:string;tenant_name:string;status:string;refresh_token_enc:string;access_token_enc:string;access_expires_at:string;key_version:number};
const fixture=vi.hoisted(()=>({
  org:"00000000-0000-4000-8000-0000000000a1",user:"admin-a",
  connections:new Map<string,Row>(),pending:new Map<string,Record<string,unknown>>(),
  rpcs:[] as {name:string;args:Record<string,unknown>}[],
  tokens:{sage:{access:"synthetic-sage-access",refresh:"synthetic-sage-refresh"},quickbooks:{access:"synthetic-qbo-access",refresh:"synthetic-qbo-refresh"}},
  http:[] as {url:string;authorization:string|null;business:string|null}[],
}));
const tenant={sage:"sage-business-a",quickbooks:"1234567890"};
const invoiceIds={shared:"11111111-1111-4111-8111-111111111111",sage:"22222222-2222-4222-8222-222222222222",quickbooks:"33333333-3333-4333-8333-333333333333"};
const invoiceNumbers:Record<string,string>={[invoiceIds.shared]:"INV-SHARED",[invoiceIds.sage]:"SAGE-ONLY",[invoiceIds.quickbooks]:"QBO-ONLY"};
const key=(org:unknown,provider:unknown)=>`${org}/${provider}`;

async function rpc(name:string,args:Record<string,unknown>={}) {
  fixture.rpcs.push({name,args:structuredClone(args)});
  if(name==="accounting_cloud_connections_ready")return {data:true,error:null};
  if(name==="integration_oauth_start") {
    fixture.pending.set(key(fixture.org,args.p_provider),{...args,user:fixture.user});return {data:null,error:null};
  }
  expect(args.p_org).toBe(fixture.org);
  const id=key(args.p_org,args.p_provider);
  if(name==="integration_oauth_consume") {
    const pending=fixture.pending.get(id);
    expect(args.p_user).toBe(fixture.user);expect(pending?.p_state_hash).toBe(args.p_state_hash);
    expect(pending?.user).toBe(args.p_user);fixture.pending.delete(id);
    return {data:{verifier_enc:pending?.p_verifier_enc},error:null};
  }
  if(name==="integration_store_connection") {
    fixture.connections.set(id,{organization_id:String(args.p_org),provider:args.p_provider as Provider,tenant_id:String(args.p_tenant_id),tenant_name:String(args.p_tenant_name),status:"connected",refresh_token_enc:String(args.p_refresh_enc),access_token_enc:String(args.p_access_enc),access_expires_at:String(args.p_access_expires_at),key_version:Number(args.p_key_version)});
    return {data:null,error:null};
  }
  const row=fixture.connections.get(id);
  if(name==="integration_token_lease")return {data:row?structuredClone(row):null,error:null};
  if(name==="integration_token_release")return {data:null,error:null};
  if(name==="integration_token_store") {
    if(!row)throw new Error("No connection for refresh");
    Object.assign(row,{refresh_token_enc:args.p_refresh_enc,access_token_enc:args.p_access_enc,access_expires_at:args.p_access_expires_at,key_version:args.p_key_version});
    return {data:true,error:null};
  }
  throw new Error(`Unexpected RPC: ${name}`);
}
function from(table:string) {
  const filters:Record<string,unknown>={};
  const query={select:()=>query,eq:(field:string,value:unknown)=>{filters[field]=value;return query;},maybeSingle:async()=>{
    expect(filters.organization_id).toBe(fixture.org);
    if(table==="invoices")return {data:invoiceNumbers[String(filters.id)]?{invoice_ref:invoiceNumbers[String(filters.id)]}:null,error:null};
    if(table!=="integration_connections")throw new Error(`Unexpected table: ${table}`);
    expect(["sage","quickbooks"]).toContain(filters.provider);
    return {data:fixture.connections.get(key(filters.organization_id,filters.provider))??null,error:null};
  }};return query;
}
vi.mock("@/lib/server/auth",()=>({
  sameOrigin:()=>true,forbiddenOrigin:()=>NextResponse.json({}, {status:403}),
  isErrorResponse:(value:unknown)=>value instanceof NextResponse,
  jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),
  requireProfile:async(roles:string[])=>{
    expect(roles).toEqual(["admin"]);
    return {supabase:{rpc,from,auth:freshMfaAuth()},profile:{organization_id:fixture.org},user:{id:fixture.user},session:{support:false,read_only:false}};
  },
}));
vi.mock("@/lib/server/supabase-admin",()=>({createSupabaseAdminClient:()=>({rpc,from})}));

import { GET,POST } from "@/app/api/accounting/[provider]/[action]/route";
import { decryptSecret } from "@/lib/integrations/crypto";
import { freshMfaAuth } from "../support/fresh-mfa";

beforeEach(()=>{
  fixture.org="00000000-0000-4000-8000-0000000000a1";fixture.user="admin-a";
  fixture.connections.clear();fixture.pending.clear();fixture.rpcs=[];fixture.http=[];
  fixture.tokens={sage:{access:"synthetic-sage-access",refresh:"synthetic-sage-refresh"},quickbooks:{access:"synthetic-qbo-access",refresh:"synthetic-qbo-refresh"}};
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY",Buffer.alloc(32,31).toString("base64"));
  for(const [provider,prefix] of [["sage","SAGE"],["quickbooks","QUICKBOOKS"]]) {
    vi.stubEnv(`${prefix}_CLIENT_ID`,"synthetic-app-id");vi.stubEnv(`${prefix}_CLIENT_SECRET`,"synthetic-app-secret");
    vi.stubEnv(`${prefix}_REDIRECT_URI`,`https://tolra.example.test/api/accounting/${provider}/callback`);
  }
  vi.stubEnv("QUICKBOOKS_ENVIRONMENT","sandbox");
  vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));const headers=new Headers(init?.headers);
    fixture.http.push({url:url.toString(),authorization:headers.get("authorization"),business:headers.get("X-Business")});
    const provider:Provider=url.hostname.includes("sage")?"sage":"quickbooks";
    if(url.hostname==="oauth.accounting.sage.com"||url.hostname==="oauth.platform.intuit.com") {
      const body=new URLSearchParams(String(init?.body));
      if(body.get("grant_type")==="refresh_token") {
        expect(body.get("refresh_token")).toBe(fixture.tokens[provider].refresh);
        fixture.tokens[provider]={access:`synthetic-${provider}-access-rotated`,refresh:`synthetic-${provider}-refresh-rotated`};
      } else expect(body.get("code")).toBe(`synthetic-${provider}-code`);
      return Response.json({access_token:fixture.tokens[provider].access,refresh_token:fixture.tokens[provider].refresh,expires_in:3600});
    }
    expect(headers.get("authorization")).toBe(`Bearer ${fixture.tokens[provider].access}`);
    if(url.hostname==="api.accounting.sage.com") {
      if(url.pathname.endsWith("/businesses"))return Response.json({$items:[{id:tenant.sage,name:"Sage test business"}]});
      expect(url.pathname).toBe("/v3.1/sales_invoices");expect(headers.get("X-Business")).toBe(tenant.sage);
      return Response.json({$items:[{invoice_number:"INV-SHARED",total_amount:"120.50",outstanding_amount:"0.00",currency:{id:"GBP"}},{invoice_number:"SAGE-ONLY",total_amount:"12.00",outstanding_amount:"2.00",currency:{id:"GBP"}}]});
    }
    expect(url.hostname).toBe("sandbox-quickbooks.api.intuit.com");
    expect(url.pathname.startsWith(`/v3/company/${tenant.quickbooks}/`)).toBe(true);
    if(url.pathname.includes("/companyinfo/"))return Response.json({CompanyInfo:{CompanyName:"QBO test business"}});
    expect(url.pathname).toBe(`/v3/company/${tenant.quickbooks}/query`);
    return Response.json({QueryResponse:{Invoice:[{DocNumber:"INV-SHARED",TotalAmt:"987.65",Balance:"45.67",CurrencyRef:{value:"GBP"}},{DocNumber:"QBO-ONLY",TotalAmt:"88.00",Balance:"8.00",CurrencyRef:{value:"GBP"}}]}});
  }));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
const context=(provider:Provider,action:string)=>({params:Promise.resolve({provider,action})});
const post=(provider:Provider,action:string,body:unknown={})=>POST(new Request(`https://tolra.example.test/api/accounting/${provider}/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),context(provider,action));
async function connect(provider:Provider) {
  const start=await post(provider,"connect");expect(start.status).toBe(200);
  const authorization=new URL((await start.json()).url);
  const callback=new URL(`https://tolra.example.test/api/accounting/${provider}/callback`);
  callback.searchParams.set("state",authorization.searchParams.get("state")!);callback.searchParams.set("code",`synthetic-${provider}-code`);
  if(provider==="quickbooks")callback.searchParams.set("realmId",tenant.quickbooks);
  const finish=await GET(new Request(callback),context(provider,"callback"));
  expect(finish.status).toBe(303);expect(new URL(finish.headers.get("location")!).searchParams.get("result")).toBe("connected");
  return finish;
}
function assertEncrypted(provider:Provider) {
  const row=fixture.connections.get(key(fixture.org,provider))!;expect(row).toBeDefined();
  const ctx=(purpose:"access"|"refresh")=>({organizationId:fixture.org,provider,purpose});
  expect(row.access_token_enc).toMatch(/^v1\./);expect(row.refresh_token_enc).toMatch(/^v1\./);
  expect(decryptSecret(row.access_token_enc,ctx("access"))).toBe(fixture.tokens[provider].access);
  expect(decryptSecret(row.refresh_token_enc,ctx("refresh"))).toBe(fixture.tokens[provider].refresh);
  for(const tokens of Object.values(fixture.tokens))for(const token of Object.values(tokens)) {
    expect(JSON.stringify(row)).not.toContain(token);expect(JSON.stringify(fixture.rpcs)).not.toContain(token);
  }
  expect(row).not.toHaveProperty("access_token");expect(row).not.toHaveProperty("refresh_token");
  return row;
}

it.each(["sage","quickbooks"] as const)("%s connect/callback stores only encrypted access and refresh tokens through the real route",async provider=>{
  const logs=vi.spyOn(console,"error").mockImplementation(()=>{});
  const response=await connect(provider);const row=assertEncrypted(provider);
  expect(fixture.rpcs.filter(c=>c.name==="integration_store_connection")).toHaveLength(1);
  expect(row).toMatchObject({organization_id:fixture.org,provider,tenant_id:tenant[provider],status:"connected",key_version:1});
  const status=await GET(new Request(`https://tolra.example.test/api/accounting/${provider}/status`),context(provider,"status"));
  expect(status.status).toBe(200);
  const visible=JSON.stringify([await status.json(),response.headers.get("location"),logs.mock.calls]);
  for(const token of Object.values(fixture.tokens[provider]))expect(visible).not.toContain(token);
});

it("two connected providers keep tokens, invoices and results separate, including a one-provider refresh",async()=>{
  await connect("sage");await connect("quickbooks");
  const sage=assertEncrypted("sage"),qbo=assertEncrypted("quickbooks");
  expect(fixture.connections.size).toBe(2);expect(sage.access_token_enc).not.toBe(qbo.access_token_enc);
  for(const [row,other] of [[sage,"quickbooks"],[qbo,"sage"]] as const) {
    expect(()=>decryptSecret(row.access_token_enc,{organizationId:fixture.org,provider:other,purpose:"access"})).toThrow();
    expect(()=>decryptSecret(row.refresh_token_enc,{organizationId:fixture.org,provider:other,purpose:"refresh"})).toThrow();
  }
  const check=async(provider:Provider,invoiceId:string)=>{
    // Neither a body provider nor an arbitrary invoice number can override the
    // URL provider and the caller's real invoice reference.
    const response=await post(provider,"check",{invoiceId,provider:provider==="sage"?"quickbooks":"sage",invoiceNumber:"NOT-THE-INVOICE"});
    expect(response.status).toBe(200);return await response.json();
  };
  expect(await check("sage",invoiceIds.shared)).toMatchObject({reviewOnly:true,evidence:{invoiceNumber:"INV-SHARED",totalPence:12050,outstandingPence:0}});
  expect(await check("quickbooks",invoiceIds.shared)).toMatchObject({reviewOnly:true,evidence:{invoiceNumber:"INV-SHARED",totalPence:98765,outstandingPence:4567}});
  expect((await check("quickbooks",invoiceIds.sage)).evidence).toBeNull();
  expect((await check("sage",invoiceIds.quickbooks)).evidence).toBeNull();
  expect((await check("sage",invoiceIds.sage)).evidence).toMatchObject({invoiceNumber:"SAGE-ONLY",totalPence:1200,outstandingPence:200});
  expect((await check("quickbooks",invoiceIds.quickbooks)).evidence).toMatchObject({invoiceNumber:"QBO-ONLY",totalPence:8800,outstandingPence:800});

  const unchangedQbo=structuredClone(qbo);
  const originalSageAccess=sage.access_token_enc;
  sage.access_expires_at=new Date(Date.now()-300_000).toISOString();
  expect((await check("sage",invoiceIds.shared)).evidence).toMatchObject({totalPence:12050,outstandingPence:0});
  assertEncrypted("sage");expect(sage.access_token_enc).not.toBe(unchangedQbo.access_token_enc);
  expect(sage.access_token_enc).not.toBe(originalSageAccess);
  expect(fixture.connections.get(key(fixture.org,"quickbooks"))).toEqual(unchangedQbo);
  expect((await check("quickbooks",invoiceIds.shared)).evidence).toMatchObject({totalPence:98765,outstandingPence:4567});
  expect(fixture.rpcs.filter(c=>c.name==="integration_token_store").map(c=>c.args.p_provider)).toEqual(["sage"]);
  expect(fixture.http.some(c=>c.url.includes("sales_invoices")&&c.business===tenant.sage&&c.authorization===`Bearer ${fixture.tokens.sage.access}`)).toBe(true);
  expect(fixture.http.some(c=>c.url.includes(`/company/${tenant.quickbooks}/query`)&&c.authorization===`Bearer ${fixture.tokens.quickbooks.access}`)).toBe(true);
});


it("Company B cannot read Company A's connected provider, tenant or balance even when A's IDs are supplied", async () => {
  await connect("sage"); await connect("quickbooks");
  const companyA = fixture.org;
  const stored = structuredClone([...fixture.connections.entries()]);
  const requestsBefore = fixture.http.length;
  fixture.org = "00000000-0000-4000-8000-0000000000b2"; fixture.user = "admin-b";
  for (const provider of ["sage", "quickbooks"] as const) {
    const url = new URL(`https://tolra.example.test/api/accounting/${provider}/status`);
    url.searchParams.set("organizationId", companyA); url.searchParams.set("tenantId", tenant[provider]);
    const response = await GET(new Request(url), context(provider, "status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, status: "not_connected", tenantName: null });
    const check = await post(provider, "check", { invoiceId: invoiceIds.shared, organizationId: companyA, tenantId: tenant[provider] });
    expect(check.status).toBe(502);
    expect(await check.json()).toEqual({ error: "Could not complete the accounting check. Reconnect or try again." });
  }
  expect(fixture.http).toHaveLength(requestsBefore);
  expect([...fixture.connections.entries()]).toEqual(stored);
  expect(fixture.rpcs.filter(call => call.name === "integration_token_lease" && call.args.p_org === fixture.org)).toEqual([]);
});
