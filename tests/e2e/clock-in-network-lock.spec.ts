/**
 * Clock-in network lock (migration 114, M27): the browser side of what tests/db/clock-in-network-lock-114.test.ts proves in SQL.
 *   Settings > Clock-in network lock (components/time/clock-in-lock-card.tsx), Admin > Users "Can clock in off site (while the network
 *   lock is on)" (components/time/clock-in-off-site.tsx), Weekly hours > This week notice (components/time/network-unverified-notice.tsx),
 *   and the clock buttons on the daily job sheet (/time), which the lock refuses or lets through in the database.
 *
 * WHICH ADDRESS THE DATABASE SEES (read before changing anything here). 075's request_client_ip() takes the address ONLY from the
 * `cf-connecting-ip` header in PostgREST's request.headers (set per request by the server). The disposable stack (supabase start: Kong
 * in front of PostgREST) has no Cloudflare, and Kong does not add that header, so an ordinary request has NO address (null). Nothing
 * rewrites it either, so a header the test sends reaches PostgREST unchanged: this is exactly 075's "spoofing caveat" (header note 5),
 * and here it is what lets a test play both a workshop network and another one. The app's own Next server is not in the path (the
 * browser calls Supabase directly), so the header is added to the browser's requests to /rest/v1 with page.route (above `viaAddress`)
 * and, for API-level calls, with the Supabase client's global headers. Production is different: Cloudflare overwrites the header.
 *
 * Two kinds of test follow from that, and the spec says which it is running:
 *   - ADDRESS CONTROLLED (header sent): Lock records that address; a workshop user's clock action from another address is refused
 *     with the "workshop Wi-Fi" wording, from the locked address it goes in; the exemption lets them in off site. These need the stack
 *     to pass the header through. `beforeAll` PROBES that once (my_request_network with and without the header). If the header does not
 *     come back, those tests are SKIPPED with the reason, never silently passed. If it does, but the browser route cannot add it, the
 *     first browser assertion ("This device reaches Tolra from <ip>") fails with that cause.
 *   - NO ADDRESS (plain request, the stack's normal case): what the code does with a null address is asserted as it is: Lock is refused
 *     (hint ip_unknown, nothing locked; the button is disabled), and a clock action while the lock is on is ACCEPTED (it cannot be
 *     checked) and marked network_unverified (reason address_unknown), which the week review lists. These run when the plain probe
 *     shows no address, and are skipped otherwise (a gateway that did add one).
 * Not covered here, by design: synced-later (device clock behind) is address-independent and is proved in the SQL proof and the unit test.
 *
 * Runs in its own company (createSoloTenant + an office user and two workshop users): the lock and the exemptions are per company, and
 * a lock left on would refuse the clock actions of other specs in a shared tenant. Everything the spec writes is removed with the run's
 * companies (global teardown), and the lock is cleared again in afterAll.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { fmtDateTime } from "@/lib/dates";
import { generatePassword } from "@/lib/password";
import { UNKNOWN } from "@/lib/people";
import { EMAIL_DOMAIN, adminClient, createSoloTenant, headAsGet, type SyntheticUser, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { signIn, world } from "./helpers";

const w = world();

/** Public documentation addresses (RFC 5737): not private, so 075's parse accepts them as a site. */
const LOCK_IP = "203.0.113.7";
const RECAPTURE_IP = "203.0.113.9";
const OTHER_IP = "198.51.100.23";
const LOCK_NET = `${LOCK_IP}/32`;
const RECAPTURE_NET = `${RECAPTURE_IP}/32`;

const LOCK_CARD_SENTENCE = "Everyone clocks in from this network unless an admin marks them as able to clock in off site";
const FLAG_CARD_SENTENCE = "The Flag check never refuses; the network lock below does.";
const TOGGLE_LABEL = "Can clock in off site (while the network lock is on)";
const REFUSED = /from the workshop Wi-Fi/;

