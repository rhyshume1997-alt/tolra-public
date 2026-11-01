/**
 * Migration 110, RFQ clarification as one atomic call (public.log_rfq_clarification): an office user logs the clarification e-mail from
 * the RFQ page, the RFQ moves to Awaiting Clarification and exactly one e-mail history row exists. Workshop and viewer logins are
 * turned away from the page, and the call itself is refused for them with nothing logged and nothing moved.
 * Synthetic data only (alpha tenant); the world is read inside the tests, never at import.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

async function newRfq(label: string) {
  const w = world();
  const { data, error } = await adminClient().from("rfqs").insert({
    organization_id: w.tenants.alpha.id, customer: `${label} ${w.runId}`, email: `${label.toLowerCase().replace(/\W+/g, ".")}.${w.runId}@example.test`,
    description: `Spacers ${w.runId}`, status: "new",
  }).select("id, customer").single();
  expect(error).toBeNull();
  return data!;
}

test("RFQ clarification: office logs it from the page; one history row, the RFQ moves to Awaiting Clarification", async ({ page }) => {
  const w = world();
  const db = adminClient();
  const rfq = await newRfq("RFQ Clarify Atomic");
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/rfq");
  const card = () => page.locator('[data-slot="card"]', { hasText: rfq.customer });
  await card().getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Clarify" }).click();
  const dialog = page.getByRole("dialog", { name: "Clarification Email" });
  await dialog.getByRole("button", { name: "Open in email app" }).click();
  await dialog.getByRole("button", { name: /sent it/ }).click();
  await expect(page.getByText("Logged as sent manually. The RFQ is now awaiting clarification.")).toBeVisible();
  await expect(dialog).toBeHidden();

  expect((await db.from("rfqs").select("status").eq("id", rfq.id).single()).data!.status).toBe("clarification");
  const { data: history } = await db.from("email_history").select("status, related_to_type, to_name").eq("related_to_id", rfq.id);
  expect(history).toEqual([{ status: "sent_manually", related_to_type: "rfq", to_name: rfq.customer }]);

  // The page shows it under Awaiting Clarification after a reload.
  await page.reload();
  await page.getByRole("button", { name: "Clarification", exact: true }).click();
  await expect(card().getByRole("button", { name: "Clarify" })).toBeVisible();
});

for (const role of ["workshop", "viewer"] as const) {
  test(`RFQ clarification: ${role} has no RFQ page and the call is refused, nothing logged or moved`, async ({ page }) => {
    const w = world();
    const db = adminClient();
    const rfq = await newRfq(`RFQ Refused ${role}`);
    const user = w.tenants.alpha.users[role];

    await signIn(page, user);
    await page.goto("/rfq");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("button", { name: "Clarify" })).toHaveCount(0);

    // The same call made straight from that login (the browser's own client) is refused by the database.
    const client = await signedInClient(user);
    const { data, error } = await client.rpc("log_rfq_clarification", { p_rfq_id: rfq.id, p_subject: "Clarification needed", p_body: "Please confirm." });
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: "42501", hint: "rfq_not_allowed" });

    expect((await db.from("rfqs").select("status").eq("id", rfq.id).single()).data!.status).toBe("new");
    expect((await db.from("email_history").select("id").eq("related_to_id", rfq.id)).data).toHaveLength(0);
  });
}
