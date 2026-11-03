import { expect, test, type Page } from "@playwright/test";
import { adminClient, createSoloTenant, signedInClient, withDb } from "../../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { enrolTotp, totpCode } from "../../support/totp";
import { asSeparateDevice, signIn, world } from "../helpers";

test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);
test.describe.configure({mode:"serial"});
const KEY="sk-ant-SYNTHETIC-browser-provider-key-ZXY9";
const RFQ="Customer: Synthetic engineering\n- 5 x Bracket, Part: BR-100, Material: 6082-T6 aluminium, Finish: clear anodise, Due: 2026-12-04";
const resetControl=()=>withDb(db=>db.query("UPDATE public.ai_helper_tolra_control SET enabled=FALSE,api_key_enc=NULL,updated_by=NULL WHERE singleton"));
test.beforeEach(async()=>{await resetControl();});
test.afterEach(async()=>{await resetControl();});

async function ownerOnPlatform(page:Page) {
  const owner=await createSoloTenant(world().runId,"n2-owner");
  await withDb(db=>db.query("INSERT INTO security_audit.platform_admins(user_id,note) VALUES($1,'synthetic N2 browser owner')",[owner.admin.id]));
  const {secret}=await enrolTotp(await signedInClient(owner.admin));
  const used=totpCode(secret);
  await asSeparateDevice(page);await page.goto("/login");
  await page.getByLabel("Username or email").fill(owner.admin.email);
  await page.getByLabel("Password",{exact:true}).fill(owner.admin.password);
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.waitForURL(/\/mfa/);
  // A password-only owner is refused before we supply a fresh authenticator code.
  expect((await page.request.post("/api/platform/tolra-ai",{data:{enabled:true,key:KEY}})).status()).toBe(403);
  await expect.poll(()=>totpCode(secret),{timeout:35_000}).not.toBe(used);
  await page.getByLabel("6-digit code").fill(totpCode(secret));
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.waitForURL(/\/(platform|dashboard|select-role)/);await page.goto("/platform");
}

test("N2: Tolra mode starts hidden and an ordinary company admin cannot activate the global service",async({page})=>{
  const tenant=await createSoloTenant(world().runId,"n2-hidden");
  await signIn(page,tenant.admin);await page.goto("/admin/integrations");
  const response=await page.request.get("/api/ai-helper/status");expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({tolra_available:false,tolra_enabled:false});
  await expect(page.getByTestId("tolra-ai-card")).toHaveCount(0);
  expect((await page.request.post("/api/platform/tolra-ai",{data:{enabled:true,key:KEY}})).status()).toBe(403);
  expect((await page.request.post("/api/ai-helper/tolra-mode",{data:{enabled:true}})).status()).toBe(403);
});

test("N2: Rhys's guarded switch, secret input, company choice, separate usage and hard monthly cap",async({page,browser})=>{
  test.setTimeout(180_000);
  await ownerOnPlatform(page);
  const input=page.getByLabel("Tolra Anthropic key",{exact:true});
  await expect(input).toHaveValue("");await input.fill(KEY);
  const saving=page.waitForResponse(r=>r.url().endsWith("/api/platform/tolra-ai")&&r.request().method()==="POST");
  await page.getByRole("button",{name:"Switch on and save key",exact:true}).click();
  const response=await saving;expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({enabled:true,key_set:true});
  await expect(input).toHaveValue("");await page.reload();await expect(input).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(KEY);await expect(page.locator("body")).not.toContainText("ZXY9");
  const stored=await withDb(db=>db.query("SELECT api_key_enc FROM public.ai_helper_tolra_control WHERE singleton"));
  expect(stored.rows[0].api_key_enc).toMatch(/^v1\./);expect(stored.rows[0].api_key_enc).not.toContain(KEY);
  const a=await createSoloTenant(world().runId,"n2-company-a");
  const b=await createSoloTenant(world().runId,"n2-company-b");
  await page.context().clearCookies();await signIn(page,a.admin);await page.goto("/admin/integrations");
  const card=page.getByTestId("tolra-ai-card");await expect(card).toBeVisible();
  await expect(card.locator("input,select")).toHaveCount(0);
  await card.getByRole("button",{name:"Turn Tolra AI on",exact:true}).click();
  await expect(card.getByRole("button",{name:"Turn Tolra AI off",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.reload();await expect(card).toContainText("On for this company.");
  // This runs against the existing deterministic AI provider, never Anthropic.
  // A successful request must settle usage without creating/approving a quote.
  const suggestion=await page.request.post("/api/ai-helper/rfq",{data:{text:RFQ}});
  expect(suggestion.ok()).toBe(true);expect((await suggestion.json()).requestId).toBeTruthy();
  const used=await page.request.get("/api/ai-helper/status");expect(used.ok()).toBe(true);
  const usage=await used.json();expect(usage.month_spent_pence).toBeGreaterThan(0);expect(usage.month_reserved_pence).toBe(0);
  const quotes=await adminClient().from("quotes").select("id").eq("organization_id",a.id);
  expect(quotes.error).toBeNull();expect(quotes.data).toEqual([]);
  const context=await browser.newContext({baseURL:new URL(page.url()).origin});
  try {
    const other=await context.newPage();await signIn(other,b.admin);await other.goto("/admin/integrations");
    await expect(other.getByTestId("tolra-ai-card")).toContainText("Off for this company.");
    const status=await other.request.get("/api/ai-helper/status");expect(status.ok()).toBe(true);
    expect(await status.json()).toMatchObject({tolra_enabled:false,month_spent_pence:0,month_reserved_pence:0});
  } finally {await context.close();}
  // Fill only A's allowance on the disposable backend; B remains untouched.
  await withDb(db=>db.query("INSERT INTO public.ai_helper_usage(organization_id,month,spent_pence,reserved_pence) VALUES($1,date_trunc('month',now() AT TIME ZONE 'Europe/London')::date,1000,0) ON CONFLICT(organization_id,month) DO UPDATE SET spent_pence=1000,reserved_pence=0",[a.id]));
  const capped=await page.request.post("/api/ai-helper/rfq",{data:{text:RFQ}});
  expect(capped.status()).toBe(429);expect((await capped.json()).code).toBe("cap");
  const requests=await adminClient().from("ai_helper_requests").select("status,refusal,key_source").eq("organization_id",a.id).order("created_at",{ascending:true});
  expect(requests.error).toBeNull();expect(requests.data).toEqual([{status:"suggested",refusal:null,key_source:"tolra"},{status:"refused",refusal:"cap",key_source:"tolra"}]);
  await card.getByRole("button",{name:"Turn Tolra AI off",exact:true}).click();await expect(card).toContainText("Off for this company.");
  expect((await page.request.post("/api/ai-helper/rfq",{data:{text:RFQ}})).status()).toBe(404);
});

test("N2: office and viewer accounts cannot change mode or read the owner controls",async({page})=>{
  for(const role of ["office","viewer"] as const) {
    await page.context().clearCookies();await signIn(page,world().tenants.beta.users[role]);
    expect((await page.request.post("/api/ai-helper/tolra-mode",{data:{enabled:true}})).status()).toBe(403);
    expect((await page.request.get("/api/platform/tolra-ai")).status()).toBe(403);
  }
});
