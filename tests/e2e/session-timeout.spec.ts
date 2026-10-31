/**
 * Agreed session limits in the browser: the workshop tablet locks after 30 minutes without use and asks for the password again,
 * keeping the changes made offline; an office sign-in left for more than 12 hours ends at the next page. The clock is moved by
 * writing the "last used" time the app itself keeps, not by waiting.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { playJob, signIn, world } from "./helpers";

const w = world();
const MIN = 60 * 1000;

const setLastActive = (page: Page, ago: number) => page.evaluate((ms) => window.localStorage.setItem("tolra-last-active", String(Date.now() - ms)), ago);

test("workshop: still signed in at 29 minutes; locked after 30, offline changes kept, password brings it back and the change syncs", async ({ page }, testInfo) => {
  const admin = adminClient();
  const jobNo = `J-LOCK-${w.runId}-${testInfo.repeatEachIndex}`; // one job per repeat, or a repeated run finds the earlier one too
  const { data } = await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Lock Co" }).select("id").single();
  const user = w.tenants.beta.users.workshop;

  await signIn(page, user);
  await page.goto("/jobs");
  const row = () => page.getByRole("row").filter({ hasText: jobNo });
  await expect(row()).toBeVisible();

  // A change made while the connection is down.
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await playJob(page, row(), jobNo, { bench: true });
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // 29 minutes of nothing: still in.
  await setLastActive(page, 29 * MIN);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // the check runs synchronously on focus
  await expect(page).toHaveURL(/\/jobs/);
  await expect(row()).toBeVisible();

  // 31 minutes: locked.
  await setLastActive(page, 31 * MIN);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(/\/login\?locked=1/, { timeout: 20_000 });
  await expect(page.getByText("This device was locked after 30 minutes without use.")).toBeVisible();
  await expect(page.getByText("1 change you made offline is still saved on this device and will be sent when you sign in.")).toBeVisible();
  // The server no longer lets this browser in without the password.
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login/);
  expect((await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at).toBeNull();

  // The password brings it back, and the change that waited is sent.
  await page.getByLabel("Username or email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 45_000 });
  await page.goto("/jobs");
  await expect.poll(async () => (await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at, { timeout: 20_000 }).not.toBeNull();
});

test("workshop: reopening the page after 31 minutes locks at once, and the stored time is not restarted by the reload (regression)", async ({ page }) => {
  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  // The tablet was put down 31 minutes ago; the page is opened again (a reload mounts the dashboard afresh).
  await setLastActive(page, 31 * MIN);
  await page.reload();
  await page.waitForURL(/\/login\?locked=1/, { timeout: 20_000 });
  await expect(page.getByText("This device was locked after 30 minutes without use.")).toBeVisible();
  // It stays locked: nothing restarted the clock, and the server no longer accepts the session.
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login/);
});

test("workshop: a tap or a key press after the 30 minutes locks; it records no new time and does not rescue the sign-in (regression)", async ({ page }) => {
  const user = w.tenants.beta.users.workshop;
  for (const input of ["pointerdown", "keydown"] as const) {
    await signIn(page, user);
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
    // The tablet was put down 31 minutes ago and nothing has checked yet; then someone touches it.
    await setLastActive(page, 31 * MIN);
    const { before, after } = await page.evaluate((name) => {
      const before = window.localStorage.getItem("tolra-last-active");
      window.dispatchEvent(name === "keydown" ? new KeyboardEvent("keydown", { key: "a" }) : new Event("pointerdown"));
      return { before, after: window.localStorage.getItem("tolra-last-active") };
    }, input);
    // The touch did not write "now" over the expired time (it is unchanged, or already removed by the lock).
    expect({ input, rescued: after !== null && after !== before }).toEqual({ input, rescued: false });
    await page.waitForURL(/\/login\?locked=1/, { timeout: 20_000 });
    await expect(page.getByText("This device was locked after 30 minutes without use.")).toBeVisible();
    await page.goto("/jobs");
    await expect(page).toHaveURL(/\/login/);
  }
});

test("workshop: a reload inside 30 minutes does not lock, and does not restart the clock either", async ({ page }) => {
  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  await setLastActive(page, 20 * MIN);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  const stored = Number(await page.evaluate(() => window.localStorage.getItem("tolra-last-active")));
  expect(Date.now() - stored).toBeGreaterThan(19 * MIN); // the reload did not write "now" over the 20 minutes
});

test("office: a sign-in unused for more than 12 hours ends at the next page; used within 12 hours it carries on", async ({ page, context }) => {
  await signIn(page, w.tenants.beta.users.office);
  const cookie = (ago: number) => context.addCookies([{ name: "tolra_last_active", value: String(Date.now() - ago), url: new URL(page.url()).origin }]);

  await cookie(11 * 60 * MIN);
  await page.goto("/quotes");
  await expect(page).toHaveURL(/\/quotes/);
  // Every page request the open page still has in flight (prefetches, data) is answered with a fresh last-use cookie. Let them
  // finish first, or one can land after the 13-hour cookie below and silently bring the sign-in back.
  await page.waitForLoadState("networkidle");

  await cookie(13 * 60 * MIN);
  // Two things end the sign-in at once: the server sends the request to sign-in, and the open page's own idle check does too.
  // Whichever is first cancels the other navigation (ERR_ABORTED); both lead to the same place, which is what is checked.
  await page.goto("/quotes").catch((err: Error) => {
    if (!/ERR_ABORTED|interrupted by another navigation/.test(err.message)) throw err;
  });
  // The open page can also send the browser to a plain /login in that moment; the server still lands it on the expired message.
  await page.waitForURL(/\/login\?expired=1/, { timeout: 20_000 });
  await expect(page.getByText("You were signed out after 12 hours without use.")).toBeVisible();
  await page.goto("/quotes");
  await expect(page).toHaveURL(/\/login/);
});

test("office: a last-use cookie left from an earlier sign-in does not end a new sign-in (LOGOUT cause 2a)", async ({ page, context }) => {
  await signIn(page, w.tenants.beta.users.office);
  const origin = new URL(page.url()).origin;
  // A normal sign-out runs in the browser: it removes the Supabase session cookies but cannot remove the HttpOnly last-use cookie.
  await context.clearCookies({ name: /^sb-.+-auth-token(\.\d+)?$/ });
  await context.addCookies([{ name: "tolra_last_active", value: String(Date.now() - 13 * 60 * MIN), url: origin }]);

  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await expect(page).toHaveURL(/\/quotes/);
  await expect(page.getByText("You were signed out after 12 hours without use.")).toHaveCount(0);
  const lastActive = (await context.cookies(origin)).find((c) => c.name === "tolra_last_active");
  expect(Date.now() - Number(lastActive?.value)).toBeLessThan(5 * MIN);
});
