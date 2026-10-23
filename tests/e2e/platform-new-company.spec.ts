/**
 * The platform owner's "New company" button (POST /api/platform/organizations). The owner (second step passed) creates a company
 * from the page and sees it in the list; a taken slug or name is refused in plain words; the route itself, called directly, refuses
 * everyone else: a company admin, office and workshop user, an owner who has not passed the second step, and nobody signed in.
 * The world is read inside the tests, never at import. Every company made here has a synthetic slug, so the run's cleanup removes it.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";
import { slugFromName } from "@/lib/new-company";

import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { enrolTotp, totpCode } from "../support/totp";
import { asSeparateDevice, signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const ROUTE = "/api/platform/organizations";
type Person = { id: string; email: string; password: string };
let owner: Person;
let ownerSecret: string;
let lastCode = "";

async function makePerson(label: string): Promise<Person> {
  const email = `${label}.${world().runId}@example.test`;
  const password = generatePassword(14);
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${label} Person` } });
  if (error || !data.user) throw new Error(error?.message);
  return { id: data.user.id, email, password };
}

const slugFor = (key: string) => `${SYNTHETIC_SLUG_PREFIX}${world().runId}-${key}`;

async function signInPasswordOnly(page: Page, person: Person) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(select-role|dashboard|choose-company|platform|mfa)/, { timeout: 45_000 });
}

/** A code that was not used a moment ago (a code is single-use inside its 30-second window). */
async function freshCode() {
  let code = totpCode(ownerSecret);
  while (code === lastCode) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    code = totpCode(ownerSecret);
  }
  lastCode = code;
  return code;
}

async function ownerOnPlatform(page: Page) {
  await signInPasswordOnly(page, owner);
  await expect(page).toHaveURL(/\/mfa/);
  await page.getByLabel("6-digit code").fill(await freshCode());
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/platform/, { timeout: 30_000 });
}

const post = (request: APIRequestContext, body: unknown) => request.post(ROUTE, { data: body, headers: { "Content-Type": "application/json" } });
const companyRows = (slug: string) => withDb((db) => db.query<{ id: string; name: string; status: string }>("select id, name, status from public.organizations where slug = $1", [slug]));

