/**
 * Go-live essentials, in the browser, against the local disposable backend only (synthetic tenants; extra users use
 * @example.test addresses carrying the run id, which teardown removes).
 *
 * - Sync status: an always-visible indicator in the top bar (here on a phone) says Online and synced / Offline / N waiting
 *   to upload / Upload failed, from the device's outbox. It sits in the bar's own row (covers no control). Tapping it lists
 *   what is waiting, with Retry; a change the server refused shows as needing attention.
 * - Display names: a person with no name is prompted (non-blocking), saves their own name, and the Job Board then names them;
 *   an admin sees who has no name in User Management and can add one.
 * - Empty states: a brand-new company sees one line on the Job Board, POs and invoices saying what to do next.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant, EMAIL_DOMAIN, type SyntheticUser } from "../support/fixtures";
import { generatePassword } from "@/lib/password";
import { deviceContext, VIEWPORTS } from "../support/ui-pr1-screenshots";
import { playJob, signIn, world } from "./helpers";

const w = world();
const baseURL = () => String(test.info().project.use.baseURL);
const PHONE = VIEWPORTS[0];

async function goOffline(page: Page) {
  // Only the browser loses Supabase; the app server still reaches it (as offline.spec.ts).
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("sync status on a phone: synced, offline with changes waiting, the list and Retry, and a refused upload needing attention", async ({ browser }) => {
  const admin = adminClient();
  const keep = `J-SYNC-${w.runId}`;
  const gone = `J-SYNCX-${w.runId}`;
  const { data, error } = await admin.from("jobs").insert([keep, gone].map((job_no) => ({ organization_id: w.tenants.beta.id, job_no, customer: "Sync Co" }))).select("id, job_no");
  expect(error).toBeNull();
  const idOf = (no: string) => data!.find((row) => row.job_no === no)!.id as string;

  const context = await deviceContext(browser, PHONE, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, w.tenants.beta.users.workshop);
    await page.goto("/jobs");
    const card = (no: string) => page.locator(`[data-testid="job-card"][data-job-no="${no}"]`);
    await expect(card(keep)).toBeVisible();
    await expect(card(gone)).toBeVisible();

    const indicator = page.getByTestId("sync-status");
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute("data-sync", "synced");
    await expect(indicator).toHaveAttribute("aria-label", "Sync status: Online and synced");
    await expect(page.getByTestId("sync-status-live")).toHaveAttribute("aria-live", "polite");
    await expect(page.getByTestId("sync-status-live")).toHaveText("Online and synced");

    // In the bar's own row: inside the screen, a touch-sized target, and on top of no other control.
    const box = (await indicator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const header = page.locator("header").first();
    for (const other of await header.locator("button:visible, a:visible").all()) {
      if ((await other.getAttribute("data-testid")) === "sync-status") continue;
      const otherBox = await other.boundingBox();
      if (otherBox) expect(overlaps(box, otherBox), `sync status overlaps ${await other.getAttribute("aria-label")}`).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // Offline: two Starts queue on the device.
    await goOffline(page);
    await page.reload();
    await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
    await expect(indicator).toHaveAttribute("data-sync", "offline");
    for (const no of [keep, gone]) await playJob(page, card(no), no, { bench: true }); // 049: the bench is a deliberate pick, then Play
    await expect(page.getByText("2 changes waiting to sync.")).toBeVisible();
    await expect(indicator).toHaveAttribute("aria-label", "Sync status: Offline – 2 changes kept on this device");
    await expect(page.getByTestId("sync-status-live")).toHaveText("Offline – 2 changes kept on this device");

    // Tapping it lists what is waiting.
    await indicator.tap();
    const panel = page.getByTestId("sync-panel");
    await expect(panel).toBeVisible();
    const waiting = panel.getByRole("list", { name: "Changes waiting to upload" });
    await expect(waiting.getByRole("listitem")).toHaveCount(2);
    await expect(waiting).toContainText(`Start · ${keep}`);
    await expect(waiting).toContainText(`Start · ${gone}`);
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(PHONE.width);

    // One of the jobs is removed meanwhile; the connection comes back and the person presses Retry.
    expect((await admin.from("jobs").delete().eq("id", idOf(gone)).select("id")).data).toHaveLength(1);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await panel.getByRole("button", { name: "Retry" }).tap();
    await expect.poll(async () => (await admin.from("jobs").select("started_at").eq("id", idOf(keep)).single()).data?.started_at ?? null).not.toBeNull();
    await expect(indicator).toHaveAttribute("data-sync", "failed");
    await expect(indicator).toHaveAttribute("aria-label", "Sync status: Upload failed – needs attention (1 change not saved)");
    const held = panel.getByRole("list", { name: "Changes that need attention" });
    await expect(held).toContainText(`Start · ${gone}`);
    await expect(panel.getByRole("list", { name: "Changes waiting to upload" })).toHaveCount(0);

    // The banner is still where it is resolved; once dismissed and back online, the indicator says synced.
    await panel.getByRole("button", { name: "Show details" }).tap();
    await expect(panel).toBeHidden();
    await page.getByText("1 offline change needs attention").click();
    await page.locator("#offline-notice").getByRole("button", { name: "Dismiss" }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(indicator).toHaveAttribute("data-sync", "synced");
  } finally {
    await context.close();
    await admin.from("jobs").delete().eq("organization_id", w.tenants.beta.id).in("job_no", [keep, gone]);
  }
});

test("a persistent error toast on a phone never covers Sync Status, and Sync Status still opens", async ({ browser }) => {
  const context = await deviceContext(browser, PHONE, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, w.tenants.beta.users.admin);
    // A real error toast that does not go away by itself: the archive overrides fail to load (useArchive shows it with duration: Infinity
    // and a Retry action). Nothing is hidden or restyled; the toast must simply not sit where the control is.
    await page.route("**/rest/v1/record_archive_state*", (route) => route.abort("connectionreset"));
    await page.goto("/sales-orders");
    const toast = page.locator("[data-sonner-toast][data-type='error']");
    await expect(toast).toBeVisible();
    // sonner slides a toast in (transform + opacity, 400 ms) and toBeVisible ignores both: measure the box only once it is at rest.
    await expect(toast).toHaveCSS("opacity", "1");
    await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();

    const indicator = page.getByTestId("sync-status");
    await expect(indicator).toBeVisible();
    // Nothing timed out under us: the toast is still the same visible one when the boxes are measured, and after the tap.
    const toastBox = (await toast.boundingBox())!;
    const indicatorBox = (await indicator.boundingBox())!;
    expect(toastBox.width).toBeGreaterThan(0);
    expect(overlaps(toastBox, indicatorBox), `toast ${JSON.stringify(toastBox)} overlaps Sync Status ${JSON.stringify(indicatorBox)}`).toBe(false);
    // The toast is on screen (not pushed off it) and the control is what is at its own centre point.
    expect(toastBox.x).toBeGreaterThanOrEqual(0);
    expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(PHONE.width);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(PHONE.height);
    const centre = { x: indicatorBox.x + indicatorBox.width / 2, y: indicatorBox.y + indicatorBox.height / 2 };
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[data-testid='sync-status']")), centre)).toBe(true);

    await indicator.tap(); // fails if anything covers the control
    await expect(page.getByTestId("sync-panel")).toBeVisible();
    await expect(toast).toBeVisible(); // still there: it never needed to be dismissed to reach the control
  } finally {
    await context.close();
  }
});