type Company = {
  id: string;
  admin: SyntheticUser;
  office: SyntheticUser;
  /** Used for the address-controlled clock tests (in -> refused -> in -> out sequence). */
  workshop: SyntheticUser;
  /** Used for the no-address clock test only, so the two sequences never share clock state. */
  workshopTwo: SyntheticUser;
  adminName: string;
};
let company: Company;
/** What the stack lets a test control (probed in beforeAll). */
let plainIp: string | null = null;
let headerIp: string | null = null;
const canControl = () => headerIp === LOCK_IP;

test.describe.configure({ mode: "serial" });

// ----- helpers ------------------------------------------------------------------------------------------------------------------------

/** A Supabase client signed in as `user`, sending `ip` as cf-connecting-ip on every request (none when null). */
async function clientVia(user: SyntheticUser, ip: string | null): Promise<SupabaseClient> {
  const backend = isolatedBackend();
  const client = createClient(backend.apiUrl, backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: headAsGet, headers: ip ? { "cf-connecting-ip": ip } : {} },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`);
  return client;
}

/**
 * Makes this page's calls to Supabase (the browser goes straight to /rest/v1) arrive with `cf-connecting-ip: address.ip`, as if from
 * that network. Change address.ip between steps to move the "device". null = no header (the stack's normal, address-less request).
 * The preflight (OPTIONS) is left alone; the real request carries the header.
 */
async function viaAddress(page: Page, address: { ip: string | null }) {
  await page.route("**/rest/v1/**", async (route) => {
    const request = route.request();
    if (!address.ip || request.method() === "OPTIONS") return route.continue();
    return route.continue({ headers: { ...request.headers(), "cf-connecting-ip": address.ip } });
  });
}

/** A fresh browser (own storage, so a refused action held on the device never leaks into the next step), signed in. */
async function openAs(browser: Browser, user: SyntheticUser, ip: string | null) {
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  const address = { ip };
  await viaAddress(page, address);
  await signIn(page, user);
  return { context, page, address };
}

/** The company's lock rows among the run's companies (so "this company only" can be asserted). */
async function lockRows() {
  const ids = [company.id, w.tenants.alpha.id, w.tenants.beta.id];
  return withDb(async (db) => (await db.query<{ organization_id: string; network: string; locked_by: string | null; locked_at: Date }>(
    "select organization_id, network::text as network, locked_by, locked_at from public.clock_in_network_locks where organization_id = any($1::uuid[])", [ids])).rows);
}

/** Puts the lock on/off directly (the database, not the app), for the tests that are about something other than pressing the button. */
async function setLockDirect(network: string | null) {
  await withDb(async (db) => {
    if (network) {
      await db.query(
        `insert into public.clock_in_network_locks (organization_id, network, locked_by) values ($1, $2::cidr, $3)
         on conflict (organization_id) do update set network = excluded.network, locked_by = excluded.locked_by, locked_at = clock_timestamp()`,
        [company.id, network, company.admin.id]);
    } else {
      await db.query("delete from public.clock_in_network_locks where organization_id = $1", [company.id]);
    }
  });
}

async function actionsOf(userId: string): Promise<string[]> {
  return withDb(async (db) => (await db.query<{ action: string }>(
    "select action from public.attendance_events where user_id = $1 and organization_id = $2 order by at, received_at", [userId, company.id])).rows.map((r) => r.action));
}

async function offSiteOf(userId: string): Promise<boolean | null> {
  return withDb(async (db) => (await db.query<{ off_site_allowed: boolean }>(
    "select off_site_allowed from public.clock_in_network_exemptions where organization_id = $1 and user_id = $2", [company.id, userId])).rows[0]?.off_site_allowed ?? null);
}

/** Admin > Users: the row for this person. */
const userRow = (page: Page, user: SyntheticUser) => page.getByTestId("user-row").filter({ hasText: user.email });
const offSiteBox = (page: Page, user: SyntheticUser) => userRow(page, user).getByTestId("clock-in-off-site").getByRole("checkbox");

/** Ticks or unticks "Can clock in off site" in Admin > Users and waits for the database to hold it (a controlled box: click, then expect). */
async function setOffSiteInUsers(page: Page, user: SyntheticUser, on: boolean) {
  await page.goto("/admin/users");
  await expect(userRow(page, user)).toBeVisible();
  const box = offSiteBox(page, user);
  await expect(box).toBeVisible();
  if ((await box.isChecked()) !== on) await box.click();
  if (on) await expect(box).toBeChecked(); else await expect(box).not.toBeChecked();
  await expect.poll(() => offSiteOf(user.id), { message: `exemption saved for ${user.email}` }).toBe(on);
}

/** Opens /time and presses one clock button. */
async function pressClock(page: Page, testId: "clock-in" | "clock-out") {
  await page.goto("/time");
  await expect(page.getByTestId("day-sheet")).toBeVisible();
  await page.getByTestId(testId).click();
}

// ----- setup --------------------------------------------------------------------------------------------------------------------------

test.beforeAll(async () => {
  const solo = await createSoloTenant(w.runId, "iplock");
  const admin = adminClient();
  const person = async (role: "office" | "workshop", label: string, fullName: string): Promise<SyntheticUser> => {
    const email = `${label}.iplock.${w.runId}@${EMAIL_DOMAIN}`;
    const password = generatePassword(16);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    const added = await admin.rpc("add_member", { p_org: solo.id, p_email: email, p_role: role });
    if (added.error || added.data !== "member") throw new Error(`add_member ${email}: ${added.error?.message ?? added.data}`);
    return { id: data.user.id, email, password, role };
  };
  const office = await person("office", "office", "Lock Office");
  const workshop = await person("workshop", "workshop", "Lock Workshop One");
  const workshopTwo = await person("workshop", "workshoptwo", "Lock Workshop Two");

  // The name the card prints for "by <admin>": the company's display name for the admin, as company_people gives it.
  const adminApi = await clientVia(solo.admin, null);
  const who = await adminApi.rpc("company_people");
  if (who.error) throw new Error(`company_people: ${who.error.message}`);
  const adminName = ((who.data as Array<{ user_id: string; display_name: string | null }>).find((p) => p.user_id === solo.admin.id)?.display_name ?? "").trim() || UNKNOWN;
  company = { id: solo.id, admin: solo.admin, office, workshop, workshopTwo, adminName };

  // Probe: what address does the database see, with and without the header? (admin only: my_request_network)
  const seen = async (client: SupabaseClient) => {
    const { data, error } = await client.rpc("my_request_network");
    if (error) throw new Error(`my_request_network: ${error.message}`);
    return (data as { ip: string | null }).ip;
  };
  plainIp = await seen(adminApi);
  headerIp = await seen(await clientVia(solo.admin, LOCK_IP));
  console.log(`[iplock] address without header: ${plainIp ?? "none"}; with cf-connecting-ip ${LOCK_IP}: ${headerIp ?? "none"}`);
});

test.afterAll(async () => {
  if (company) await setLockDirect(null);
});

// ----- 1. The card: what an admin sees, and who never does ------------------------------------------------------------------------------

test("Settings: the admin sees the lock card Unlocked with the everyone-is-covered wording; the 075 card says the Flag check never refuses", async ({ browser }) => {
  const { context, page } = await openAs(browser, company.admin, null);
  try {
    await page.goto("/settings");
    const card = page.getByTestId("clock-in-lock-card");
    await expect(card).toBeVisible();
    // The card title is a CardTitle div (no heading role), as on every Settings card.
    await expect(card.locator('[data-slot="card-title"]')).toHaveText("Clock-in network lock");
    await expect(card.getByTestId("clock-in-lock-state")).toHaveText("Unlocked: clock-in works from any network.");
    await expect(card).toContainText(LOCK_CARD_SENTENCE);
    await expect(card).toContainText("Can clock in off site");
    await expect(page.getByTestId("site-network-card")).toContainText(FLAG_CARD_SENTENCE);
    expect(await lockRows()).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const role of ["office", "workshop"] as const) {
  test(`Settings: ${role} never sees the lock card (access denied), and can't lock through the API either`, async ({ browser }) => {
    const user = company[role];
    const { context, page } = await openAs(browser, user, canControl() ? LOCK_IP : null);
    try {
      // The middleware is the real gate (ROUTE_ROLES: /settings is admin only): the page is never served, the browser is sent to the
      // dashboard (as roles.spec.ts asserts). The "Access Denied" heading is only the cosmetic RoleGate fallback, never reached here.
      await page.goto("/settings");
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByTestId("clock-in-lock-card")).toHaveCount(0);
      await expect(page.getByText("Clock-in network lock")).toHaveCount(0);
    } finally {
      await context.close();
    }
    const api = await clientVia(user, canControl() ? LOCK_IP : null);
    const lock = await api.rpc("lock_clock_in_network");
    expect(lock.error?.hint, `${role} lock`).toBe("admin_only");
    expect(lock.status).toBe(403);
    expect(await lockRows()).toEqual([]);
  });
}

