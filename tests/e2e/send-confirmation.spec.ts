/**
 * "Sent" means someone confirmed it went (audit B7a: D17). Preparing a quote e-mail (mail draft + PDF) leaves a draft
 * quote a draft until "I've sent it"; an RFQ clarification is logged only after the same confirmation.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { confirmSend, signIn, world } from "./helpers";

const w = world();

test("a quote stays a draft until sending is confirmed", async ({ page }) => {
  const customer = `Send Co ${w.runId}`;
  const ref = `QUO-SEND-${w.runId}`;
  const admin = adminClient();
  expect((await admin.from("customers").insert({ organization_id: w.tenants.beta.id, name: customer, email: `send.${w.runId}@example.test` })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.office);
  expect((await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "draft", description: "Send check" },
    p_child: "quote_line_items", p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Line", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  })).error).toBeNull();
  const status = async () => (await admin.from("quotes").select("status").eq("quote_ref", ref).single()).data?.status;

  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  const confirm = page.getByRole("dialog", { name: `Has ${ref} gone to the customer?` });

  // Asked first, naming the address it goes to; Cancel prepares nothing.
  await details.getByRole("button", { name: "Send to Customer" }).click();
  const ask = page.getByRole("dialog", { name: `Send ${ref} to send.${w.runId}@example.test?` });
  await expect(ask).toBeVisible();
  // No valid-until date on this draft: it gets 30 days from today (the company's default terms say 30 days, or none).
  await expect(ask).toContainText("so it will be valid until");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  await expect(confirm).toBeHidden();

  const download = page.waitForEvent("download");
  await details.getByRole("button", { name: "Send to Customer" }).click();
  expect(await confirmSend(page)).toBe(`Send ${ref} to send.${w.runId}@example.test?`);
  await download;
  await confirm.getByRole("button", { name: "Not yet" }).click();
  await expect(confirm).toBeHidden();
  expect(await status()).toBe("draft");
  // The default date was saved on the draft before its PDF was made (go-live polish 19c): issue date + 30 days.
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const validUntil = (await admin.from("quotes").select("valid_until").eq("quote_ref", ref).single()).data?.valid_until;
  expect([in30, new Date(Date.now() + 29 * 86_400_000).toISOString().slice(0, 10), new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)]).toContain(String(validUntil).slice(0, 10));

  await details.getByRole("button", { name: "Send to Customer" }).click();
  await confirmSend(page);
  await confirm.getByRole("button", { name: /sent it/ }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(status).toBe("sent");
});

test("an RFQ clarification is logged only after confirming it was sent", async ({ page }) => {
  const customer = `Clarify Co ${w.runId}`;
  const admin = adminClient();
  const { data: rfq, error } = await admin.from("rfqs")
    .insert({ organization_id: w.tenants.beta.id, customer, email: `rfq.${w.runId}@example.test`, description: "Bushes", status: "clarification" })
    .select("id").single();
  expect(error).toBeNull();
  const logged = async () => (await admin.from("email_history").select("status").eq("related_to_id", rfq!.id)).data?.map((r) => r.status);

  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/rfq");
  await page.locator('[data-slot="card"]', { hasText: customer }).getByRole("button", { name: "Clarify" }).click();
  const dialog = page.getByRole("dialog", { name: "Clarification Email" });
  await dialog.getByRole("button", { name: "Open in email app" }).click();
  expect(await logged()).toEqual([]);
  await dialog.getByRole("button", { name: /sent it/ }).click();
  await expect(dialog).toBeHidden();
  expect(await logged()).toEqual(["sent_manually"]);
});

test("first send and a decision on a draft use today's details; an issued quote keeps its snapshot (R4)", async ({ page }) => {
  const customer = `Fresh Co ${w.runId}`;
  const admin = adminClient();
  expect((await admin.from("customers").insert({ organization_id: w.tenants.beta.id, name: customer, address: "1 Old Street", email: `fresh.${w.runId}@example.test` })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.office);
  const make = async (ref: string, status: "draft" | "sent") => expect((await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status, valid_until: "2099-12-31", description: "Snapshot check" },
    p_child: "quote_line_items", p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Line", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  })).error).toBeNull();
  const toSend = `QUO-FS-${w.runId}`;
  const toAccept = `QUO-FA-${w.runId}`;
  const issued = `QUO-FI-${w.runId}`;
  await make(toSend, "draft");
  await make(toAccept, "draft");
  await make(issued, "sent");
  const row = async (ref: string) => (await admin.from("quotes").select("status, customer_snapshot, issuer_snapshot").eq("quote_ref", ref).single()).data!;
  expect((await row(toSend)).customer_snapshot).toMatchObject({ address: "1 Old Street" });
  const issuedBefore = await row(issued);

  // The customer moves after the drafts were saved.
  expect((await admin.from("customers").update({ address: "2 New Road" }).eq("organization_id", w.tenants.beta.id).eq("name", customer)).error).toBeNull();

  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  const open = async (ref: string) => {
    const card = page.locator('[data-slot="card"]', { hasText: ref });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "View" }).click();
    const dialog = page.getByRole("dialog", { name: `${ref} quote details` });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  let details = await open(toSend);
  const download = page.waitForEvent("download");
  await details.getByRole("button", { name: "Send to Customer" }).click();
  await confirmSend(page);
  await download;
  // Taken when the PDF was made, before "I've sent it".
  expect((await row(toSend)).customer_snapshot).toMatchObject({ address: "2 New Road" });
  const confirm = page.getByRole("dialog", { name: `Has ${toSend} gone to the customer?` });
  await confirm.getByRole("button", { name: /sent it/ }).click();
  // The row can read "sent" before the browser has the reply and closes this dialog; an Escape then would close it, not the details,
  // and the details dialog would stay modal over the next card (the R4 failure on main, 23 Oct 2026).
  await expect(confirm).toBeHidden();
  await expect.poll(async () => (await row(toSend)).status).toBe("sent");
  expect((await row(toSend)).customer_snapshot).toMatchObject({ address: "2 New Road" });
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  details = await open(toAccept);
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  await page.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect(page.getByRole("dialog", { name: `Mark ${toAccept} as accepted?` })).toBeHidden();
  await expect.poll(async () => (await row(toAccept)).status).toBe("accepted");
  expect((await row(toAccept)).customer_snapshot).toMatchObject({ address: "2 New Road" });
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // Already issued: accepting it later doesn't rewrite what the customer was sent.
  details = await open(issued);
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  await page.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect.poll(async () => (await row(issued)).status).toBe("accepted");
  const issuedAfter = await row(issued);
  expect(issuedAfter.customer_snapshot).toEqual(issuedBefore.customer_snapshot);
  expect(issuedAfter.issuer_snapshot).toEqual(issuedBefore.issuer_snapshot);
});

test("recording a quote as sent that changed no row is not reported as sent (R7)", async ({ page }) => {
  const customer = `Gone Co ${w.runId}`;
  const ref = `QUO-R7-${w.runId}`;
  const admin = adminClient();
  expect((await admin.from("customers").insert({ organization_id: w.tenants.beta.id, name: customer })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.office);
  expect((await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "draft", valid_until: "2099-12-31", description: "R7" },
    p_child: "quote_line_items", p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Line", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  })).error).toBeNull();

  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  const download = page.waitForEvent("download");
  await details.getByRole("button", { name: "Send to Customer" }).click();
  await confirmSend(page);
  await download;
  // Someone else deletes the draft before this person confirms it went: the update matches no row.
  expect((await office.from("quotes").delete().eq("quote_ref", ref).select("id")).data).toHaveLength(1);
  const confirm = page.getByRole("dialog", { name: `Has ${ref} gone to the customer?` });
  await confirm.getByRole("button", { name: /sent it/ }).click();
  await expect(page.getByText(`${ref} was changed elsewhere and wasn't recorded as sent.`)).toBeVisible();
  await expect(page.getByText(`${ref} recorded as sent`)).toHaveCount(0);
});
