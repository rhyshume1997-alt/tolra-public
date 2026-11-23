/**
 * Tooly tour in the browser (ON by default). Inputs: two fresh admins of the alpha tenant, one created WITHOUT the "seen" flag and one WITH it
 * (SEEN_TOUR_METADATA, the app's real flag). Outputs: assertions only.
 * Proves: a new person gets the tour and it moves them to its step pages; Finish saves the flag and the person is not redirected again;
 * a person who has the flag is never redirected. Must not change: no other spec relies on this one; it creates and removes nothing outside
 * the synthetic world (teardown removes the users with the run).
 */
import { expect, test, type Page } from "@playwright/test";

import { TOUR_DONE_META_KEY } from "@/lib/auth/tour-flag";
import { generatePassword } from "@/lib/password";

import { adminClient, SEEN_TOUR_METADATA, type SyntheticUser } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let n = 0;

/** A new admin of alpha. `seen` sets the same flag the app saves when the tour is skipped or finished. */
async function newAdmin(seen: boolean): Promise<SyntheticUser> {
  n += 1;
  // The worker index keeps e-mails unique when a failed test restarts the worker and the count starts again at 0.
  const email = `tour${n}-${test.info().workerIndex}.${w.runId}@example.test`;
  const password = generatePassword(14);
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, ...(seen ? { user_metadata: SEEN_TOUR_METADATA } : {}) });
  if (error || !data.user) throw new Error(error?.message);
  const { error: addError } = await admin.rpc("add_member", { p_org: w.tenants.alpha.id, p_email: email, p_role: "admin" });
  if (addError) throw new Error(addError.message);
  return { id: data.user.id, email, password, role: "admin" };
}

const tour = (page: Page) => page.getByTestId("tooly-tour");
// The wrapper has no size of its own (its card is fixed-position), so Playwright reports it hidden: "shown" means the card itself is visible.
const card = (page: Page) => page.getByRole("region", { name: "Tooly tour" });

test("a new person gets the tour, can finish it, and is not redirected afterwards", async ({ page }) => {
  const user = await newAdmin(false);
  await signIn(page, user);

  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("tooly-tour-count")).toHaveText(/^Step 1 of \d+$/);
  const total = Number(/of (\d+)$/.exec((await page.getByTestId("tooly-tour-count").textContent()) ?? "")?.[1]);
  expect(total).toBeGreaterThan(1);

  // Walk every step with Next. The tour moves the page to each step's route on its own (navigation only).
  const routes = new Set<string>();
  for (let step = 1; step < total; step++) {
    await expect(tour(page)).toHaveAttribute("data-step", String(step));
    await expect(page.getByTestId("tooly-tour-next")).toHaveText("Next");
    await page.getByTestId("tooly-tour-next").click();
    await expect(tour(page)).toHaveAttribute("data-step", String(step + 1));
    routes.add(new URL(page.url()).pathname);
  }
  await expect(page.getByTestId("tooly-tour-next")).toHaveText("Finish");
  expect(routes.size).toBeGreaterThan(1);
  await page.getByTestId("tooly-tour-next").click();
  await expect(tour(page)).toHaveCount(0);

  // The seen flag is saved on the person's own account.
  await expect.poll(async () => {
    const { data } = await adminClient().auth.admin.getUserById(user.id);
    return data.user?.user_metadata?.[TOUR_DONE_META_KEY] ?? null;
  }).toBe(true);

  // Afterwards: no redirect to a step page, no tour, only the small Replay button on the Dashboard.
  await page.goto("/settings");
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/settings/);
  await expect(tour(page)).toHaveCount(0);
  await page.goto("/dashboard");
  await expect(page.getByTestId("tooly-tour-replay")).toBeVisible();
  await expect(tour(page)).toHaveCount(0);
});

test("a person who has seen the tour is not redirected and gets no tour", async ({ page }) => {
  const user = await newAdmin(true);
  await signIn(page, user);
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByTestId("tooly-tour-replay")).toBeVisible();

  await page.goto("/jobs");
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/jobs/);
  await expect(tour(page)).toHaveCount(0);
});