// ----- 2. The address-less path (the disposable stack's normal request) ------------------------------------------------------------------

test("no address (a plain request): Lock is disabled and refused with ip_unknown; nothing is locked", async ({ browser }) => {
  test.skip(plainIp !== null, `the stack gives a plain request an address (${plainIp}); the null-address path can't be shown here`);
  const { context, page } = await openAs(browser, company.admin, null);
  try {
    await page.goto("/settings");
    const card = page.getByTestId("clock-in-lock-card");
    await expect(card.getByTestId("clock-in-lock-here")).toContainText("an address Tolra can't see");
    await expect(card.getByTestId("clock-in-lock-button")).toBeDisabled();
  } finally {
    await context.close();
  }
  const api = await clientVia(company.admin, null);
  const lock = await api.rpc("lock_clock_in_network");
  expect(lock.error?.hint).toBe("ip_unknown");
  expect(lock.error?.message).toContain("can't see the address");
  expect(await lockRows()).toEqual([]);
});

// ----- 3. Lock, Re-capture, Unlock through the card -------------------------------------------------------------------------------------

test("admin presses Lock: Locked to <ip> since <date> by <admin>, one row for this company only; Re-capture and Unlock work", async ({ browser }) => {
  test.skip(!canControl(), `cf-connecting-ip is not passed through by this stack (database saw ${headerIp ?? "no address"} for ${LOCK_IP}): the controllable-address case can't run`);
  test.setTimeout(150_000);
  const { context, page, address } = await openAs(browser, company.admin, LOCK_IP);
  try {
    await page.goto("/settings");
    const card = page.getByTestId("clock-in-lock-card");
    const state = card.getByTestId("clock-in-lock-state");
    await expect(state).toHaveText("Unlocked: clock-in works from any network.");
    // The browser's route works only if the card reports the address we sent.
    await expect(card.getByTestId("clock-in-lock-here")).toContainText(LOCK_IP);

    // Lock.
    await card.getByTestId("clock-in-lock-button").click();
    const dialog = page.getByRole("dialog", { name: "Lock clock-in to this network?" });
    await expect(dialog).toContainText(LOCK_NET);
    await dialog.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(state).toContainText(`Locked to ${LOCK_NET} (IPv4) since`);
    const rows = await lockRows();
    expect(rows.map((r) => r.organization_id)).toEqual([company.id]); // this company only, none for alpha or beta
    expect(rows[0].network).toBe(LOCK_NET);
    expect(rows[0].locked_by).toBe(company.admin.id);
    await expect(state).toContainText(`Locked to ${LOCK_NET} (IPv4) since ${fmtDateTime(rows[0].locked_at)} by ${company.adminName}.`);
    await expect(card.getByTestId("clock-in-lock-here")).toContainText("clock-ins from here go in");

    // From another network the card says a clock-in would be refused (the database decides; the card mirrors it).
    address.ip = OTHER_IP;
    await page.reload();
    await expect(card.getByTestId("clock-in-lock-here")).toContainText(`${OTHER_IP}: not the locked network (a clock-in from here would be refused)`);

    // Re-capture to the address this device is on now.
    address.ip = RECAPTURE_IP;
    await page.reload();
    await expect(state).toContainText(`Locked to ${LOCK_NET}`);
    await card.getByTestId("clock-in-lock-recapture").click();
    const again = page.getByRole("dialog", { name: "Re-capture the clock-in network?" });
    await expect(again).toContainText(`instead of ${LOCK_NET}`);
    await again.getByRole("button", { name: "Re-capture", exact: true }).click();
    await expect(state).toContainText(`Locked to ${RECAPTURE_NET} (IPv4) since`);
    expect((await lockRows()).map((r) => [r.organization_id, r.network])).toEqual([[company.id, RECAPTURE_NET]]);

    // Unlock.
    await card.getByTestId("clock-in-lock-unlock").click();
    const unlock = page.getByRole("dialog", { name: "Unlock clock-in?" });
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(state).toHaveText("Unlocked: clock-in works from any network.");
    expect(await lockRows()).toEqual([]);
  } finally {
    await context.close();
  }
});

