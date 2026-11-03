import { expect, test, type Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { adminClient, createSoloTenant, signedInClient, withDb } from "../../support/fixtures";
import { isolatedBackend } from "../../support/isolation";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { enrolTotp, totpCode } from "../../support/totp";
import { asSeparateDevice, signIn, world } from "../helpers";
test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);
async function ownerOnPlatform(page: Page, label: string) {
  const owner = await createSoloTenant(world().runId, label);
  await withDb(db => db.query("INSERT INTO security_audit.platform_admins(user_id,note) VALUES($1,'synthetic reviewer owner')", [owner.admin.id]));
  const { secret } = await enrolTotp(await signedInClient(owner.admin)); const used = totpCode(secret);
  await asSeparateDevice(page); await page.goto("/login");
  await page.getByLabel("Username or email").fill(owner.admin.email); await page.getByLabel("Password", { exact: true }).fill(owner.admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(/\/mfa/);
  await expect.poll(() => totpCode(secret), { timeout: 35_000 }).not.toBe(used);
  await page.getByLabel("6-digit code").fill(totpCode(secret)); await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/\/(platform|dashboard|select-role)/); await page.goto("/platform");
}
test("V-AI-CAPS: only the MFA platform owner changes company caps and A cannot change B's setting or allowance", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const a = await createSoloTenant(world().runId, "v-cap-a"); const b = await createSoloTenant(world().runId, "v-cap-b");
  await ownerOnPlatform(page, "v-cap-owner");
  const before = await page.request.get("/api/platform/tolra-ai/caps"); expect(before.status()).toBe(200);
  const prior = (await before.json()).companies as Array<{ organizationId: string; monthlyCapPence: number }>;
  await page.getByLabel(`Monthly AI limit for ${a.name} (pence)`, { exact: true }).fill("1500");
  await page.getByRole("button", { name: `Save limit for ${a.name}`, exact: true }).click();
  await expect(page.getByRole("status")).toContainText(`AI limit saved for ${a.name}`); await page.reload();
  await expect(page.getByLabel(`Monthly AI limit for ${a.name} (pence)`, { exact: true })).toHaveValue("1500");
  const changed = await page.request.get("/api/platform/tolra-ai/caps"); expect(changed.status()).toBe(200);
  const caps = (await changed.json()).companies as Array<{ organizationId: string; monthlyCapPence: number }>;
  expect(caps.find(row => row.organizationId === b.id)?.monthlyCapPence).toBe(prior.find(row => row.organizationId === b.id)?.monthlyCapPence);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const ordinary = await context.newPage(); await signIn(ordinary, a.admin);
    expect((await ordinary.request.post("/api/platform/tolra-ai/caps", { data: { organizationId: b.id, monthlyCapPence: 99999 } })).status()).toBe(403);
    expect((await ordinary.request.get("/api/platform/tolra-ai/caps")).status()).toBe(403);
    expect((await ordinary.request.post("/api/ai-helper/tolra-mode", { data: { enabled: true, organizationId: b.id } })).status()).toBe(400);
  } finally { await context.close(); }
  const after = await page.request.get("/api/platform/tolra-ai/caps"); expect(after.status()).toBe(200); expect((await after.json()).companies).toEqual(caps);
});
test("V-SETUP-SUPPORT: read-only and elevated support cannot read or edit saved setup progress", async ({ page }) => {
  test.setTimeout(120_000);
  const target = await createSoloTenant(world().runId, "v-support-target");
  expect((await adminClient().from("company_setup_progress").upsert({ organization_id: target.id, step: "company", completed: true })).error).toBeNull();
  await ownerOnPlatform(page, "v-support-owner");
  await page.getByRole("button", { name: `Enter ${target.name}`, exact: true }).click();
  await page.getByLabel("Reason", { exact: true }).fill("Reviewing fake setup only"); await page.getByRole("button", { name: "Enter company", exact: true }).click();
  await page.waitForURL(/\/dashboard/); await page.goto("/settings");
  const backend = isolatedBackend();
  const client = createServerClient(backend.apiUrl, backend.anonKey, { cookies: { getAll: async () => (await page.context().cookies()).map(({ name, value }) => ({ name, value })), setAll: () => undefined } });
  for (const elevated of [false, true]) {
    if (elevated) {
      await page.getByRole("button", { name: "Request write access", exact: true }).click();
      await page.getByLabel("Reason for write access").fill("Testing fake support boundary"); await page.getByRole("button", { name: /Switch on write access/ }).click();
      await expect(page.getByTestId("support-banner")).toContainText("write access until");
    }
    await expect(page.getByRole("region", { name: "Company setup", exact: true })).toHaveCount(0);
    const rows = await client.from("company_setup_progress").select("*").eq("organization_id", target.id); expect(rows.error).toBeNull(); expect(rows.data).toEqual([]);
    expect((await client.from("company_setup_progress").upsert({ organization_id: target.id, step: "company", completed: false })).error?.code).toBe("42501");
  }
  const kept = await adminClient().from("company_setup_progress").select("completed").eq("organization_id", target.id).eq("step", "company").single(); expect(kept.error).toBeNull(); expect(kept.data?.completed).toBe(true);
});
