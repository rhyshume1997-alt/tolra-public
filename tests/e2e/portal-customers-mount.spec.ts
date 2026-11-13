/**
 * BOUNDARY (module 5): isolated synthetic customers and staff sessions -> the existing Portal card mount.
 * Uses real staff routes and Release 153/154 functions. No provider or database mocks, no activation.
 * Preserve customer editing and navigation; contact operations remain owned by module 10.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let customerA = "";
let customerB = "";
let contactA = "";
let contactB = "";
let nameA = "";
let nameB = "";

async function openCustomer(page: Page) {
  await page.goto("/customers");
  await page.getByRole("row").filter({ hasText: nameA }).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Edit customer", exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  await verifyBackendIdentity();
  const tag = randomUUID().slice(0, 8);
  nameA = `Portal mount A ${tag}`;
  nameB = `Portal mount B ${tag}`;
  contactA = `Contact A ${tag}`;
  contactB = `Contact B ${tag}`;
  const db = adminClient();
  for (const [tenant, name] of [[w.tenants.alpha, nameA], [w.tenants.beta, nameB]] as const) {
    const result = await db.from("customers").insert({ organization_id: tenant.id, name }).select("id").single();
    expect(result.error).toBeNull();
    if (name === nameA) customerA = result.data!.id;
    else customerB = result.data!.id;
  }
  // Private portal tables are seeded through the isolation-checked direct DB connection, never API grants.
  await withDb(async (db) => {
    for (const [tenant, customerId, displayName] of [[w.tenants.alpha, customerA, contactA], [w.tenants.beta, customerB, contactB]] as const) {
      await db.query("insert into public.customer_portal_contacts (organization_id, customer_id, email, display_name, permissions, invited_by, invite_reason) values ($1,$2,$3,$4,ARRAY['quotes'],$5,'synthetic mount acceptance')", [tenant.id, customerId, `mount-${randomUUID()}@example.test`, displayName, tenant.users.admin.id]);
    }
  });
});

test("admin sees only the selected saved customer's contacts; customer editing still saves", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  const request = page.waitForResponse((r) => r.url().includes(`/api/portal/staff/contacts?customer=${customerA}`));
  await openCustomer(page);
  expect((await request).status()).toBe(200);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("li").filter({ hasText: contactA })).toBeVisible();
  await expect(dialog.locator("li").filter({ hasText: contactB })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add contact", exact: true })).toBeVisible();
  await dialog.locator('input[name="contact_name"]').fill("Updated synthetic contact");
  await dialog.getByRole("button", { name: "Save Customer", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openCustomer(page);
  await expect(page.getByRole("dialog").locator('input[name="contact_name"]')).toHaveValue("Updated synthetic contact");
  await expect(page.getByRole("cell", { name: nameB, exact: true })).toHaveCount(0);
  const foreign = await page.request.get(`/api/portal/staff/contacts?customer=${customerB}`);
  expect(foreign.status()).toBe(404);
  expect(await foreign.text()).not.toContain(contactB);
});

test("office retains customer editing without mounting or fetching admin Portal controls", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/portal/staff/")) requests.push(r.url()); });
  await signIn(page, w.tenants.alpha.users.office);
  await openCustomer(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save Customer", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add contact", exact: true })).toHaveCount(0);
  await expect(dialog.locator("li").filter({ hasText: contactA })).toHaveCount(0);
  expect(requests).toEqual([]);
  const refused = await page.request.get(`/api/portal/staff/contacts?customer=${customerA}`);
  expect(refused.status()).toBe(403);
});

test("new unsaved customer has no Portal mount or contact fetch", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/portal/staff/")) requests.push(r.url()); });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/customers");
  await page.getByRole("button", { name: "New customer", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Add customer", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Add contact", exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("mount leaves the company Portal OFF and the real invite function refuses", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await openCustomer(page);
  const status = await page.request.get("/api/portal/staff/status");
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ enabled: false });
  await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      const claims = { sub: w.tenants.alpha.users.admin.id, role: "authenticated", aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] };
      await db.query("select set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify(claims), claims.sub]);
      await expect(db.query("select public.portal_contact_invite($1,$2,'Synthetic invite',ARRAY['quotes'],'synthetic refusal proof')", [customerA, `off-${randomUUID()}@example.test`])).rejects.toMatchObject({ hint: "portal_off" });
    } finally { await db.query("rollback"); }
  });
  expect(await (await page.request.get("/api/portal/staff/status")).json()).toMatchObject({ enabled: false });
});