// ----- 4. The lock refuses the workshop user from another network; the exemption lets them in --------------------------------------------

test("with the lock on, a workshop clock action from another network is refused (nothing recorded) and from the locked network it goes in", async ({ browser }) => {
  test.skip(!canControl(), `cf-connecting-ip is not passed through by this stack (database saw ${headerIp ?? "no address"} for ${LOCK_IP}): the controllable-address case can't run`);
  test.setTimeout(180_000);
  // The admin locks it through the API from the workshop network (the card is proved above).
  const lock = await (await clientVia(company.admin, LOCK_IP)).rpc("lock_clock_in_network");
  expect(lock.error).toBeNull();
  expect((lock.data as { network: string }).network).toBe(LOCK_NET);

  // Exact database behaviour, all four clock actions, from another network: 42501 (HTTP 403), hint clock_in_network_locked, the wording, nothing recorded.
  const away = await clientVia(company.workshop, OTHER_IP);
  for (const action of ["in", "out", "break_start", "break_end"]) {
    const r = await away.rpc("record_attendance_event", { p_client_op_id: crypto.randomUUID(), p_action: action, p_at: new Date().toISOString(), p_device: "e2e" });
    expect(r.error?.code, action).toBe("42501");
    expect(r.error?.hint, action).toBe("clock_in_network_locked");
    expect(r.error?.message, action).toMatch(REFUSED);
    expect(r.status, action).toBe(403);
  }
  expect(await actionsOf(company.workshop.id)).toEqual([]);

  // In the browser: Clock in from the other network is refused and says so; the sheet still reads Not clocked in.
  const off = await openAs(browser, company.workshop, OTHER_IP);
  try {
    await pressClock(off.page, "clock-in");
    await expect(off.page.getByText(REFUSED).first()).toBeVisible();
    await expect(off.page.getByTestId("clock-state")).toHaveText("Not clocked in");
    expect(await actionsOf(company.workshop.id)).toEqual([]);
  } finally {
    await off.context.close();
  }

  // The same person from the locked network clocks in.
  const on = await openAs(browser, company.workshop, LOCK_IP);
  try {
    await pressClock(on.page, "clock-in");
    await expect(on.page.getByTestId("clock-state")).toContainText("Clocked in since");
    expect(await actionsOf(company.workshop.id)).toEqual(["in"]);
  } finally {
    await on.context.close();
  }
});

