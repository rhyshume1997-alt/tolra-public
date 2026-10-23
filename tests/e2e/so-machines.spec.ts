/**
 * Machines on sales-order lines, carried to the job (migration 043): the office sets machines and hours per line on a two-line order
 * (the same machine on both lines), converts it and sees the plan summed per machine on the Job Board, each machine booked on the
 * schedule at its next free slot (061); the workshop changes the hours on the job, which resizes that booking; the order then shows its
 * plan read-only, as ordered; the viewer reads the plan and has no Machines button.
 */
import { expect, test } from "@playwright/test";

import { type SyntheticWorld, adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

// The world exists only after global setup (CI's `test:e2e:list` collects with none), so run-specific values are set in beforeAll, never at import.
let w: SyntheticWorld;
let org = "";
let ref = "";
let quoteRef = "";
let millName = "";
let latheName = "";
let mill = "";
let lathe = "";
let orderId = "";
const LINES = [{ description: "Flange 80mm", quantity: 12, unit_price: 150, vat_pct: 20 }, { description: "Spacer", quantity: 4, unit_price: 2.5, vat_pct: 0 }];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  w = world();
  org = w.tenants.alpha.id;
  ref = `PO-SOM-E2E-${w.runId}`;
  quoteRef = `QUO-SOM-E2E-${w.runId}`;
  millName = `SOM Mill ${w.runId}`;
  latheName = `SOM Lathe ${w.runId}`;
  // Idempotent: a worker that restarts after a failure runs this again.
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  mill = await one("machines", "name", millName, { name: millName });
  lathe = await one("machines", "name", latheName, { name: latheName });
  const existing = (await admin.from("sales_orders").select("id").eq("organization_id", org).eq("so_number", ref).maybeSingle()).data;
  if (existing) { orderId = existing.id as string; return; }
  // A two-line quote whose net equals the order, so the order gets two lines of its own.
  const { data: quote } = await admin.from("quotes").insert({ organization_id: org, quote_ref: quoteRef, customer: "SOM E2E Co", status: "draft", total_value: 0 }).select("id").single();
  await admin.from("quote_line_items").insert(LINES.map((l, position) => ({ ...l, position, quote_id: quote!.id, organization_id: org })));
  const pence = (x: number) => Math.round(x * 100);
  const total = LINES.reduce((sum, l) => { const net = pence(l.quantity * l.unit_price); return sum + net + Math.round(net * l.vat_pct / 100); }, 0) / 100;
  await admin.from("quotes").update({ total_value: total, vat_enabled: true }).eq("id", quote!.id);
  await admin.from("quotes").update({ status: "accepted" }).eq("id", quote!.id);
  orderId = (await admin.from("sales_orders").insert({ organization_id: org, so_number: ref, customer_po: ref, customer: "SOM E2E Co", quote_id: quote!.id, quote_ref: quoteRef, total_value: 1810, status: "open", order_date: "2026-10-09" }).select("id").single()).data!.id as string;
});

