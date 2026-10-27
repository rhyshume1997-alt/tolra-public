/**
 * Sending after the customer's decision: an accepted quote can be sent again, a rejected one cannot (the page offers no Send, and
 * refuses when the row was rejected elsewhere since the list loaded). There is no Reopen for a rejected quote (migration 020: final).
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { confirmSend, signIn, world } from "./helpers";

const w = world();

/** The SEND rows kept for a quote: { refused } for the ones marked refused, { sent } for the rest. */
const sendAudits = async (ref: string) => {
  const rows = (await withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'quotes' and entity_id = $1 and action = 'SEND'", [ref]))).rows as Array<{ metadata: Record<string, unknown> | null }>;
  const refused = rows.filter((r) => r.metadata?.outcome === "refused").length;
  return { refused, sent: rows.length - refused };
};

async function seed(ref: string, customer: string, status: "sent" | "accepted" | "rejected") {
  const admin = adminClient();
  expect((await admin.from("customers").insert({ organization_id: w.tenants.beta.id, name: customer, email: `${ref.toLowerCase()}@example.test` })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.office);
  expect((await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "draft", description: "Decided send check" },
    p_child: "quote_line_items", p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Line", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  })).error).toBeNull();
  const stamp = status === "sent" ? { sent_at: new Date().toISOString() } : status === "accepted" ? { accepted_at: new Date().toISOString() } : { rejected_at: new Date().toISOString() };
  expect((await admin.from("quotes").update({ status, ...stamp }).eq("quote_ref", ref)).error).toBeNull();
  return admin;
}

test("an accepted quote offers Send and the send works", async ({ page }) => {
  const ref = `QUO-ACC-${w.runId}`;
  await seed(ref, `Accepted Co ${w.runId}`, "accepted");
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await page.getByRole("button", { name: /^Done \(/ }).click();
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "Resend" }).click();
  const download = page.waitForEvent("download");
  await confirmSend(page);
  await download;
  const confirm = page.getByRole("dialog", { name: `Has ${ref} gone to the customer?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /sent it/ }).click();
  await expect(confirm).toBeHidden();
  // The successful send is in the audit log; nothing was refused.
  await expect.poll(() => sendAudits(ref)).toEqual({ refused: 0, sent: 1 });
});

test("a rejected quote offers no Send anywhere", async ({ page }) => {
  const ref = `QUO-REJ-${w.runId}`;
  await seed(ref, `Rejected Co ${w.runId}`, "rejected");
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await page.getByRole("button", { name: /^Done \(/ }).click();
  const card = page.locator('[data-slot="card"]', { hasText: ref });
  await expect(card.getByRole("button", { name: "View" })).toBeVisible();
  await expect(card.getByRole("button", { name: /^(Send|Resend)$/ })).toHaveCount(0);
  await card.getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  await expect(details).toBeVisible();
  await expect(details.getByRole("button", { name: "Send to Customer" })).toHaveCount(0);
});

test("a quote rejected elsewhere since the list loaded is refused when sending", async ({ page }) => {
  const ref = `QUO-STALE-${w.runId}`;
  const admin = await seed(ref, `Stale Co ${w.runId}`, "sent");
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "Resend" }).click();
  const ask = page.getByRole("dialog", { name: /^Send .+\?$/ });
  await expect(ask).toBeVisible();
  // The customer's no is entered by someone else while the question is open.
  expect((await admin.from("quotes").update({ status: "rejected", rejected_at: new Date().toISOString() }).eq("quote_ref", ref)).error).toBeNull();
  await ask.getByRole("button", { name: "Yes, send" }).click();
  await expect(page.getByText(`${ref} was rejected by the customer, so it can't be sent again.`)).toBeVisible();
  await expect(page.getByRole("dialog", { name: `Has ${ref} gone to the customer?` })).toHaveCount(0);
  // The refused attempt is in the audit log, and no send is.
  await expect.poll(() => sendAudits(ref)).toEqual({ refused: 1, sent: 0 });
  expect((await admin.from("quotes").select("status").eq("quote_ref", ref).single()).data?.status).toBe("rejected");
});