// ----- 5. Admin > Users: the exemption toggle ---------------------------------------------------------------------------------------------

test("Admin > Users: the admin toggles Can clock in off site for the workshop user (saved, shown on the lock card); office has no control and gets 403", async ({ browser }) => {
  test.setTimeout(150_000);
  const admin = await openAs(browser, company.admin, null);
  try {
    await admin.page.goto("/admin/users");
    await expect(userRow(admin.page, company.workshop)).toBeVisible();
    await expect(userRow(admin.page, company.workshop).getByTestId("clock-in-off-site")).toContainText(TOGGLE_LABEL);
    expect(await offSiteOf(company.workshop.id)).toBeNull(); // no row = the lock applies to them

    await setOffSiteInUsers(admin.page, company.workshop, true);
    await admin.page.reload();
    await expect(offSiteBox(admin.page, company.workshop)).toBeChecked(); // survives a reload
    await expect(offSiteBox(admin.page, company.workshopTwo)).not.toBeChecked(); // only that person
    await admin.page.goto("/settings");
    await expect(admin.page.getByTestId("clock-in-lock-off-site")).toHaveText("1 person can clock in off site.");

    await setOffSiteInUsers(admin.page, company.workshop, false);
    expect(await offSiteOf(company.workshop.id)).toBe(false);
    await admin.page.goto("/settings");
    await expect(admin.page.getByTestId("clock-in-lock-off-site")).toHaveCount(0);
  } finally {
    await admin.context.close();
  }

  // Office: no Admin > Users, so no control; the database refuses them too (42501, HTTP 403) and nothing changes.
  const office = await openAs(browser, company.office, null);
  try {
    await office.page.goto("/admin/users");
    await expect(office.page).toHaveURL(/\/dashboard/); // /admin is admin only in the middleware: sent to the dashboard, not served
    await expect(office.page.getByTestId("clock-in-off-site")).toHaveCount(0);
  } finally {
    await office.context.close();
  }
  for (const user of [company.office, company.workshop]) {
    const api = await clientVia(user, null);
    const set = await api.rpc("set_clock_in_off_site_allowed", { p_user: company.workshop.id, p_allowed: true });
    expect(set.error?.code, user.role).toBe("42501");
    expect(set.error?.hint, user.role).toBe("admin_only");
    expect(set.status, user.role).toBe(403);
  }
  expect(await offSiteOf(company.workshop.id)).toBe(false);
});