test("display names: a person with no name is prompted and saves their own; the admin sees who has none and can add one", async ({ browser, page }) => {
  const admin = adminClient();
  const solo = await createSoloTenant(w.runId, "names");
  const email = `nameless.names.${w.runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const workshop: SyntheticUser = { id: created.data.user!.id, email, password, role: "workshop" };
  const { data: added, error: addError } = await admin.rpc("add_member", { p_org: solo.id, p_email: email, p_role: "workshop" });
  expect(addError).toBeNull();
  expect(added).toBe("member");
  expect((await admin.from("user_profiles").select("full_name").eq("id", workshop.id).single()).data!.full_name).toBeNull();
  const jobNo = `J-NAME-${w.runId}`;
  expect((await admin.from("jobs").insert({ organization_id: solo.id, job_no: jobNo, customer: "Names Co", assigned_to: workshop.id })).error).toBeNull();

  // The admin (who has a name) gets no prompt, and sees who has none.
  await signIn(page, solo.admin);
  await expect(page.getByTestId("name-prompt")).toHaveCount(0);
  await page.goto("/admin/users");
  await expect(page.getByTestId("missing-names")).toContainText("1 person has no display name");
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row.getByTestId("no-display-name")).toBeVisible();
  await page.goto("/jobs");
  await expect(page.locator(`[data-job-no="${jobNo}"], tr:has-text("${jobNo}")`).first()).toBeVisible();
  // Assigned to someone with no name: said plainly, never a bare "—".
  await expect(page.getByTestId("job-assignee").filter({ hasText: "Assigned to (name not set)" }).first()).toBeVisible();
  await expect(page.getByTestId("job-assignee").filter({ hasText: "Assigned to —" })).toHaveCount(0);

  // The person signs in: a prompt, not a block. An e-mail address isn't a name; their own name saves under their own RLS.
  const context = await browser.newContext({ baseURL: baseURL() });
  const own = await context.newPage();
  try {
    await signIn(own, workshop);
    const prompt = own.getByTestId("name-prompt");
    await expect(prompt).toBeVisible();
    await expect(own.getByRole("link", { name: "Job Board" }).first()).toBeVisible(); // the page still works behind it
    await prompt.getByLabel("Display name").fill("nia@example.test");
    await prompt.getByRole("button", { name: "Save name" }).click();
    await expect(prompt.getByRole("alert")).toHaveText("Use a name, not an email address.");
    await prompt.getByLabel("Display name").fill("  Nia   Operator ");
    await prompt.getByRole("button", { name: "Save name" }).click();
    await expect(prompt).toBeHidden();
    expect((await admin.from("user_profiles").select("full_name").eq("id", workshop.id).single()).data!.full_name).toBe("Nia Operator");
    // Account Settings shows it and can change it again.
    await own.goto("/jobs");
    await expect(own.getByTestId("name-prompt")).toHaveCount(0);
  } finally {
    await context.close();
  }

  // The Job Board now names who the job is assigned to; the admin list no longer flags them.
  await page.goto("/jobs");
  await expect(page.getByTestId("job-assignee").filter({ hasText: "Assigned to Nia Operator" }).first()).toBeVisible();
  await page.goto("/admin/users");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("missing-names")).toHaveCount(0);
  await expect(row.getByTestId("no-display-name")).toHaveCount(0);

  // The admin can rename a member (a login that belongs to this company only), through the API under their own RLS.
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Display name")).toHaveValue("Nia Operator");
  await dialog.getByLabel("Display name").fill("Nia O'Brien");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("User updated")).toBeVisible();
  await expect.poll(async () => (await admin.from("user_profiles").select("full_name").eq("id", workshop.id).single()).data!.full_name).toBe("Nia O'Brien");
  const refused = await page.request.patch("/api/admin/users", { headers: { origin: baseURL() }, data: { user_id: workshop.id, full_name: "x@y.test" } });
  expect(refused.status()).toBe(400);
  // A login the admin's company doesn't own alone (the beta workshop user is not even a member here) can't be renamed.
  const foreign = await page.request.patch("/api/admin/users", { headers: { origin: baseURL() }, data: { user_id: w.tenants.beta.users.workshop.id, full_name: "Hijack" } });
  expect(foreign.status()).toBe(404);
  expect((await admin.from("user_profiles").select("full_name").eq("id", w.tenants.beta.users.workshop.id).single()).data!.full_name).not.toBe("Hijack");
});

test("empty states: a new company sees what to do next on the Job Board, POs and invoices", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, "empty");
  await signIn(page, solo.admin);
  await page.goto("/jobs");
  await expect(page.getByTestId("empty-hint")).toHaveText("No jobs yet. Convert a confirmed sales order to a job, or press New job to add one.");
  // Machine Schedule: lib/empty-hints scheduleEmptyHint is ready; wiring it in is left to the schedule sweep (it owns that page).
  await page.goto("/purchase-orders");
  await expect(page.getByTestId("empty-hint")).toHaveText("Add your suppliers first (Suppliers), then press New purchase order to order material.");
  await page.goto("/invoices");
  await expect(page.getByTestId("empty-hint")).toHaveText("Press Invoice from Delivery Notes to bill delivered work, or New invoice to start one.");
  // The always-visible sync status is there on a wide screen too.
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced");
  await expect(page.getByTestId("sync-status-text")).toHaveText("Synced");
});
