/**
 * An open app does not trust what it loaded at sign-in for ever (audit of PR H, finding 3). Removing a person from the company
 * ends their access at the next recheck (on focus, every 10 minutes, after each sync, also when the page was opened offline and
 * the connection came back without an "online" event), and the 12-hour offline limit locks a page that stays open, not only
 * one that is loaded.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";
import type { HeldEntry, OutboxEntry, PhotoOp } from "@/lib/offline/outbox";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let n = 0;

/** A new office login in the second company, so removing it disturbs no other spec. */
async function newOfficeLogin() {
  n += 1;
  const email = `recheck${n}.${randomUUID().slice(0, 8)}.${w.runId}@example.test`;
  const password = generatePassword(14);
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message);
  const { error: addError } = await admin.rpc("add_member", { p_org: w.tenants.beta.id, p_email: email, p_role: "office" });
  if (addError) throw new Error(addError.message);
  return { id: data.user.id, email, password, role: "office" as const };
}

async function removeFromCompany(userId: string) {
  const { error } = await adminClient().from("organization_members").update({ active: false }).eq("user_id", userId).eq("organization_id", w.tenants.beta.id);
  expect(error).toBeNull();
}

/** Read only the seeded evidence, including actual IndexedDB Blob bytes, not merely queue counts. */
/**
 * Sends "focus" so the page asks again. A background check may already have ended access and be on its way to /login, and then
 * the page the event was sent to is gone: that is the outcome the test waits for, so only that error is let through.
 */
async function focusPage(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))).catch((error: Error) => {
    if (!/Execution context was destroyed|because of a navigation/i.test(error.message)) throw error;
  });
}

async function evidenceOnDevice(page: Page, keys: string[]) {
  return page.evaluate(async (wanted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tolra-offline", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction("kv", "readonly");
      const values = await Promise.all(wanted.map((key) => new Promise<unknown>((resolve, reject) => {
        const request = tx.objectStore("kv").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
      return Promise.all(values.map(async (value) => value instanceof Blob
        ? { type: value.type, bytes: Array.from(new Uint8Array(await value.arrayBuffer())) }
        : value ?? null));
    } finally { db.close(); }
  }, keys);
}

for (const revoke of ["membership removed", "account disabled"] as const) {
  test(`${revoke}: two tabs lock without deleting pending/held photos or another scope`, async ({ page, context }) => {
    const user = await newOfficeLogin();
    await signIn(page, user);
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
    const second = await context.newPage();
    await second.goto("/jobs");
    await expect(second.getByRole("heading", { name: "Job Board" })).toBeVisible();

    // Keep synthetic evidence offline even if a periodic sync starts. Never send fake job IDs to the DB.
    await context.route("**/rest/v1/rpc/reserve_job_photo", (route) => route.abort("internetdisconnected"));
    const now = new Date().toISOString();
    const records: { key: string; value: OutboxEntry[] | HeldEntry[] | number[] }[] = [];
    for (const [userId, orgId] of [[user.id, w.tenants.beta.id], [user.id, w.tenants.alpha.id], [randomUUID(), w.tenants.beta.id]]) {
      const prefix = `u:${userId}|o:${orgId}`;
      for (const held of [false, true]) {
        const photoId = randomUUID();
        const blobKey = `${prefix}|blob:${photoId}`;
        const op: PhotoOp = { kind: "photo", photoId, jobId: randomUUID(), jobNo: "B23-EVIDENCE", note: "Keep original bytes", capturedAt: now, byteSize: 4, blobKey };
        const entry: OutboxEntry = { id: randomUUID(), queuedAt: now, op };
        records.push({ key: `${prefix}|${held ? "rejected" : "outbox"}`, value: held
          ? [{ ...entry, reason: "Synthetic held evidence", heldAt: now }]
          : [entry] });
        records.push({ key: blobKey, value: [0, 127, 255, held ? 1 : 2] });
      }
    }
    await page.evaluate(async (rows) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tolra-offline", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("kv");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("kv", "readwrite");
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
          for (const row of rows) tx.objectStore("kv").put(row.key.includes("|blob:")
            ? new Blob([new Uint8Array(row.value as number[])], { type: "image/jpeg" }) : row.value, row.key);
        });
      } finally { db.close(); }
    }, records);
    const keys = records.map(({ key }) => key);
    const expected = records.map(({ key, value }) => key.includes("|blob:") ? { type: "image/jpeg", bytes: value } : value);
    await expect.poll(() => evidenceOnDevice(page, keys)).toEqual(expected);

    if (revoke === "membership removed") await removeFromCompany(user.id);
    else {
      const { error } = await adminClient().from("user_profiles").update({ active: false }).eq("id", user.id);
      expect(error).toBeNull();
    }
    // Focus again while waiting, as a person returning to the tab would: on a slow runner the pass the first focus starts can still be
    // in flight when the removal lands. Each focus asks for a recheck; this tab must end at /login either way.
    await expect.poll(async () => { await focusPage(page); return page.url(); }, { timeout: 45_000, intervals: [1_000, 2_000, 5_000] }).toMatch(/\/login/);
    // Only the first tab receives focus. The other must lock through the shared revocation/auth signal.
    await expect(second).toHaveURL(/\/login/, { timeout: 30_000 });
    await expect.poll(() => evidenceOnDevice(page, keys)).toEqual(expected);
    expect(await page.evaluate((id) => localStorage.getItem(`tolra-offline-access-ended:${id}`), user.id)).toBe("1");
    await page.reload();
    await page.goto("/jobs");
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => evidenceOnDevice(page, keys)).toEqual(expected);
  });
}