test("the exemption: with Can clock in off site ticked the workshop user clocks out from another network; unticked, the next clock-in is refused again", async ({ browser }) => {
  test.skip(!canControl(), `cf-connecting-ip is not passed through by this stack (database saw ${headerIp ?? "no address"} for ${LOCK_IP}): the controllable-address case can't run`);
  test.setTimeout(240_000);
  // State from the lock test above: the lock is on, the person has one "in" recorded and is clocked in.
  expect(await lockRows().then((r) => r.map((x) => x.network))).toEqual([LOCK_NET]);
  expect(await actionsOf(company.workshop.id)).toEqual(["in"]);

  const admin = await openAs(browser, company.admin, null);
  try {
    // Ticked: the clock-out from another network goes in.
    await setOffSiteInUsers(admin.page, company.workshop, true);
    const off = await openAs(browser, company.workshop, OTHER_IP);
    try {
      await pressClock(off.page, "clock-out");
      await expect(off.page.getByTestId("clock-state")).toHaveText("Not clocked in");
      expect(await actionsOf(company.workshop.id)).toEqual(["in", "out"]);
    } finally {
      await off.context.close();
    }

    // Unticked: from the same other network the next clock-in is refused again.
    await setOffSiteInUsers(admin.page, company.workshop, false);
    const again = await openAs(browser, company.workshop, OTHER_IP);
    try {
      await pressClock(again.page, "clock-in");
      await expect(again.page.getByText(REFUSED).first()).toBeVisible();
      await expect(again.page.getByTestId("clock-state")).toHaveText("Not clocked in");
      expect(await actionsOf(company.workshop.id)).toEqual(["in", "out"]);
    } finally {
      await again.context.close();
    }
  } finally {
    await admin.context.close();
  }
});

// ----- 6. No address while locked: accepted, marked, listed in the week review --------------------------------------------------------------

