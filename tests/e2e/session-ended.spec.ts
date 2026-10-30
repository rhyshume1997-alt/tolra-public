/**
 * Decision: a session that simply ends server-side (timeout, revocation) keeps the device's offline queue for the same person, who
 * signs in again and the change syncs once. B23: a person who is disabled or removed is locked out at once and nothing is sent,
 * but the queue is kept on the device under its own scope (not wiped) for authorised recovery. (Unit side:
 * tests/unit/session-ended.test.ts, tests/unit/offline-sync-authority.test.ts.)
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, withDb } from "../support/fixtures";
import { playJob, signIn, world } from "./helpers";

const w = world();
let n = 0;

/** A new workshop login in the second company, so ending its sessions disturbs no other spec. */
async function newWorkshopLogin() {
  n += 1;
  const email = `ended${n}.${randomUUID().slice(0, 8)}.${w.runId}@example.test`;
  const password = generatePassword(14);
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message);
  const { error: addError } = await admin.rpc("add_member", { p_org: w.tenants.beta.id, p_email: email, p_role: "workshop" });
  if (addError) throw new Error(addError.message);
  return { id: data.user.id, email, password, role: "workshop" as const };
}

const cutOff = async (page: Page) => { for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected")); };
const offlineKeys = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  const req = indexedDB.open("tolra-offline", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("kv");
  req.onsuccess = () => { const keys = req.result.transaction("kv").objectStore("kv").getAllKeys(); keys.onsuccess = () => resolve(keys.result.length); };
}));

async function queueStart(page: Page, jobNo: string) {
  await page.goto("/jobs");
  const row = page.getByRole("row").filter({ hasText: jobNo });
  await expect(row).toBeVisible();
  await cutOff(page);
  await page.reload();
  await playJob(page, row, jobNo, { bench: true }); // 049: Start needs the bench (or a machine) picked first
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
}

test("session ended server-side: the queue stays on the device, and signing in again as the same person syncs it once", async ({ page }, testInfo) => {
  const admin = adminClient();
  const jobNo = `J-END-${w.runId}-${testInfo.repeatEachIndex}`;
  const { data } = await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Ended Co" }).select("id").single();
  const user = await newWorkshopLogin();
  const startedAt = async () => (await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at;

  await signIn(page, user);
  await queueStart(page, jobNo);

  // The connection comes back, but the server has ended this session (what a timeout or a revocation does).
  await withDb((db) => db.query("delete from auth.sessions where user_id = $1", [user.id]));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // One evaluate for both events: the first one alone can start the redirect, which would destroy the context of a second call.
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.waitForLoadState("load"); // the redirect has settled before the page is read again

  // Nothing was wiped and nothing reached the server.
  expect(await offlineKeys(page)).toBeGreaterThan(0);
  expect(await startedAt()).toBeNull();

  // The same person signs in again: the change that waited is sent, once.
  await page.getByLabel("Username or email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 45_000 });
  await page.goto("/jobs");
  await expect.poll(startedAt, { timeout: 30_000 }).not.toBeNull();
  const syncedAt = await startedAt();
  await expect.poll(() => offlineKeys(page).then(async () => (await page.getByText("1 change waiting to sync.").count()))).toBe(0);
  expect(await startedAt()).toBe(syncedAt);
});

test("session ended server-side: a different person signing in on that device does not sync or see the queue", async ({ page }, testInfo) => {
  const admin = adminClient();
  const jobNo = `J-ENDB-${w.runId}-${testInfo.repeatEachIndex}`;
  const { data } = await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Ended Co" }).select("id").single();
  const user = await newWorkshopLogin();
  const other = await newWorkshopLogin();

  await signIn(page, user);
  await queueStart(page, jobNo);
  await withDb((db) => db.query("delete from auth.sessions where user_id = $1", [user.id]));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.waitForLoadState("load"); // the redirect has settled before the page is read again

  await page.getByLabel("Username or email").fill(other.email);
  await page.getByLabel("Password", { exact: true }).fill(other.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 45_000 });
  await page.goto("/jobs");
  await expect(page.getByRole("row").filter({ hasText: jobNo })).toBeVisible();
  await expect(page.getByText("1 change waiting to sync.")).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect((await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at).toBeNull();
});

test("removed from the company while offline with a queued change: access locks, the change is kept (B23) and nothing is sent", async ({ page }, testInfo) => {
  const admin = adminClient();
  const jobNo = `J-ENDR-${w.runId}-${testInfo.repeatEachIndex}`;
  const { data } = await admin.from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Ended Co" }).select("id").single();
  const user = await newWorkshopLogin();
  const startedAt = async () => (await admin.from("jobs").select("started_at").eq("id", data!.id).single()).data?.started_at;
  const outboxKey = `u:${user.id}|o:${w.tenants.beta.id}|outbox`;
  const queued = () => page.evaluate((key) => new Promise<unknown>((resolve, reject) => {
    const req = indexedDB.open("tolra-offline", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const get = req.result.transaction("kv").objectStore("kv").get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result ?? null); };
      get.onerror = () => reject(get.error);
    };
  }), outboxKey);

  await signIn(page, user);
  await queueStart(page, jobNo);
  const before = await queued();
  expect(before).toHaveLength(1);
  expect(await offlineKeys(page)).toBeGreaterThan(0);

  const { error } = await admin.from("organization_members").update({ active: false }).eq("user_id", user.id).eq("organization_id", w.tenants.beta.id);
  expect(error).toBeNull();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // Removed access ends in two steps: the shell's soft /login, then endAccess's own hard /login?disabled=1 (lib/use-user.ts). Reading
  // the page between the two hits "Execution context was destroyed", so wait for the second, the final page, before reading it.
  await page.waitForURL(/\/login\?disabled=1/, { timeout: 30_000 });
  await page.waitForLoadState("load"); // the redirect has settled before the page is read again

  // Locked: the access-ended mark is set for this person and the app does not open again.
  expect(await page.evaluate((id) => localStorage.getItem(`tolra-offline-access-ended:${id}`), user.id)).toBe("1");
  // Kept, not wiped: the queued change is still on the device exactly as it was queued, under its own scope.
  expect(await queued()).toEqual(before);
  // Nothing was sent, also after the connection has been back for a while and the page is reloaded.
  expect(await startedAt()).toBeNull();
  await page.waitForTimeout(3000);
  await page.reload();
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("1 change waiting to sync.")).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(await startedAt()).toBeNull();
  expect(await queued()).toEqual(before);
});
