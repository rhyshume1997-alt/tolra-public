/**
 * Two-level access in the browser (migration 036): a one-company person goes straight in, a two-company person chooses (and the
 * picker shows only their own companies, never a third party's name), and the platform owner enters a company with a reason, is
 * refused a write until write access is switched on, then exits. The world is read inside the tests, never at import.
 */
import { expect, test, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { enrolTotp, totpCode } from "../support/totp";
import { asSeparateDevice, signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

type Person = { id: string; email: string; password: string };
let john: Person;
let owner: Person;
let thirdParty: { id: string; name: string };
let ownerSecret: string; // the platform owner's authenticator app: they always need the second step

async function makePerson(label: string): Promise<Person> {
  const email = `${label}.${world().runId}@example.test`;
  const password = generatePassword(14);
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${label} Person` } });
  if (error || !data.user) throw new Error(error?.message);
  return { id: data.user.id, email, password };
}

/** Signs in through the real form and returns wherever the app sends the person first. */
async function signInAnywhere(page: Page, person: Person) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(select-role|dashboard|choose-company|platform|mfa)/, { timeout: 45_000 });
}

/** The second step for the platform owner: the code from their authenticator app. */
async function passSecondStep(page: Page) {
  await expect(page).toHaveURL(/\/mfa/);
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(totpCode(ownerSecret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/(platform|dashboard)/, { timeout: 30_000 });
}

test.beforeAll(async () => {
  const w = world();
  const admin = adminClient();
  john = await makePerson("john");
  owner = await makePerson("owner");
  const thirdAdmin = await makePerson("marpet-admin");
  const name = `Marpet Test ${w.runId}`;
  const created = await admin.rpc("create_organization", { p_name: name, p_slug: `${SYNTHETIC_SLUG_PREFIX}${w.runId}-marpet`, p_admin_email: thirdAdmin.email, p_company_profile: { documentName: name, addressLines: ["1 Test Road"], vatRegistered: false } });
  if (created.error || typeof created.data !== "string") throw new Error(created.error?.message);
  thirdParty = { id: created.data, name };
  for (const tenant of ["alpha", "beta"] as const) {
    expect((await admin.rpc("add_member", { p_org: w.tenants[tenant].id, p_email: john.email, p_role: "office" })).data).toBe("member");
    expect((await admin.from("customers").insert({ organization_id: w.tenants[tenant].id, name: `${tenant} only customer ${w.runId}` })).error).toBeNull();
  }
  expect((await admin.rpc("add_member", { p_org: w.tenants.alpha.id, p_email: owner.email, p_role: "viewer" })).data).toBe("member");
  // The owner is on the platform list because the database owner put them there (the SQL editor).
  ownerSecret = (await enrolTotp(await signedInClient(owner))).secret;
  await withDb((db) => db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner')", [owner.id]));
});

test("a person with one company goes straight in, with no picker", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.office);
  await expect(page).toHaveURL(/\/dashboard/);
});

test("a person with two companies sees a picker of only their own, and the data follows the choice", async ({ page }) => {
  const w = world();
  await signInAnywhere(page, john);
  await expect(page).toHaveURL(/\/choose-company/);
  const list = page.getByTestId("company-list");
  await expect(list.getByText(w.tenants.alpha.name)).toBeVisible();
  await expect(list.getByText(w.tenants.beta.name)).toBeVisible();
  // Nobody else's company is named anywhere on the page.
  await expect(page.locator("body")).not.toContainText("Marpet");
  await expect(page.locator("body")).not.toContainText(thirdParty.name);
  // Business pages are not reachable without choosing.
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/choose-company/);

  await page.getByRole("button", { name: `Open ${w.tenants.alpha.name}` }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  await page.goto("/customers");
  await expect(page.getByRole("cell", { name: `alpha only customer ${w.runId}` })).toBeVisible();
  await expect(page.getByRole("cell", { name: `beta only customer ${w.runId}` })).toHaveCount(0);

  // Switching from the menu changes the data.
  await page.getByLabel("Switch organisation").first().selectOption({ label: w.tenants.beta.name });
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  await page.goto("/customers");
  await expect(page.getByRole("cell", { name: `beta only customer ${w.runId}` })).toBeVisible();
  await expect(page.getByRole("cell", { name: `alpha only customer ${w.runId}` })).toHaveCount(0);
});

test("The platform owner enters a company with a reason, is refused a write, switches write access on, writes, and exits", async ({ page }) => {
  const w = world();
  await signInAnywhere(page, owner);
  // Password alone is not enough for the platform owner: nothing opens until the code is entered.
  await page.goto("/platform");
  await expect(page).toHaveURL(/\/mfa/);
  await passSecondStep(page);
  await expect(page).toHaveURL(/\/platform/);
  const list = page.getByTestId("platform-list");
  for (const name of [w.tenants.alpha.name, w.tenants.beta.name, thirdParty.name]) await expect(list.getByText(name)).toBeVisible();
  // Business pages are blocked until a company is entered.
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/platform/);

  await page.getByRole("button", { name: `Enter ${thirdParty.name}` }).click();
  const enter = page.getByRole("button", { name: "Enter company" });
  await expect(enter).toBeDisabled(); // no reason yet
  await page.getByLabel("Reason", { exact: true }).fill("Helping with a year-end question");
  await enter.click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

  const banner = page.getByTestId("support-banner");
  await expect(banner).toContainText(new RegExp(`Support access to ${thirdParty.name}, read-only, expires \\d\\d:\\d\\d`));

  const customer = `Support customer ${w.runId}`;
  await page.goto("/customers");
  await page.getByRole("button", { name: "New customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Add customer" });
  await dialog.getByRole("textbox", { name: "Customer name" }).fill(customer);
  await dialog.getByRole("button", { name: "Save Customer" }).click();
  await expect(page.getByText(/read-only/i).first()).toBeVisible();
  const refused = await adminClient().from("customers").select("id").eq("organization_id", thirdParty.id).eq("name", customer);
  expect(refused.data).toEqual([]);

  // Write access is a separate, logged step.
  await page.reload();
  await page.getByRole("button", { name: "Request write access" }).click();
  await page.getByLabel("Reason for write access").fill("Adding the customer they asked for");
  await page.getByRole("button", { name: /Switch on write access/ }).click();
  await expect(page.getByTestId("support-banner")).toContainText(/write access until \d\d:\d\d/, { timeout: 30_000 });
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByRole("dialog", { name: "Add customer" }).getByRole("textbox", { name: "Customer name" }).fill(customer);
  await page.getByRole("dialog", { name: "Add customer" }).getByRole("button", { name: "Save Customer" }).click();
  await expect(page.getByRole("cell", { name: customer })).toBeVisible();

  const log = await withDb((db) => db.query("select via, reason, write_access from security_audit.org_entry_log where user_id = $1 and organization_id = $2 order by at", [owner.id, thirdParty.id]));
  expect(log.rows).toEqual([
    { via: "platform_support", reason: "Helping with a year-end question", write_access: false },
    { via: "platform_elevate", reason: "Adding the customer they asked for", write_access: true },
  ]);

  await page.getByRole("button", { name: "Exit company" }).click();
  await page.waitForURL(/\/platform/, { timeout: 30_000 });
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/platform/);
});

test("a company's own people never see the platform page", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  await page.goto("/platform");
  await expect(page).toHaveURL(/\/dashboard/);
});
