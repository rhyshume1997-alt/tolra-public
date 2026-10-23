/**
 * Offline workshop mode (lib/offline): with Supabase unreachable from the browser, the Job Board and worksheets
 * open from this device's copy with an "Offline - last synced" banner; Start and worksheet saves queue on the
 * device and sync in order when the connection is back; a worksheet someone else changed meanwhile is kept on both
 * sides and flagged; signing out wipes the device's copy.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { playJob, signIn, world } from "./helpers";

const w = world();

async function goOffline(page: Page) {
  // Only the browser loses Supabase; the app server (middleware) still reaches it, as when Supabase is blocked locally.
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
}
async function goOnline(page: Page) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}
const offlineKeys = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  const req = indexedDB.open("tolra-offline", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("kv");
  req.onsuccess = () => { const keys = req.result.transaction("kv").objectStore("kv").getAllKeys(); keys.onsuccess = () => resolve(keys.result.length); };
}));

test("offline: read from the device, queue Start and a worksheet save, sync in order, keep both on conflict, wipe on sign-out", async ({ page }) => {
  const admin = adminClient();
  const jobNo = `J-OFF-${w.runId}`;
  const { data } = await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Offline Co", heat_cast_no: "H1" }).select("id").single();
  const id = data!.id as string;

  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  const row = () => page.getByRole("row").filter({ hasText: jobNo });
  await row().getByRole("button", { name: "Worksheet" }).click(); // stores this job's worksheet on the device
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  await expect(sheet.getByLabel("Heat / Cast #")).toHaveValue("H1");
  await page.keyboard.press("Escape");
  expect(await offlineKeys(page)).toBeGreaterThan(0);

  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await expect(row()).toBeVisible();

  await playJob(page, row(), jobNo, { bench: true });
  await expect(page.getByText(`${jobNo} started on the bench on this device. It will sync when you're back online.`)).toBeVisible();
  await row().getByRole("button", { name: "Worksheet" }).click();
  await expect(sheet.getByText("Offline: showing this device's copy.")).toBeVisible();
  await sheet.getByLabel("Heat / Cast #").fill("MINE");
  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  await expect(page.getByText("Saved on this device. It will sync when you're back online.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("2 changes waiting to sync.")).toBeVisible();
  expect((await admin.from("jobs").select("started_at, heat_cast_no").eq("id", id).single()).data).toMatchObject({ started_at: null, heat_cast_no: "H1" });

  // Someone else saves the worksheet while this device is offline.
  await admin.from("jobs").update({ heat_cast_no: "THEIRS" }).eq("id", id);

  await goOnline(page);
  await expect(page.getByText("1 offline change needs attention")).toBeVisible();
  const after = (await admin.from("jobs").select("started_at, heat_cast_no").eq("id", id).single()).data!;
  expect(after.started_at).not.toBeNull(); // Start synced
  expect(after.heat_cast_no).toBe("THEIRS"); // their save not overwritten
  await page.getByText("1 offline change needs attention").click();
  await expect(page.getByText("Someone changed this worksheet while you were offline.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply my version" })).toBeVisible();

  // The held conflict is unsynced work (040 review, must-fix 1): signing out asks first and names what would go.
  const asked: string[] = [];
  page.once("dialog", (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); });
  await page.getByRole("button", { name: "Log out" }).first().click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain("1 change made offline hasn't synced yet. Signing out removes it from this device for good.");
  expect(asked[0]).toContain(`Job: ${jobNo}.`);
  // Cancel: still signed in, the conflict still held on the device.
  expect(page.url()).toContain("/jobs");
  await expect(page.getByText("1 offline change needs attention")).toBeVisible();
  expect(await offlineKeys(page)).toBeGreaterThan(0);

  // OK: signed out and the device wiped; the sign-in page says what went.
  page.once("dialog", (dialog) => { asked.push(dialog.message()); void dialog.accept(); });
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL(/\/login/);
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain(`Job: ${jobNo}.`);
  expect(await offlineKeys(page)).toBe(0);
  await expect(page.getByText(`1 offline change that hadn't synced was removed from this device. Job: ${jobNo}.`)).toBeVisible();
});

test("offline: signing out with unsynced changes asks first; Cancel keeps them, OK removes them and says so", async ({ page }) => {
  const admin = adminClient();
  const jobNo = `J-OFF2-${w.runId}`;
  await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Offline Co" });

  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  const row = () => page.getByRole("row").filter({ hasText: jobNo });
  await expect(row()).toBeVisible();
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await playJob(page, row(), jobNo, { bench: true });
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();

  // Cancel: still signed in, the change still queued.
  const asked: string[] = [];
  page.once("dialog", (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); });
  await page.getByRole("button", { name: "Log out" }).first().click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain("1 change made offline hasn't synced yet. Signing out removes it from this device");
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
  expect(page.url()).toContain("/jobs");

  // OK: signed out, the device is wiped, and the sign-in page says a change was removed.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL(/\/login/);
  expect(await offlineKeys(page)).toBe(0);
  await expect(page.getByText("1 offline change that hadn't synced was removed from this device.")).toBeVisible();
});

test("offline sign-in expires after 12 hours: the app stops opening offline, the queued change stays and syncs once online", async ({ page }) => {
  const admin = adminClient();
  const jobNo = `J-EXP-${w.runId}`;
  const { data } = await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Expiry Co" }).select("id").single();

  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  const row = () => page.getByRole("row").filter({ hasText: jobNo });
  await expect(row()).toBeVisible();
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await playJob(page, row(), jobNo, { bench: true });
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();

  // Within 12 hours: still opens offline. Then make the last online confirmation 13 hours old.
  await page.reload();
  await expect(row()).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("tolra-offline", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const store = open.result.transaction("kv", "readwrite").objectStore("kv");
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        const key = (keys.result as string[]).find((k) => k.endsWith("|snap:identity"));
        if (!key) return reject(new Error("no saved identity"));
        const get = store.get(key);
        get.onsuccess = () => {
          store.put({ ...get.result, syncedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() }, key);
          resolve();
        };
      };
    };
  }));

  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect to sign in again" })).toBeVisible();
  await expect(page.getByTestId("offline-kept")).toHaveText("1 change you made offline is still saved on this device and will be sent once you are back online.");
  await expect(row()).toHaveCount(0);
  expect(await offlineKeys(page)).toBeGreaterThan(0);
  expect((await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at).toBeNull();

  // Back online: the app opens again as the same person and the queued Start is sent.
  await goOnline(page);
  await page.reload();
  await expect(row()).toBeVisible();
  await expect.poll(async () => (await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at, { timeout: 15000 }).not.toBeNull();
});