test("membership removed while the page is open: access ends at the next recheck (on focus)", async ({ page }) => {
  const user = await newOfficeLogin();
  await signIn(page, user);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();

  await removeFromCompany(user.id);
  // Nothing has asked yet: the page still shows what it loaded.
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  // Coming back to the window asks again.
  await focusPage(page);
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login/);
});

test("a recheck already in flight when access is removed does not swallow the next one: its answer predates the removal", async ({ page }) => {
  // Every my_session answer (036: the recheck asks the session which company and role it has now; the minute sync pass asks too)
  // is held while armed, after the server has answered it: those answers are from before the removal. The route is installed
  // before sign-in and only passes requests through until armed, so interception is not switched on while the page's own
  // post-load sync and recheck requests are in flight. PR #97 run 39116346628 hit the 90 s test timeout inside the 30 s
  // waitForURL: the first held answer came about one sync period (60 s) after the focus, i.e. the focus recheck never asked
  // (a pass stuck in flight swallowed it; lib/access-recheck.ts createRecheckRunner now bounds that) and the held answer was
  // the sync pass's, from before the removal.
  let armed = false;
  let releasedAll = false;
  let answered!: () => void;
  const firstAnswered = new Promise<void>((resolve) => { answered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/rest\/v1\/rpc\/my_session(\?|$)/, async (route) => {
    if (!armed || releasedAll) return route.continue();
    const response = await route.fetch();
    answered();
    await released;
    await route.fulfill({ response });
  });

  const user = await newOfficeLogin();
  await signIn(page, user);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();

  armed = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // recheck 1: reads the server, then waits
  // Within the stall bound (lib/access-recheck.ts RECHECK_STALL_MS) plus a request, never a whole sync period.
  let noAnswer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([firstAnswered, new Promise<never>((_, reject) => {
    noAnswer = setTimeout(() => reject(new Error("no my_session answer within 20 s of focus")), 20_000);
  })]).finally(() => clearTimeout(noAnswer));
  await removeFromCompany(user.id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // recheck 2: asked while 1 is still in flight
  releasedAll = true;
  release();
  // Locked as removed, with nobody touching the page again: the access-ended mark is written only by the lock (endAccess or the
  // sync pass's suspendOfflineAccess), never by a plain sign-out, so this is stronger than "reached /login".
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  // The shell's soft /login and the lock's hard /login?ended=1 can land back to back, so a read between them can lose its page:
  // poll the mark until a settled /login page answers (still "1" or the test fails), never a single read racing the second load.
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`tolra-offline-access-ended:${id}`), user.id).catch(() => "navigating"), { timeout: 15_000 }).toBe("1");
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login/);
});

test("membership removed while the page is open: access ends by the next background check, within the 10-minute recheck, with nobody touching the page", async ({ page }) => {
  await page.clock.install();
  const user = await newOfficeLogin();
  await signIn(page, user);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();

  await removeFromCompany(user.id);
  // The first background check ends it: the minute sync pass (it finds no role and locks the offline copy, B23) or, at
  // the latest, the 10-minute recheck. Which one wins is a race, so the test asks only for the bound, never for "still open
  // at 9 minutes" (the sync pass locks well before that).
  await page.clock.fastForward("10:00");
  // Locked as removed (the access-ended mark), not merely signed out.
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  // The shell's soft /login and the lock's hard /login?ended=1 can land back to back, so a read between them can lose its page:
  // poll the mark until a settled /login page answers (still "1" or the test fails), never a single read racing the second load.
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`tolra-offline-access-ended:${id}`), user.id).catch(() => "navigating"), { timeout: 15_000 }).toBe("1");
});

test("opened offline and removed meanwhile: access ends at the first sync once the connection is back, with no \"online\" event (regression)", async ({ page }) => {
  await page.clock.install();
  const user = await newOfficeLogin();
  await signIn(page, user);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();

  // The browser loses Supabase (the app server still reaches it) and the page is opened again: it starts from the device's copy.
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await removeFromCompany(user.id);

  // Still cut off: the sync each minute and the recheck after it fail, and a failed request is not an answer.
  await page.clock.fastForward("01:05");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  await expect(page).toHaveURL(/\/jobs/);

  // The connection comes back but the browser says nothing ("online" never fires): the next sync's recheck reaches the server.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.clock.fastForward("01:05");
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/login/);
});

test("the offline limit passes while the page stays open: it locks, and what was queued stays on the device", async ({ page, context }) => {
  await page.clock.install();
  const user = await newOfficeLogin();
  await signIn(page, user);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();

  await context.setOffline(true);
  // 11 hours offline: still open (a touch of the screen each hour keeps the 12-hour idle limit from being the reason).
  for (let hour = 0; hour < 11; hour += 1) {
    await page.clock.fastForward("01:00:00");
    await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
  }
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  // Past 12 hours since the server last confirmed this person.
  await page.clock.fastForward("01:01:00");
  await expect(page.getByRole("heading", { name: "Connect to sign in again" })).toBeVisible();
  await expect(page.getByTestId("offline-kept")).toBeVisible();
});