test("no address while locked: the clock-in is accepted, marked network_unverified (address_unknown) and listed in the week review", async ({ browser }) => {
  test.skip(plainIp !== null, `the stack gives a plain request an address (${plainIp}); the null-address path can't be shown here`);
  test.setTimeout(150_000);
  await setLockDirect(LOCK_NET);
  const person = company.workshopTwo;
  const worker = await openAs(browser, person, null);
  try {
    await pressClock(worker.page, "clock-in");
    await expect(worker.page.getByTestId("clock-state")).toContainText("Clocked in since");
  } finally {
    await worker.context.close();
  }
  expect(await actionsOf(person.id)).toEqual(["in"]);
  const marks = await withDb(async (db) => (await db.query<{ user_id: string; action: string; reason: string }>(
    "select user_id, action, reason from public.clock_in_network_unverified where organization_id = $1", [company.id])).rows);
  expect(marks).toEqual([{ user_id: person.id, action: "in", reason: "address_unknown" }]);

  // The week review (admin) lists it, with the person's name and the reason.
  const admin = await openAs(browser, company.admin, null);
  try {
    await admin.page.goto("/time/week");
    const notice = admin.page.getByTestId("network-unverified");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("1 clock action this week was kept without a network check");
    await expect(notice.getByTestId("network-unverified-person")).toContainText("Lock Workshop Two");
    await expect(notice.getByTestId("network-unverified-person")).toContainText("no network address seen, not checked");
  } finally {
    await admin.context.close();
  }
});

// ----- 7. Another company ----------------------------------------------------------------------------------------------------------------

test("another company's admin can't read or change this company's lock or exemptions", async () => {
  // Something to protect: a lock on this company and one exemption.
  await setLockDirect(LOCK_NET);
  await withDb((db) => db.query(
    `insert into public.clock_in_network_exemptions (organization_id, user_id, off_site_allowed, updated_by) values ($1, $2, true, $3)
     on conflict (organization_id, user_id) do update set off_site_allowed = true`, [company.id, company.workshop.id, company.admin.id]));

  for (const [label, user] of [["beta admin", w.tenants.beta.users.admin], ["beta office", w.tenants.beta.users.office], ["alpha admin", w.tenants.alpha.users.admin]] as const) {
    const api = await clientVia(user, canControl() ? LOCK_IP : null);
    // Reads: rows of this company never come back (RLS), even when asked for by id.
    const locks = await api.from("clock_in_network_locks").select("organization_id, network").eq("organization_id", company.id);
    expect(locks.error, `${label} read lock`).toBeNull();
    expect(locks.data, `${label} read lock`).toEqual([]);
    const exempt = await api.from("clock_in_network_exemptions").select("user_id").eq("user_id", company.workshop.id);
    expect(exempt.error, `${label} read exemptions`).toBeNull();
    expect(exempt.data, `${label} read exemptions`).toEqual([]);
    const marks = await api.from("clock_in_network_unverified").select("event_id").eq("organization_id", company.id);
    expect(marks.data ?? [], `${label} read marks`).toEqual([]);
  }

  // Writes: the other company's admin can't set this company's person (not found in their company), and Unlock only ever touches their own.
  const betaAdmin = await clientVia(w.tenants.beta.users.admin, canControl() ? LOCK_IP : null);
  const set = await betaAdmin.rpc("set_clock_in_off_site_allowed", { p_user: company.workshop.id, p_allowed: false });
  expect(set.error?.hint).toBe("person_missing");
  const unlock = await betaAdmin.rpc("unlock_clock_in_network");
  expect(unlock.error).toBeNull();
  expect((unlock.data as { changed: boolean }).changed).toBe(false); // beta had no lock of its own
  // Direct writes are not granted to anyone signed in.
  const direct = await betaAdmin.from("clock_in_network_locks").delete().eq("organization_id", company.id);
  expect(direct.error).not.toBeNull();

  // Nothing of this company's moved, and the other companies hold no lock or exemption of their own.
  expect((await lockRows()).map((r) => [r.organization_id, r.network])).toEqual([[company.id, LOCK_NET]]);
  expect(await offSiteOf(company.workshop.id)).toBe(true);
  const others = await withDb(async (db) => (await db.query<{ n: number }>(
    "select count(*)::int as n from public.clock_in_network_exemptions where organization_id = any($1::uuid[])", [[w.tenants.alpha.id, w.tenants.beta.id]])).rows[0].n);
  expect(others).toBe(0);
});