test.beforeAll(async () => {
  owner = await makePerson("newco-owner");
  // A platform owner is a signed-in person with a profile; here it comes from a viewer membership of one test company, as in two-level-access.spec.ts.
  expect((await adminClient().rpc("add_member", { p_org: world().tenants.alpha.id, p_email: owner.email, p_role: "viewer" })).data).toBe("member");
  ownerSecret = (await enrolTotp(await signedInClient(owner))).secret;
  lastCode = totpCode(ownerSecret);
  // On the platform list because the database owner put them there (the SQL editor); the only ordinary membership is a viewer one in a test company.
  await withDb((db) => db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner (new company)')", [owner.id]));
});

test("the platform owner creates a company from the page and it appears in the list", async ({ page }) => {
  const w = world();
  await ownerOnPlatform(page);
  await expect(page.getByRole("heading", { name: "Companies" })).toBeVisible();
  await page.getByRole("button", { name: "New company" }).click();
  const dialog = page.getByRole("dialog", { name: "New company" });
  await expect(dialog).toBeVisible();

  // The slug follows the name until it is edited by hand.
  const name = `Newco Fabrication ${w.runId}`;
  await dialog.getByLabel("Company name").fill(name);
  await expect(dialog.getByLabel("Slug")).toHaveValue(slugFromName(name));
  const slug = slugFor("newco");
  await dialog.getByLabel("Slug").fill(slug.toUpperCase());
  await expect(dialog.getByLabel("Slug")).toHaveValue(slug); // lower-cased as typed
  await dialog.getByLabel("Company name").fill(`${name} Ltd`);
  await expect(dialog.getByLabel("Slug")).toHaveValue(slug); // an edited slug is left alone
  await dialog.getByLabel("Company name").fill(name);
  const adminEmail = `first.admin.${w.runId}@example.test`;
  await dialog.getByLabel("First admin e-mail", { exact: true }).fill(adminEmail);
  // The address is typed twice: a mismatch is refused in the form, and by the route itself, creating nothing.
  await dialog.getByLabel("First admin e-mail again").fill(adminEmail.replace("first", "frist"));
  await dialog.getByRole("button", { name: "Create company" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/don't match/);
  const mismatch = await post(page.request, { name, slug, adminEmail, confirmEmail: adminEmail.replace("first", "frist") });
  expect(mismatch.status()).toBe(400);
  expect(await mismatch.json()).toMatchObject({ field: "adminEmail" });
  expect((await companyRows(slug)).rowCount).toBe(0);
  await dialog.getByLabel("First admin e-mail again").fill(`  ${adminEmail.toUpperCase()} `);
  await page.screenshot({ path: "test-results/newco-dialog.png" });
  await dialog.getByRole("button", { name: "Create company" }).click();

  await expect(page.getByTestId("company-created")).toContainText(`${name} is set up`);
  await expect(dialog).toHaveCount(0);
  const card = page.getByTestId("platform-list").locator(`[data-company="${slug}"]`);
  await expect(card).toContainText(name);
  await expect(card).toContainText("0 active members");
  await page.screenshot({ path: "test-results/newco-list.png", fullPage: true });

  const rows = await companyRows(slug);
  expect(rows.rows).toMatchObject([{ name, status: "active" }]);
  const organizationId = rows.rows[0].id;
  const invites = await withDb((db) => db.query("select email, role from public.organization_invites where organization_id = $1", [organizationId]));
  expect(invites.rows).toEqual([{ email: adminEmail, role: "admin" }]);
  const settings = await withDb((db) => db.query("select company_profile ->> 'name' as name from public.organization_settings where organization_id = $1", [organizationId]));
  expect(settings.rows).toEqual([{ name }]);
  // The database recorded who created it (migration 039), once, in the new company's own audit chain.
  const audit = await withDb((db) => db.query("select actor_user_id, actor_email, entity_table, entity_id, metadata, hash is not null as chained from security_audit.audit_log where action = 'PLATFORM_CREATE_ORGANIZATION' and organization_id = $1", [organizationId]));
  expect(audit.rows).toEqual([{ actor_user_id: owner.id, actor_email: owner.email, entity_table: "organizations", entity_id: organizationId, metadata: { source: "platform", slug, admin_email: adminEmail }, chained: true }]);

  // Reloading still shows it: it is a real company, not page state.
  await page.reload();
  await expect(page.getByTestId("platform-list").locator(`[data-company="${slug}"]`)).toContainText(name);
});

test("a taken slug or name is refused in plain words and creates nothing", async ({ page }) => {
  const w = world();
  await ownerOnPlatform(page);
  const taken = slugFor("newco");
  await page.getByRole("button", { name: "New company" }).click();
  const dialog = page.getByRole("dialog", { name: "New company" });

  await dialog.getByLabel("Company name").fill(`Another Company ${w.runId}`);
  await dialog.getByLabel("Slug").fill(taken);
  await dialog.getByLabel("First admin e-mail", { exact: true }).fill(`other.${w.runId}@example.test`);
  await dialog.getByLabel("First admin e-mail again").fill(`other.${w.runId}@example.test`);
  await dialog.getByRole("button", { name: "Create company" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/web address.*already used by another company/);
  await page.screenshot({ path: "test-results/newco-duplicate-slug.png" });
  await expect(dialog).toBeVisible(); // nothing typed is lost
  expect((await companyRows(taken)).rowCount).toBe(1);

  await dialog.getByLabel("Slug").fill(slugFor("another"));
  await dialog.getByLabel("Company name").fill(`  newco FABRICATION ${w.runId} `);
  await dialog.getByRole("button", { name: "Create company" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/company with that name already exists/);
  expect((await companyRows(slugFor("another"))).rowCount).toBe(0);

  // Checked in the form first: a slug the database would refuse, and an e-mail that is not one.
  await dialog.getByLabel("Company name").fill(`Third Company ${w.runId}`);
  await dialog.getByLabel("Slug").fill("Not A Slug!");
  await dialog.getByRole("button", { name: "Create company" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/lower-case letters, numbers and hyphens/);
  await dialog.getByLabel("Slug").fill(slugFor("third"));
  await dialog.getByLabel("First admin e-mail", { exact: true }).fill("not-an-email");
  await dialog.getByRole("button", { name: "Create company" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/valid e-mail/);
  expect((await companyRows(slugFor("third"))).rowCount).toBe(0);
});

test("the route validates its input itself, and an existing login becomes the first admin at once", async ({ page }) => {
  const w = world();
  await ownerOnPlatform(page);
  const request = page.request;
  const ok = { name: `Direct Company ${w.runId}`, slug: slugFor("direct"), adminEmail: `direct.admin.${w.runId}@example.test`, confirmEmail: `direct.admin.${w.runId}@example.test` };

  for (const [label, body] of [
    ["empty name", { ...ok, name: "  " }],
    ["short slug", { ...ok, slug: "x" }],
    ["capital letters in the slug", { ...ok, slug: "Has-Caps" }],
    ["a slug with SQL in it", { ...ok, slug: "a'; drop table organizations;--" }],
    ["a slug over 48 characters", { ...ok, slug: "a".repeat(49) }],
    ["no confirmation e-mail", { name: ok.name, slug: ok.slug, adminEmail: ok.adminEmail }],
    ["a confirmation e-mail that is not a string", { ...ok, confirmEmail: 7 }],
    ["no e-mail", { ...ok, adminEmail: "" }],
    ["an e-mail without a domain", { ...ok, adminEmail: "someone@" }],
    ["a name of the wrong type", { ...ok, name: 5 }],
    ["an array", [ok]],
    ["a missing body", null],
  ] as Array<[string, unknown]>) {
    const response = await post(request, body);
    expect(response.status(), label).toBe(400);
    expect(await response.json(), label).toMatchObject({ error: expect.any(String) });
  }
  const garbage = await request.post(ROUTE, { data: "{not json", headers: { "Content-Type": "application/json" } });
  expect(garbage.status()).toBe(400);
  expect((await companyRows(ok.slug)).rowCount).toBe(0);

  // An existing login is made admin of the new company straight away; the answer does not say which case it was.
  const existing = await makePerson("existing-admin");
  const created = await post(request, { name: `Existing Admin Company ${w.runId}`, slug: slugFor("existing"), adminEmail: existing.email.toUpperCase(), confirmEmail: existing.email });
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body).toEqual({ ok: true, company: { organization_id: expect.any(String), name: `Existing Admin Company ${w.runId}`, slug: slugFor("existing"), status: "active" } });
  const membership = await withDb((db) => db.query("select role, active from public.organization_members where organization_id = $1 and user_id = $2", [body.company.organization_id, existing.id]));
  expect(membership.rows).toEqual([{ role: "admin", active: true }]);
  expect((await post(request, { ...ok, slug: slugFor("existing") })).status()).toBe(409);
});

for (const role of ["admin", "office", "workshop", "viewer"] as const) {
  test(`a company ${role} is refused at the route itself, and the page is not theirs`, async ({ page }) => {
    const w = world();
    await signIn(page, w.tenants.alpha.users[role]);
    const slug = slugFor(`refused-${role}`);
    const response = await post(page.request, { name: `Refused ${role} ${w.runId}`, slug, adminEmail: `refused.${role}.${w.runId}@example.test` });
    expect(response.status()).toBe(403);
    expect(JSON.stringify(await response.json())).not.toMatch(/platform|organi[sz]ation|company/i); // says nothing about what it guards
    expect((await companyRows(slug)).rowCount).toBe(0);
    await page.goto("/platform");
    await expect(page).toHaveURL(/\/dashboard/);
  });
}

test("nobody signed in is refused", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const slug = slugFor("anonymous");
    const response = await post(anonymous, { name: "Anonymous Co", slug, adminEmail: "anon@example.test" });
    expect(response.status()).toBe(401);
    expect((await companyRows(slug)).rowCount).toBe(0);
  } finally {
    await anonymous.dispose();
  }
});

test("a platform owner who has not passed the second step is refused, and so is a page from another site", async ({ page }) => {
  const w = world();
  await signInPasswordOnly(page, owner);
  await expect(page).toHaveURL(/\/mfa/); // password alone opens nothing
  const slug = slugFor("no-second-step");
  const response = await post(page.request, { name: `No Second Step ${w.runId}`, slug, adminEmail: `nss.${w.runId}@example.test` });
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ code: "mfa_required" });
  expect((await companyRows(slug)).rowCount).toBe(0);

  // After the second step the same session works, but a request that names another site as its origin is still refused.
  await page.getByLabel("6-digit code").fill(await freshCode());
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/platform/, { timeout: 30_000 });
  const foreign = await page.request.post(ROUTE, { data: { name: `Foreign ${w.runId}`, slug: slugFor("foreign"), adminEmail: `foreign.${w.runId}@example.test` }, headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
  expect(foreign.status()).toBe(403);
  expect((await companyRows(slugFor("foreign"))).rowCount).toBe(0);
  // The Origin check on its own, without the browser's cross-site hint.
  const originOnly = await page.request.post(ROUTE, { data: { name: `Origin ${w.runId}`, slug: slugFor("origin"), adminEmail: `origin.${w.runId}@example.test` }, headers: { "Content-Type": "application/json", Origin: "https://evil.example" } });
  expect(originOnly.status()).toBe(403);
  expect((await companyRows(slugFor("origin"))).rowCount).toBe(0);
});
