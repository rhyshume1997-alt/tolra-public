/**
 * Acceptance for two accounting changes, in the browser (module 6, Integrations). Test-only: no app, lib or helper change.
 *
 * C1, confirm the Xero organisation before transfers go ON: the card names the connected organisation (xero-setup-card.tsx data-testid
 * "xero-tenant"); Turn on transfers opens a dialog naming it and Cancel sends nothing; the launch route refuses ON without the stored tenant
 * id (409 confirm_organisation, app/api/integrations/xero/launch/route.ts) and OFF is never blocked; a different organisation puts the
 * company back OFF (database trigger xero_connection_reset, release 149) and the dialog then names the new one; office and workshop
 * cannot see or use the switch (requireProfile(["admin"]) answers 403).
 * asserted. The accounting API still accepts those provider names (tests/e2e/reviewer/accounting.spec.ts uses it), so it is NOT asserted here.
 *
 * Nothing calls Xero. A connection is a service-role row (as xero-batch.spec.ts) with a made-up tenant id and no secret, plus the two account
 * mappings, so the company is connected and mapped. Three own companies: the admin in tests 2 and 3 enrols an authenticator (a later plain
 * sign-in would ask for the code), so they do not share a company with the others. Runs in CI only (needs the isolated Supabase backend).
 */
import { randomBytes } from "node:crypto";

import { type Page, expect, test } from "@playwright/test";

import { type SyntheticUser, adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, stepUpWithAuthenticator, world } from "./helpers";

test.describe.configure({ mode: "serial" });

type Company = { id: string; admin: SyntheticUser };
let plain: Company;
let confirmCo: Company;
let changeCo: Company;
let office: SyntheticUser;
let workshop: SyntheticUser;

const tag = () => world().runId.slice(0, 6);
const NAME_A = () => `Acme Xero Ltd ${tag()}`;
const NAME_B = () => `Other Xero Ltd ${tag()}`;
const LAUNCH = "/api/integrations/xero/launch";

/** Connected and mapped, with this made-up Xero organisation. Any earlier connection is deleted first (that puts the switch back OFF). */
async function seedConnected(org: string, tenantId: string, tenantName: string) {
  const db = adminClient();
  expect((await db.from("integration_connections").delete().eq("organization_id", org).eq("provider", "xero")).error).toBeNull();
  const inserted = await db.from("integration_connections").insert({ organization_id: org, provider: "xero", status: "connected", tenant_id: tenantId, tenant_name: tenantName, connected_at: new Date().toISOString() });
  expect(inserted.error).toBeNull();
}

