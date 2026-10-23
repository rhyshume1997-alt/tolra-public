/**
 * Who did what (migration 035, PR C), in the browser: the small who/when lines on a job and an invoice, with display names
 * only, for office and for the workshop (the workshop can open jobs, not invoices).
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);
// Read on first use inside a test, never at import: listing the suite needs no backend (helpers.world).
const alpha = () => w.tenants.alpha;

async function startedJob(no: string) {
  await withDb((db) => db.query(
    `insert into public.jobs (organization_id, job_no, customer, description, stage, started_at, started_by, created_by, due_date, date_required)
     values ($1, $2, 'Who Co', 'Bush', 'machining', '2026-10-01T08:30:00Z', $3, $4, '2099-01-05', '2099-01-05')`,
    [alpha().id, no, alpha().users.workshop.id, alpha().users.admin.id]));
}

test("office and the workshop see who created and started a job, by name and never by e-mail", async ({ browser }) => {
  // Two full sign-ins and two worksheets: 78 to 84 s on CI when it passes, so the default 90 s left no margin on a slow runner.
  test.setTimeout(180_000);
  const no = `J-WHO-${tag()}`;
  await startedJob(no);
  for (const role of ["office", "workshop"] as const) {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, alpha().users[role]);
    await page.goto("/jobs");
    await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Worksheet" }).first().click();
    const sheet = page.getByRole("dialog", { name: `Worksheet - ${no}` });
    const who = sheet.getByTestId("who-when");
    await expect(who).toBeVisible();
    await expect(who.getByTestId("who-when-line")).toHaveText([/^Created by Admin alpha/, /^Started by Workshop alpha · 01\/10\/2026, 09:30$/]);
    await expect(who).not.toContainText("@");
    // The activity panel names people too, and shows no e-mail address.
    await sheet.getByRole("button", { name: /^Activity/ }).click();
    await expect(sheet).not.toContainText(alpha().users.admin.email);
    await expect(sheet).not.toContainText(alpha().users.workshop.email);
    await page.context().close();
  }
});

test("an invoice shows who created and issued it, who recorded each payment, and who cleared it", async ({ page }) => {
  const ref = `INV-WHO-${tag()}`;
  await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, vat_enabled, created_by, issued_by, issued_at)
       values ($1, $2, 'Who Co', 100, 20, 120, 'issued', 0, '2099-01-31', true, $3, $3, '2026-10-02T09:00:00Z') returning id`, [alpha().id, ref, alpha().users.admin.id]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Machined bush', 1, 100, 20)", [alpha().id, rows[0].id]);
  });
  await signIn(page, alpha().users.office);
  await page.goto("/invoices");
  const row = page.getByRole("row").filter({ hasText: ref });
  await row.getByRole("button", { name: "Record payment" }).click();
  const payment = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
  await payment.getByRole("button", { name: "Save payment" }).click();
  await expect(payment).toBeHidden();

  await row.getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  const who = details.getByTestId("who-when");
  await expect(who).toBeVisible();
  await expect(who.getByTestId("who-when-line")).toHaveText([
    /^Created by Admin alpha/,
    /^Issued by Admin alpha · 02\/10\/2026, 10:00$/,
    /^Payment recorded by Office alpha · /,
    /^Paid \(cleared\) by Office alpha · /,
  ]);
  await expect(who).not.toContainText("@");
});

test("the Activity page reads as words: people by name or '—' (never 'Someone' or an e-mail), enums translated, no ids or op ids", async ({ page }) => {
  const runId = randomUUID();
  const opId = randomUUID();
  const stranger = randomUUID(); // someone with no usable name in this company
  const workshop = alpha().users.workshop;
  await withDb(async (db) => {
    const add = (actor: string, oldData: unknown, newData: unknown) => db.query(
      `insert into security_audit.audit_log (organization_id, actor_user_id, action, entity_table, entity_id, old_data, new_data, metadata, created_at)
       values ($1, $2, 'UPDATE', 'machine_runs', $3, $4, $5, '{"source": "database_trigger"}', now() + interval '1 hour')`,
      [alpha().id, actor, runId, oldData, newData]);
    await add(workshop.id, { id: runId, ended_at: null, end_reason: null, ended_by: null, ended_op_id: null },
      { id: runId, ended_at: "2026-10-09T10:00:00+00:00", end_reason: "paused", ended_by: workshop.id, ended_op_id: opId });
    await add(stranger, { id: runId, end_reason: "paused" }, { id: runId, end_reason: "finished" });
  });
  await signIn(page, alpha().users.admin);
  await page.goto("/admin/activity");
  const entries = page.getByRole("listitem").filter({ hasText: "Machine run" });
  // This test's two rows are dated an hour ahead, so each is the newest of its kind (other specs pause and finish real runs too).
  const ended = entries.filter({ hasText: "Machine run ended: Paused" }).first();
  await expect(ended).toBeVisible();
  await expect(ended).toContainText("Ended by Workshop alpha");
  await expect(ended.getByTestId("activity-actor")).toHaveText("Workshop alpha");
  const byStranger = entries.filter({ hasText: "Machine run ended: Finished" }).first();
  await expect(byStranger.getByTestId("activity-actor")).toHaveText("—");
  for (const entry of [ended, byStranger]) {
    for (const text of [opId, runId, workshop.id, stranger, "Someone", "Ended op id", "End reason", "empty", "@"]) await expect(entry).not.toContainText(text);
  }
  await expect(page.getByTestId("activity-actor").filter({ hasText: "Someone" })).toHaveCount(0);
  // The person filter names people, never by e-mail.
  await expect(page.getByRole("combobox", { name: "Person" })).not.toContainText("@");
});
