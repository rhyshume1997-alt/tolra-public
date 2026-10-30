/**
 * Admin > Integrations > "Send a date range to Xero" (E3: components/integrations/xero-batch-card.tsx, app/api/integrations/xero/batch and
 * summary) and the accountant's summary export.
 *
 * Nothing here talks to Xero and nothing is sent: the suite has no Xero (no network, no mock server), so every test stops at the Preview
 * and at the summary download. The "Send" button is only looked at, never clicked. A connection is faked with one service-role row in
 * integration_connections (status "connected", connected_at ten days ago, a made-up tenant id and no secret), and the invoices are inserted
 * straight into the table as already issued (status "sent"): 084's issue trigger fires on a status UPDATE only, so they have no send row, which
 * is what the summary calls "Not sent". The server is started with placeholder Xero settings (playwright.config.ts) so the batch route does
 * not answer 503 "not set up"; they are never used to call Xero.
 *
 * It runs in its own company (an admin from createSoloTenant plus an office user added here) so the counts are exactly this spec's three
 * invoices and no other spec's invoices can fall in the range.
 *
 * Not covered here, on purpose: a SUPPORT session getting 403 from the batch and summary routes. The suite has no way to start a support
 * session (no spec does), so that refusal is proved by tests/unit/xero-batch-routes.test.ts ("a support session ... gets 403").
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { type APIResponse, type Page, expect, test } from "@playwright/test";

import { type SyntheticUser, adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

// The documented columns of the summary (SUMMARY_COLUMNS in lib/integrations/xero/batch.ts), in order.
const SUMMARY_HEADER = ["Document number", "Type", "Action", "Customer", "Issued date", "Net", "VAT", "Total", "Xero number", "Xero id", "Sent at", "Status", "Error"];

const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
// Noon UTC on that London date: the same London day in GMT and BST (as attention.spec.ts), so connectedOn is exactly london(-10).
const noon = (offsetDays: number) => new Date(`${london(offsetDays)}T12:00:00Z`).toISOString();

let org = "";
let admin: SyntheticUser;
let office: SyntheticUser;
let refs = { before: "", a: "", b: "" };

test.beforeAll(async () => {
  const w = world();
  const tag = w.runId.slice(0, 6);
  const db = adminClient();
  const solo = await createSoloTenant(w.runId, "xbatch");
  org = solo.id;
  admin = solo.admin;

  const email = `office.xbatch.${w.runId}@example.test`;
  const password = `${randomBytes(12).toString("base64url")}aA1!`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Office xbatch" } });
  if (created.error || !created.data.user) throw new Error(`createUser ${email}: ${created.error?.message}`);
  const added = await db.rpc("add_member", { p_org: org, p_email: email, p_role: "office" });
  expect(added.error).toBeNull();
  expect(added.data).toBe("member");
  office = { id: created.data.user.id, email, password, role: "office" };

  // One invoice dated before the connection day (-12) and two after it (-6, -1). Issued, so each is in range for the batch and the summary.
  refs = { before: `XB-${tag}-BEFORE`, a: `XB-${tag}-A`, b: `XB-${tag}-B` };
  const row = (invoice_ref: string, invoice_date: string) => ({
    organization_id: org, invoice_ref, customer: `Xero Batch Co ${tag}`, status: "sent", invoice_date, subtotal: 100, vat: 20, total: 120, vat_enabled: true, due_date: "2099-01-31",
  });
  const inserted = await db.from("invoices").insert([row(refs.before, london(-12)), row(refs.a, london(-6)), row(refs.b, london(-1))]);
  expect(inserted.error).toBeNull();
});

const card = (page: Page) => page.getByTestId("xero-batch-card");
const previewButton = (page: Page) => card(page).getByRole("button", { name: "Preview", exact: true });

/** The summary CSV as a header and its data rows (these cells hold no comma or quote, so a plain split is exact). Leading BOM removed. */
function parseSummary(csv: string) {
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter((l) => l !== "");
  return { header: lines[0].split(","), rows: lines.slice(1).map((l) => l.split(",")) };
}

function expectSummary(csv: string) {
  const { header, rows } = parseSummary(csv);
  expect(header).toEqual(SUMMARY_HEADER);
  // Only this company's three invoices, oldest first, none sent: "Not sent", no Xero number or id, no send time, no error.
  expect(rows.map((r) => r[0])).toEqual([refs.before, refs.a, refs.b]);
  rows.forEach((r, i) => {
    expect(r).toHaveLength(SUMMARY_HEADER.length);
    expect(r.slice(1, 3)).toEqual(["Invoice", "Create"]);
    expect(r[4]).toBe([london(-12), london(-6), london(-1)][i]);
    expect(r.slice(5, 8)).toEqual(["100.00", "20.00", "120.00"]);
    expect(r.slice(8, 11)).toEqual(["", "", ""]);
    expect(r[11]).toBe("Not sent");
    expect(r[12]).toBe("");
  });
}

const summaryPath = () => `/api/integrations/xero/summary?${new URLSearchParams({ from: london(-14), to: london(0), format: "csv" })}`;

