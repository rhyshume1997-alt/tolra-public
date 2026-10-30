/**
 * Two tabs of one browser session (E4c). The tabs share one login, so what one tab does to the session reaches the other:
 *
 * 1. A person with two companies switches company in tab A. Tab B (open on another page) follows: it lands on /dashboard in the new
 *    company and is never sent to sign-in as if access had ended.
 * 2. An admin saves the company details in tab A. Tab B shows the new details without a reload.
 * 3. Signing out in tab A takes tab B to sign-in promptly.
 * 4. Revocation is not weakened: a person removed from their company, in both tabs, still ends at sign-in (/login?disabled=1) - also
 *    when they belong to a second company, Y: removal from the current company X ends access, it is not a "switch" the tabs follow to Y.
 *
 * Every company and person here is made for the test (synthetic slug and e-mail carrying the run id, removed with the rest of the run's
 * data), so changing a company's name or removing a member disturbs no other spec. The world is read inside the tests, never at import.
 * Unit side: tests/unit/company-sync-tabs.test.ts.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { asSeparateDevice, signIn, world } from "./helpers";

type Person = { id: string; email: string; password: string; role: "office" | "admin" };
type Company = { id: string; name: string };

const short = () => randomUUID().slice(0, 8);

async function makePerson(label: string, role: Person["role"]): Promise<Person> {
  const email = `${label}.${short()}.${world().runId}@example.test`;
  const password = generatePassword(14);
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${label} Person` } });
  if (error || !data.user) throw new Error(error?.message);
  return { id: data.user.id, email, password, role };
}

/** A company of its own. `adminEmail` becomes its admin (the person under test, or a stand-in when the person is only an office login). */
async function makeCompany(label: string, adminEmail: string): Promise<Company> {
  const w = world();
  const name = `Tabs ${label} ${short()} ${w.runId}`;
  const { data, error } = await adminClient().rpc("create_organization", {
    p_name: name,
    p_slug: `${SYNTHETIC_SLUG_PREFIX}${w.runId}-tabs-${label}-${short()}`,
    p_admin_email: adminEmail,
    p_company_profile: { documentName: name, addressLines: ["1 Test Road"], vatRegistered: false },
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "create_organization returned no id");
  return { id: data, name };
}

async function addOffice(company: Company, person: Person) {
  const { error } = await adminClient().rpc("add_member", { p_org: company.id, p_email: person.email, p_role: "office" });
  if (error) throw new Error(error.message);
}

/** An office login in two companies of its own. */
async function officeInTwoCompanies() {
  const person = await makePerson("twotabs", "office");
  const standIn = await makePerson("twotabs-admin", "admin");
  const first = await makeCompany("one", standIn.email);
  const second = await makeCompany("two", standIn.email);
  await addOffice(first, person);
  await addOffice(second, person);
  return { person, first, second };
}

/** An office login in one company of its own (so removing it disturbs nobody). */
async function officeInOneCompany() {
  const person = await makePerson("twotabs", "office");
  const standIn = await makePerson("twotabs-admin", "admin");
  const company = await makeCompany("solo", standIn.email);
  await addOffice(company, person);
  return { person, company };
}

/** Signs in through the form, picks `company` on the chooser and lands on the dashboard. */
async function signInAndChoose(page: Page, person: Person, company: Company) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/choose-company/, { timeout: 45_000 });
  await page.getByRole("button", { name: `Open ${company.name}` }).click();
  await page.waitForURL(/\/(select-role|dashboard)/, { timeout: 30_000 });
  if (page.url().includes("/select-role")) {
    await page.getByRole("button", { name: person.role === "admin" ? "Continue as Admin" : "Continue as Office" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  }
}

/** Opens a page in this tab; an admin or two-role person is asked for the role view first, so answer it. */
async function openPage(page: Page, path: string, person: Person) {
  await page.goto(path);
  if (page.url().includes("/select-role")) {
    await page.getByRole("button", { name: person.role === "admin" ? "Continue as Admin" : "Continue as Office" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    await page.goto(path);
  }
}

/** The company name the sidebar shows (the company profile's trading name). */
const shownName = (page: Page, name: string) => page.locator("p", { hasText: name }).first();
const companyPicker = (page: Page) => page.getByLabel("Switch organisation").first();

/** Every address the tab visits, so a test can prove it was never sent to sign-in on the way. */
function recordNavigations(page: Page) {
  const urls: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) urls.push(frame.url()); });
  return urls;
}

/**
 * Sends "focus" so the page asks again. A check may already have ended access and be on its way to /login, and then the page the
 * event was sent to is gone: that is the outcome the test waits for, so only that error is let through.
 */
async function focusPage(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))).catch((error: Error) => {
    if (!/Execution context was destroyed|because of a navigation/i.test(error.message)) throw error;
  });
}

