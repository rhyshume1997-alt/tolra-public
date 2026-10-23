/**
 * Small fixes from the live sweep (no SQL): RFQ "Check inbox" is hidden while Microsoft 365 mail is off, bulk buttons wait
 * for a selection, the dashboard's Priority Jobs link to the job, a £0.00 quote cannot be sent, and the quote legend counts follow
 * the Show scope.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("RFQ: with mail off, there is no Check inbox button (hidden until built, Rhys Tue 20 Oct)", async ({ page }) => {
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/rfq");
  await expect(page.getByRole("heading", { name: "RFQ Control Centre" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Check inbox/ })).toHaveCount(0);
});

test("bulk buttons are disabled with nothing selected and say why", async ({ page }) => {
  await signIn(page, w.tenants.beta.users.admin);
  const pages: Array<[string, string[]]> = [
    ["/delivery-notes", ["Print Selected", "Mark Selected Signed"]],
    ["/sales-orders", ["Print Selected", "Convert Selected to Jobs", "Despatch Selected"]],
    ["/purchase-orders", ["Print Selected", "Mark Selected Received"]],
  ];
  for (const [path, names] of pages) {
    await page.goto(path);
    for (const name of names) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("title", /^Select at least one/);
    }
  }
});

test("dashboard Priority Jobs link to the job, which the Job Board shows and highlights", async ({ page }) => {
  const jobNo = `J-N10-${w.runId}`;
  // The dashboard lists the five open jobs with the earliest required date, so a very early date makes this the first.
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "N10 Co", description: "Priority link", date_required: "1990-01-01" }).select("id").single();
  expect(error).toBeNull();
  // The Priority Jobs card is on the workshop dashboard (admin/office see the needs-attention list instead).
  await signIn(page, w.tenants.beta.users.workshop);
  const link = page.locator("section").filter({ has: page.getByText("Priority Jobs", { exact: true }) }).getByRole("link", { name: new RegExp(jobNo) });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", `/jobs?job=${data!.id}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/jobs\\?job=${data!.id}`));
  await expect(page.locator(`[data-job-id="${data!.id}"][data-highlighted="true"]`).first()).toBeVisible();
});

test("a £0.00 draft cannot be sent: a clear message, nothing prepared", async ({ page }) => {
  const ref = `QUO-N12-${w.runId}`;
  expect((await adminClient().from("quotes").insert({ organization_id: w.tenants.beta.id, quote_ref: ref, customer: "N12 Co", total_value: 0, status: "draft" })).error).toBeNull();
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  // Table view: the Send button is an icon button named "Send <ref> to the customer".
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: new RegExp(`^Send ${ref} to the customer$`) }).click();
  await expect(page.getByText(`${ref} is £0.00, so it can't be sent. Add prices to its lines first.`)).toBeVisible();
  await expect(page.getByRole("dialog", { name: new RegExp(`^Send ${ref}`) })).toHaveCount(0);
  expect((await adminClient().from("quotes").select("status").eq("quote_ref", ref).single()).data?.status).toBe("draft");
});

test("N13: quote legend counts follow the Show scope: an expired quote counts under Done, not Open", async ({ page }) => {
  // Self-contained: an open (sent, still valid) quote so the Open scope is never empty and the legend renders, plus a quote
  // expired yesterday (relative to today), so it is Done and never old enough to be auto-archived.
  const expiredRef = `QUO-N13X-${w.runId}`;
  const openRef = `QUO-N13O-${w.runId}`;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const db = adminClient();
  expect((await db.from("quotes").insert({ organization_id: w.tenants.beta.id, quote_ref: openRef, customer: "N13 Open Co", total_value: 50, status: "sent", valid_until: day(30) })).error).toBeNull();
  expect((await db.from("quotes").insert({ organization_id: w.tenants.beta.id, quote_ref: expiredRef, customer: "N13 Expired Co", total_value: 50, status: "sent", valid_until: day(-1) })).error).toBeNull();
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  const legend = page.locator("div.text-xs.text-slate-600").filter({ hasText: "Expired (" }).first();
  const card = (ref: string) => page.locator('[data-slot="card"]', { hasText: ref });
  // Open scope: the open quote is listed and the legend renders, but the expired quote is neither listed nor counted.
  await page.getByRole("button", { name: /^Open \(\d+\)$/ }).first().click();
  await expect(card(openRef).first()).toBeVisible();
  await expect(card(expiredRef)).toHaveCount(0);
  await expect(legend).toBeVisible();
  const open = Number(/Expired \((\d+)\)/.exec(await legend.innerText())![1]);
  // Done scope: the expired quote is listed (and counted), the open one is not.
  await page.getByRole("button", { name: /^Done \(\d+\)$/ }).first().click();
  await expect(card(expiredRef).first()).toBeVisible();
  await expect(card(openRef)).toHaveCount(0);
  const done = Number(/Expired \((\d+)\)/.exec(await legend.innerText())![1]);
  expect(open).toBe(0);
  expect(done).toBeGreaterThanOrEqual(1);
});