test("admin with no Xero connection: the card explains and nothing can be sent", async ({ page }) => {
  await signIn(page, admin);
  await page.goto("/admin/integrations");
  await expect(card(page)).toBeVisible();
  // No connection, so no "include documents issued before" box: there is no connection day to be before.
  await expect(page.getByTestId("batch-include-before")).toHaveCount(0);
  await previewButton(page).click();
  const preview = page.getByTestId("batch-preview");
  await expect(preview).toContainText("Connect this company to Xero first. Nothing can be sent until then.");
  await expect(page.getByTestId("batch-send")).toBeDisabled();
});

test("with Xero connected ten days ago: Preview from the connection day shows the 2 later invoices; an earlier From needs the tick box", async ({ page }) => {
  const db = adminClient();
  const connectedOn = london(-10);
  const connection = await db.from("integration_connections").insert({
    organization_id: org, provider: "xero", status: "connected", tenant_id: `e2e-xbatch-${world().runId}`, tenant_name: "E2E Xero (fake)", connected_at: noon(-10),
  });
  expect(connection.error).toBeNull();
  try {
    await signIn(page, admin);
    await page.goto("/admin/integrations");
    await expect(card(page)).toBeVisible();

    // The default From is the day Xero was connected, and the tick box names that day.
    await expect(page.getByTestId("batch-include-before")).toContainText(connectedOn);
    await expect(page.getByTestId("batch-from")).toHaveValue(connectedOn);
    await expect(page.getByTestId("batch-before-warning")).toHaveCount(0);

    await previewButton(page).click();
    const preview = page.getByTestId("batch-preview");
    await expect(preview).toContainText("2 documents would be sent.");
    const rows = preview.getByTestId("batch-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`Invoice ${refs.a}`);
    await expect(rows.nth(1)).toContainText(`Invoice ${refs.b}`);
    await expect(preview).not.toContainText(refs.before);
    // Connected, so Send is offered for the two (it is looked at, never clicked: nothing goes to Xero from this suite).
    await expect(page.getByTestId("batch-send")).toBeEnabled();
    await expect(page.getByTestId("batch-send")).toHaveText("Send 2");

    // An earlier From, without the tick: a warning, and Preview is switched off.
    await page.getByTestId("batch-from").fill(london(-14));
    await expect(page.getByTestId("batch-before-warning")).toContainText(`before Xero was connected`);
    await expect(page.getByTestId("batch-before-warning")).toContainText(connectedOn);
    await expect(previewButton(page)).toBeDisabled();

    // With the tick, the warning goes and the earlier invoice is listed too.
    await page.getByTestId("batch-include-before").getByRole("checkbox").check();
    await expect(page.getByTestId("batch-before-warning")).toHaveCount(0);
    await expect(previewButton(page)).toBeEnabled();
    await previewButton(page).click();
    await expect(preview).toContainText("3 documents would be sent.");
    await expect(preview.getByTestId("batch-row")).toHaveCount(3);
    await expect(preview.getByTestId("batch-row").nth(0)).toContainText(`Invoice ${refs.before}`);
    await expect(page.getByTestId("batch-send")).toHaveText("Send 3");
  } finally {
    await db.from("integration_connections").delete().eq("organization_id", org).eq("provider", "xero");
  }
});

test("summary export: the card's CSV link downloads for the admin, the API answers the office, workshop and viewer are refused", async ({ page, browser }) => {
  await signIn(page, admin);
  await page.goto("/admin/integrations");
  await expect(card(page)).toBeVisible();
  // Set the range explicitly: without a connection the default From is 1 January, which this run's earlier invoice may precede.
  await page.getByTestId("batch-from").fill(london(-14));
  await page.getByTestId("batch-to").fill(london(0));
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("batch-summary-csv").click()]);
  expect(download.suggestedFilename()).toMatch(/^Xero-summary-.+-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  expectSummary(readFileSync(await download.path(), "utf8"));

  // Same file by the API, as admin and as office (the summary holds totals, not a token, so the office may read it).
  for (const user of [admin, office]) {
    const context = await browser.newContext();
    const who = await context.newPage();
    await signIn(who, user);
    const res: APIResponse = await who.request.get(summaryPath());
    expect(res.status(), `${user.role} summary`).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="Xero-summary-.+\.csv"$/);
    expectSummary(await res.text());
    await context.close();
  }

  // Workshop and viewer (any company: the role check comes first) are refused, and so is a bad range.
  const w = world();
  for (const user of [w.tenants.alpha.users.workshop, w.tenants.alpha.users.viewer]) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await signIn(other, user);
    expect((await other.request.get(summaryPath())).status(), `${user.role} summary`).toBe(403);
    await context.close();
  }
  expect((await page.request.get("/api/integrations/xero/summary?from=2026-02-30&to=2026-03-01")).status()).toBe(400);
});

test("workshop never sees the card: the page sends them to the dashboard and the batch route refuses them", async ({ page }) => {
  const w = world();
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/admin/integrations");
  // The middleware sends a non-admin away from /admin before the page renders (as integrations-send-log.spec.ts checks for the office).
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId("xero-batch-card")).toHaveCount(0);
  const base = new URL(page.url()).origin;
  const res = await page.request.post("/api/integrations/xero/batch", { headers: { origin: base }, data: { action: "info" } });
  expect(res.status()).toBe(403);
});
