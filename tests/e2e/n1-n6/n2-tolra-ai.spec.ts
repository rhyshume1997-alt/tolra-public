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
  // Shared (Tolra) mode is switched off (C4): the AI card no longer offers the Tolra choice at all.
  await expect(page.getByTestId("setup-card-ai").getByRole("radio",{name:/Tolra-provided AI/})).toHaveCount(0);
  expect((await page.request.post("/api/platform/tolra-ai",{data:{enabled:true,key:KEY}})).status()).toBe(403);
  expect((await page.request.post("/api/ai-helper/tolra-mode",{data:{enabled:true}})).status()).toBe(403);
});

test("N2: shared Tolra AI is switched off: owner can only store the key switched off, no company choice, no shared-key request",async({page})=>{
  test.setTimeout(180_000);
  await ownerOnPlatform(page);
  const input=page.getByLabel("Tolra Anthropic key",{exact:true});
  await expect(input).toHaveValue("");
  // The owner may store the key, but only switched off (the platform stays off, valid before and after the database refuses ON).
  const saved=await page.request.post("/api/platform/tolra-ai",{data:{enabled:false,key:KEY}});
  expect(saved.ok()).toBe(true);
  expect(await saved.json()).toEqual({enabled:false,key_set:true});
  await page.reload();await expect(input).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(KEY);await expect(page.locator("body")).not.toContainText("ZXY9");
  const stored=await withDb(db=>db.query("SELECT enabled,api_key_enc FROM public.ai_helper_tolra_control WHERE singleton"));
  expect(stored.rows[0].enabled).toBe(false);
  expect(stored.rows[0].api_key_enc).toMatch(/^v1\./);expect(stored.rows[0].api_key_enc).not.toContain(KEY);
  const a=await createSoloTenant(world().runId,"n2-company-a");
  await page.context().clearCookies();await signIn(page,a.admin);await page.goto("/admin/integrations");
  const card=page.getByTestId("setup-card-ai");await expect(card).toBeVisible();
  await expect(card.getByRole("radio",{name:/Tolra-provided AI/})).toHaveCount(0);
  expect((await page.request.post("/api/ai-helper/tolra-mode",{data:{enabled:true}})).status()).toBe(403);
  const status=await page.request.get("/api/ai-helper/status");expect(status.ok()).toBe(true);
  expect(await status.json()).toMatchObject({tolra_enabled:false,month_spent_pence:0,month_reserved_pence:0});
  // The company's AI stays off, nothing is reserved, and no suggestion or quote is created.
  expect((await page.request.post("/api/ai-helper/rfq",{data:{text:RFQ}})).status()).toBe(404);
  const requests=await adminClient().from("ai_helper_requests").select("status").eq("organization_id",a.id);
  expect(requests.error).toBeNull();expect(requests.data).toEqual([]);
  const quotes=await adminClient().from("quotes").select("id").eq("organization_id",a.id);
  expect(quotes.error).toBeNull();expect(quotes.data).toEqual([]);
});

test("N2: office and viewer accounts cannot change mode or read the owner controls",async({page})=>{
  for(const role of ["office","viewer"] as const) {
    await page.context().clearCookies();await signIn(page,world().tenants.beta.users[role]);
    expect((await page.request.post("/api/ai-helper/tolra-mode",{data:{enabled:true}})).status()).toBe(403);
    expect((await page.request.get("/api/platform/tolra-ai")).status()).toBe(403);
  }
});