async function addMember(org: string, label: string, role: "office" | "workshop"): Promise<SyntheticUser> {
  const db = adminClient();
  const email = `${role}.xconfirm.${label}.${world().runId}@example.test`;
  const password = `${randomBytes(12).toString("base64url")}aA1!`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${role} xconfirm` } });
  if (created.error || !created.data.user) throw new Error(`createUser ${email}: ${created.error?.message}`);
  const added = await db.rpc("add_member", { p_org: org, p_email: email, p_role: role });
  expect(added.error).toBeNull();
  return { id: created.data.user.id, email, password, role };
}

test.beforeAll(async () => {
  const w = world();
  const db = adminClient();
  const [a, b, c] = await Promise.all([createSoloTenant(w.runId, "xcfa"), createSoloTenant(w.runId, "xcfb"), createSoloTenant(w.runId, "xcfc")]);
  plain = { id: a.id, admin: a.admin };
  confirmCo = { id: b.id, admin: b.admin };
  changeCo = { id: c.id, admin: c.admin };
  for (const org of [a.id, b.id, c.id]) {
    const mapped = await db.from("integration_mappings").insert([
      { organization_id: org, provider: "xero", kind: "sales_account", tolra_key: "", external_code: "200", external_name: "Sales" },
      { organization_id: org, provider: "xero", kind: "credit_account", tolra_key: "", external_code: "200", external_name: "Sales" },
    ]);
    expect(mapped.error).toBeNull();
  }
  office = await addMember(a.id, "o", "office");
  workshop = await addMember(a.id, "w", "workshop");
});

const switchOf = (page: Page) => page.getByTestId("activation-xero").getByRole("switch", { name: "Turn on transfers" });
const stateOf = async (page: Page) => (await page.request.get(LAUNCH)).json() as Promise<{ enabled: boolean; organisation: { tenantId: string; name: string } | null }>;
const post = (page: Page, baseURL: string | undefined, data: Record<string, unknown>) => page.request.post(LAUNCH, { headers: { origin: baseURL! }, data });

test("connected and OFF: the card names the Xero organisation, Turn on transfers opens a dialog naming it, and Cancel leaves transfers OFF", async ({ page }) => {
  await seedConnected(plain.id, `e2e-xcf-a-${world().runId}`, NAME_A());
  await signIn(page, plain.admin);
  await page.goto("/admin/integrations");
  await expect(page.getByTestId("xero-tenant")).toContainText(NAME_A());
  await expect(switchOf(page)).toBeEnabled();
  await expect(switchOf(page)).toHaveAttribute("aria-checked", "false");

  await switchOf(page).click();
  const dialog = page.getByRole("dialog", { name: `Turn on transfers to Xero organisation ${NAME_A()}?` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Turn on transfers", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(switchOf(page)).toHaveAttribute("aria-checked", "false");
  expect((await stateOf(page)).enabled).toBe(false);
});

test("launch ON without confirmTenantId, or with another tenant id, is 409 confirm_organisation and transfers stay OFF; OFF is not blocked", async ({ page, baseURL }) => {
  const tenantId = `e2e-xcf-b-${world().runId}`;
  await seedConnected(confirmCo.id, tenantId, NAME_A());
  await stepUpWithAuthenticator(page, confirmCo.admin);

  const wrong = [{ enabled: true }, { enabled: true, confirmTenantId: `${tenantId}-other` }];
  for (const body of wrong) {
    const res = await post(page, baseURL, body);
    expect(res.status(), JSON.stringify(body)).toBe(409);
    expect((await res.json()).code).toBe("confirm_organisation");
    expect((await stateOf(page)).enabled).toBe(false);
  }
  // OFF is never blocked, with or without a tenant id.
  const off = await post(page, baseURL, { enabled: false });
  expect(off.status()).toBe(200);
  expect((await off.json()).enabled).toBe(false);
});

test("after the connection moves to a different organisation transfers are OFF and the dialog names the new organisation", async ({ page, baseURL }) => {
  const tenantA = `e2e-xcf-c-${world().runId}`;
  await seedConnected(changeCo.id, tenantA, NAME_A());
  await stepUpWithAuthenticator(page, changeCo.admin);

  // Turned ON for the organisation the admin confirmed.
  const on = await post(page, baseURL, { enabled: true, confirmTenantId: tenantA });
  expect(on.status()).toBe(200);
  expect((await stateOf(page)).enabled).toBe(true);

  // The connection now belongs to another Xero organisation (the same change the database test makes).
  const moved = await adminClient().from("integration_connections").update({ tenant_id: `${tenantA}-new`, tenant_name: NAME_B() }).eq("organization_id", changeCo.id).eq("provider", "xero");
  expect(moved.error).toBeNull();
  const after = await stateOf(page);
  expect(after.enabled).toBe(false);
  expect(after.organisation).toEqual({ tenantId: `${tenantA}-new`, name: NAME_B() });

  await page.goto("/admin/integrations");
  await expect(page.getByTestId("xero-tenant")).toContainText(NAME_B());
  await expect(switchOf(page)).toHaveAttribute("aria-checked", "false");
  await expect(switchOf(page)).toBeEnabled();
  await switchOf(page).click();
  const dialog = page.getByRole("dialog", { name: `Turn on transfers to Xero organisation ${NAME_B()}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await stateOf(page)).enabled).toBe(false);
});

test("office and workshop: no transfer switch on screen, and launch is refused with 403 (ON and OFF) while it stays OFF", async ({ page, browser, baseURL }) => {
  await seedConnected(plain.id, `e2e-xcf-a-${world().runId}`, NAME_A());
  const workshopPage = await browser.newPage();
  const adminPage = await browser.newPage();
  try {
    for (const [p, user] of [[page, office], [workshopPage, workshop]] as const) {
      await signIn(p, user);
      expect((await p.request.get(LAUNCH)).status(), `${user.role} GET`).toBe(403);
      expect((await post(p, baseURL, { enabled: true, confirmTenantId: `e2e-xcf-a-${world().runId}` })).status(), `${user.role} POST on`).toBe(403);
      expect((await post(p, baseURL, { enabled: false })).status(), `${user.role} POST off`).toBe(403);
      await p.goto("/admin/integrations");
      await expect(p).toHaveURL(/\/dashboard/);
      await expect(p.getByRole("switch", { name: "Turn on transfers" })).toHaveCount(0);
      await expect(p.getByTestId("setup-card-xero")).toHaveCount(0);
    }
    await signIn(adminPage, plain.admin);
    expect((await stateOf(adminPage)).enabled).toBe(false);
  } finally {
    await workshopPage.close();
    await adminPage.close();
  }
});

test("no Sage or QuickBooks is offered: not on the integrations page, the settings page or the sidebar, and no page route exists for them", async ({ page }) => {
  const offered = /\b(Sage|QuickBooks|Quick Books)\b/i;
  await signIn(page, plain.admin);

  await page.goto("/admin/integrations");
  await expect(page.getByTestId("setup-card-xero")).toBeVisible();
  await expect(page.getByRole("link", { name: "Integrations", exact: true }).first()).toBeAttached();
  await expect(page.locator("body")).not.toContainText(offered);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(offered);

  // The sidebar, whichever of the desktop rail or the drawer is in the DOM, lists neither.
  await expect(page.locator("nav").first()).not.toContainText(offered);
  await expect(page.getByRole("link", { name: offered })).toHaveCount(0);

  for (const route of ["/admin/integrations/sage", "/admin/integrations/quickbooks"]) {
    expect((await page.request.get(route)).status(), route).toBe(404);
  }
});