test("the office sets machines per line, converts, and the job shows them summed per machine, each booked at its next free slot", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: `Machines for ${ref}` }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${ref}` });
  await expect(dialog.getByTestId("so-machines-line")).toHaveCount(2);
  await expect(dialog.getByTestId("so-machines-line").first()).toContainText("Flange 80mm");
  // Line 1: the mill for 4 hours and the lathe for 2; line 2: the mill again for 1.5.
  const line = (n: number) => dialog.getByTestId("so-machines-line").nth(n - 1);
  await line(1).getByRole("button", { name: "Add machine" }).click();
  await dialog.getByLabel("Line 1 machine 1", { exact: true }).selectOption({ label: millName });
  await dialog.getByLabel("Line 1 hours on machine 1").fill("4");
  await line(1).getByRole("button", { name: "Add machine" }).click();
  await dialog.getByLabel("Line 1 machine 2", { exact: true }).selectOption({ label: latheName });
  await dialog.getByLabel("Line 1 hours on machine 2").fill("2");
  await line(2).getByRole("button", { name: "Add machine" }).click();
  await dialog.getByLabel("Line 2 machine 1", { exact: true }).selectOption({ label: millName });
  await dialog.getByLabel("Line 2 hours on machine 1").fill("1.5");
  await expect(dialog.getByTestId("so-machines-summary")).toContainText(`${millName} 5.5 h, ${latheName} 2 h (7.5 h in all)`);
  await dialog.getByRole("button", { name: "Save machines" }).click();
  await expect(page.getByText(`Machines saved on ${ref}`)).toBeVisible();
  const { data: plan } = await adminClient().from("sales_order_line_machines").select("line_key, machine_id, estimated_hours").eq("sales_order_id", orderId).order("line_key").order("position");
  expect(plan!.map((r) => [r.line_key, r.machine_id, Number(r.estimated_hours)])).toEqual([[0, mill, 4], [0, lathe, 2], [1, mill, 1.5]]);

  // The View dialog shows the plan as the job will hold it.
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  await expect(page.getByTestId("so-machines-chips")).toContainText(`${millName} 5.5 h, ${latheName} 2 h`);
  await page.getByRole("dialog", { name: ref }).getByRole("button", { name: "Convert to Job" }).click();
  await page.waitForURL(/\/jobs\?job=/);
  await expect(page.getByText(/carried 2 machines \(7\.5 h\); booked on the schedule from /)).toBeVisible();

  const { data: job } = await adminClient().from("jobs").select("id, job_no").eq("converted_from_sales_order_id", orderId).single();
  const { data: links } = await adminClient().from("job_machines").select("machine_id, estimated_hours, booking_id, source_so_line_id").eq("job_id", job!.id).order("position");
  expect(links!.map((l) => [l.machine_id, Number(l.estimated_hours), Boolean(l.booking_id)])).toEqual([[mill, 5.5, true], [lathe, 2, true]]);
  expect(links!.every((l) => l.source_so_line_id)).toBe(true);
  await expect(page.locator(`tr[data-job-id="${job!.id}"]`).getByTestId("job-machines")).toHaveText(`${millName} 5.5 h (booked), ${latheName} 2 h (booked)`);
});

test("the workshop changes the hours on the job: the mill's booking takes them, never a second booking", async ({ page }) => {
  const { data: job } = await adminClient().from("jobs").select("id, job_no").eq("converted_from_sales_order_id", orderId).single();
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const row = page.locator(`tr[data-job-id="${job!.id}"]`);
  await row.getByRole("button", { name: "Machines" }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${job!.job_no}` });
  await expect(dialog.getByTestId("job-machine")).toHaveCount(2);
  await expect(dialog.getByLabel("Hours on machine 1")).toHaveValue("5.5");
  await expect(dialog.getByLabel("Book machine 1 on schedule")).toBeChecked();
  await expect(dialog.getByLabel("Start on machine 1")).not.toHaveValue("");
  const { data: was } = await adminClient().from("job_machines").select("booking_id").eq("job_id", job!.id).eq("machine_id", mill).single();
  await dialog.getByLabel("Hours on machine 1").fill("6");
  await dialog.getByRole("button", { name: "Save machines" }).click();
  await expect(page.getByText(`Machines saved on ${job!.job_no}`)).toBeVisible();
  const { data: links } = await adminClient().from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", job!.id).order("position");
  expect(links!.map((l) => [l.machine_id, Number(l.estimated_hours), Boolean(l.booking_id)])).toEqual([[mill, 6, true], [lathe, 2, true]]);
  expect(links![0].booking_id).toBe(was!.booking_id);
  expect((await adminClient().from("machine_bookings").select("id").eq("job_id", job!.id)).data).toHaveLength(2);
  const { data: booking } = await adminClient().from("machine_bookings").select("job_no, machine_id, estimated_hours, status").eq("id", links![0].booking_id!).single();
  expect(booking).toMatchObject({ job_no: job!.job_no, machine_id: mill, estimated_hours: 6, status: "booked" });
  await expect(row.getByTestId("job-machines")).toHaveText(`${millName} 6 h (booked), ${latheName} 2 h (booked)`);
});

test("after conversion the order's plan is read-only, as ordered", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/sales-orders");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click(); // converted orders move to Done
  await page.getByRole("button", { name: `Machines for ${ref}` }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${ref}` });
  await expect(dialog).toContainText("As ordered");
  await expect(dialog.getByLabel("Line 1 hours on machine 1")).toHaveValue("4");
  await expect(dialog.getByLabel("Line 1 hours on machine 1")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save machines" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add machine" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the viewer reads the job's machines and has no Machines button", async ({ page }) => {
  const { data: job } = await adminClient().from("jobs").select("id").eq("converted_from_sales_order_id", orderId).single();
  await signIn(page, w.tenants.alpha.users.viewer);
  await page.goto("/jobs");
  const row = page.locator(`tr[data-job-id="${job!.id}"]`);
  await expect(row.getByTestId("job-machines")).toContainText(`${millName} 6 h (booked)`);
  await expect(row.getByRole("button", { name: "Machines" })).toHaveCount(0);
});
