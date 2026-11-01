/** Year-end export: one zip with issued documents' PDFs for the period plus summary.csv; drafts and other years left out. */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("Settings > Year-end export downloads a zip with the period's invoice PDF and summary.csv", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const ref = `INV-YE-${w.runId.slice(0, 6)}`;
  const draft = `INV-YD-${w.runId.slice(0, 6)}`;
  const other = `INV-YO-${w.runId.slice(0, 6)}`;
  const ids = new Map<string, string>();
  for (const [number, status, date] of [[ref, "sent", "2025-06-10"], [draft, "draft", "2025-06-11"], [other, "sent", "2024-06-10"]] as const) {
    // Lines go on while it is a draft; issued invoices are locked (019, 027).
    const { data: invoice, error } = await admin.from("invoices").insert({ organization_id: org, invoice_ref: null, customer: "Year End Co", status: "draft", invoice_date: date, subtotal: 100, vat: 20, total: 120, vat_enabled: true, description: number }).select("id").single();
    expect(error).toBeNull();
    ids.set(number, invoice!.id);
    expect((await admin.from("invoice_line_items").insert({ organization_id: org, invoice_id: invoice!.id, position: 0, description: "Widgets", quantity: 1, unit_price: 100, vat_pct: 20 })).error).toBeNull();
    if (status !== "draft") expect((await admin.from("invoices").update({ invoice_ref: number, status }).eq("id", invoice!.id)).error).toBeNull();
  }
  // An issued credit note against it (40 of its 60 applied), and a draft that must not be exported.
  const creditRef = `CN-YE-${w.runId.slice(0, 6)}`;
  const credit = { organization_id: org, invoice_id: ids.get(ref), customer: "Year End Co", credit_date: "2025-07-01", subtotal: 50, vat: 10, total: 60, vat_enabled: true };
  const { data: issuedNote, error: creditError } = await admin.from("credit_notes").insert({ ...credit, status: "issued", credit_ref: creditRef, allocated_amount: 40, issued_at: "2025-07-01T09:00:00Z" }).select("id").single();
  expect(creditError).toBeNull();
  expect((await admin.from("invoice_credit_allocations").insert({ organization_id: org, invoice_id: ids.get(ref), credit_note_id: issuedNote!.id, amount: 40, allocated_on: "2025-07-02" })).error).toBeNull();
  expect((await admin.from("credit_notes").insert({ ...credit, status: "draft" })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/settings");
  await page.getByLabel("Export from").fill("2025-01-01");
  await page.getByLabel("Export to").fill("2025-12-31");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download year-end export" }).click()]);
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  expect(files["problems.txt"] ? strFromU8(files["problems.txt"]) : "").toBe("");
  expect(Object.keys(files)).toContain(`invoices/${ref}.pdf`);
  expect(strFromU8(files[`invoices/${ref}.pdf`].slice(0, 5))).toBe("%PDF-");
  const csv = strFromU8(files["summary.csv"]);
  expect(csv).toContain(`Invoice,${ref},2025-06-10,Year End Co,100.00,20.00,120.00`);
  expect(csv).not.toContain(other);
  expect(Object.keys(files).some((name) => name.includes("INV-YD"))).toBe(false);
  expect(Object.keys(files)).toContain("README.txt");
  // Credit notes issued in the period, with what has been applied; the draft is left out, and the invoice's Paid isn't touched.
  const credits = strFromU8(files["credits.csv"]).replace(/^\ufeff/, "").trimEnd().split("\r\n");
  expect(credits).toEqual([
    "Credit note,Invoice,Date,Customer,Net,VAT,Gross,Applied,Left to apply,Last applied",
    `${creditRef},${ref},2025-07-01,Year End Co,50.00,10.00,60.00,40.00,20.00,2025-07-02`,
  ]);
  expect(strFromU8(files["payments.csv"])).not.toContain(creditRef);
});