test("a company switch in one tab: the other tab follows to the dashboard of the new company, not to sign-in", async ({ page, context }) => {
  const { person, first, second } = await officeInTwoCompanies();
  await signInAndChoose(page, person, first);
  await openPage(page, "/customers", person);

  // Tab B is on another page of the first company.
  const tabB = await context.newPage();
  await openPage(tabB, "/customers", person);
  await expect(tabB).toHaveURL(/\/customers/);
  await expect(companyPicker(tabB)).toHaveValue(first.id);
  await expect(shownName(tabB, first.name)).toBeVisible();
  const visited = recordNavigations(tabB);

  // Tab A switches from the menu.
  await companyPicker(page).selectOption({ label: second.name });
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  await expect(companyPicker(page)).toHaveValue(second.id);

  // Tab B follows: the dashboard of the new company, with the new company's name and not the old one's.
  await expect(tabB).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  await expect(companyPicker(tabB)).toHaveValue(second.id, { timeout: 30_000 });
  await expect(shownName(tabB, second.name)).toBeVisible();
  await expect(tabB.locator("p", { hasText: first.name })).toHaveCount(0);
  // It stays there (no late bounce to sign-in) and never went there on the way.
  await expect(tabB).toHaveURL(/\/dashboard/);
  expect(visited.filter((url) => /\/login/.test(url))).toEqual([]);
  expect(tabB.url()).not.toMatch(/disabled=1/);
});

test("company details saved in one tab: the other tab shows them without a reload", async ({ page, context }) => {
  const person = await makePerson("twotabs-details", "admin");
  const company = await makeCompany("details", person.email);
  await signIn(page, person);

  const tabB = await context.newPage();
  await openPage(tabB, "/dashboard", person);
  await expect(tabB).toHaveURL(/\/dashboard/);
  await expect(shownName(tabB, company.name)).toBeVisible();
  const visited = recordNavigations(tabB);
  // A marker on tab B's window: it is gone if the page was reloaded, so the change below must have arrived without one.
  await tabB.evaluate(() => { (window as unknown as { __tabBLoaded: string }).__tabBLoaded = "same page"; });

  await openPage(page, "/settings", person);
  await expect(page.getByTestId("company-details-form")).toHaveAttribute("data-loaded", "true");
  const renamed = `Renamed ${short()} ${world().runId}`;
  await page.getByRole("textbox", { name: "Trading name", exact: true }).fill(renamed);
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Company details saved")).toBeVisible();

  await expect(shownName(tabB, renamed)).toBeVisible({ timeout: 30_000 });
  expect(await tabB.evaluate(() => (window as unknown as { __tabBLoaded?: string }).__tabBLoaded)).toBe("same page");
  expect(visited.filter((url) => /\/login/.test(url))).toEqual([]);
});

test("signing out in one tab: the other tab goes to sign-in promptly", async ({ page, context }) => {
  const { person, first } = await officeInTwoCompanies();
  await signInAndChoose(page, person, first);
  await openPage(page, "/customers", person);

  const tabB = await context.newPage();
  await openPage(tabB, "/customers", person);
  await expect(companyPicker(tabB)).toHaveValue(first.id);

  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });

  // Nobody touches tab B: the storage signal makes it check now, well inside the 10-minute recheck.
  await expect(tabB).toHaveURL(/\/login/, { timeout: 30_000 });
});

test("revocation is not weakened: a person removed from their company ends at sign-in (disabled) in both tabs", async ({ page, context }) => {
  const { person, company } = await officeInOneCompany();
  await signIn(page, person);
  await openPage(page, "/jobs", person);
  const tabB = await context.newPage();
  await openPage(tabB, "/jobs", person);
  await expect(tabB).toHaveURL(/\/jobs/);

  const { error } = await adminClient().from("organization_members").update({ active: false }).eq("user_id", person.id).eq("organization_id", company.id);
  expect(error).toBeNull();

  // Focus again while waiting, as a person returning to the tab would: a check already in flight can predate the removal.
  await expect.poll(async () => { await focusPage(page); return page.url(); }, { timeout: 45_000, intervals: [1_000, 2_000, 5_000] }).toMatch(/\/login\?disabled=1/);
  // Only tab A was focused: tab B ends through the shared signal, and is not sent to a dashboard instead.
  await expect(tabB).toHaveURL(/\/login/, { timeout: 30_000 });
  await tabB.goto("/jobs");
  await expect(tabB).toHaveURL(/\/login/);
});

test("revocation is not weakened: a person in TWO companies removed from the current one (X) ends at sign-in in both tabs, and does not follow to the other (Y)", async ({ page, context }) => {
  const { person, first: x, second: y } = await officeInTwoCompanies();
  await signInAndChoose(page, person, x);
  await openPage(page, "/jobs", person);
  const tabB = await context.newPage();
  await openPage(tabB, "/jobs", person);
  await expect(tabB).toHaveURL(/\/jobs/);
  await expect(companyPicker(tabB)).toHaveValue(x.id);
  const visited = recordNavigations(tabB);

  // An admin removes the person from X only; they stay an active member of Y.
  const admin = adminClient();
  const { error } = await admin.from("organization_members").update({ active: false }).eq("user_id", person.id).eq("organization_id", x.id);
  expect(error).toBeNull();
  const { data: stillY } = await admin.from("organization_members").select("active").eq("user_id", person.id).eq("organization_id", y.id).single();
  expect(stillY?.active).toBe(true);

  await expect.poll(async () => { await focusPage(page); return page.url(); }, { timeout: 45_000, intervals: [1_000, 2_000, 5_000] }).toMatch(/\/login\?disabled=1/);
  await expect(tabB).toHaveURL(/\/login\?disabled=1/, { timeout: 30_000 });
  // Neither tab went on into Y's dashboard on the way.
  expect(visited.filter((url) => /\/dashboard/.test(url))).toEqual([]);
  expect(page.url()).not.toMatch(/\/dashboard/);
});
