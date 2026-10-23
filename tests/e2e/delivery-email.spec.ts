/**
 * Delivery note e-mail in the browser (audit B7a: A6, D17). Copying the text isn't a send; "Mark as Sent" asks for a
 * confirmation and then records history and the note together; workshop staff aren't offered the e-mail controls.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function note(ref: string, customer: string) {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  await admin.from("customers").insert({ organization_id: org, name: customer, email: `dn.${w.runId}@example.test` });
  const { data, error } = await admin.from("delivery_notes").insert({ organization_id: org, dn_number: ref, customer, status: "pending" }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

async function recorded(id: string) {
  const admin = adminClient();
  const { data: row } = await admin.from("delivery_notes").select("emailed_at").eq("id", id).single();
  const { data: history } = await admin.from("email_history").select("status").eq("related_to_id", id).order("drafted_at");
  return { emailed: Boolean(row?.emailed_at), history: (history ?? []).map((h) => h.status) };
}

test("copy isn't a send; mark as sent needs confirming and records both", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const ref = `DN-E-${w.runId}`;
  const id = await note(ref, `Despatch Co ${w.runId}`);
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/delivery-notes");
  const row = page.getByRole("row").filter({ hasText: ref });
  await row.getByRole("button", { name: "Email Customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Email delivery note" });

  await dialog.getByRole("button", { name: "Copy Email Body" }).click();
  await expect.poll(() => recorded(id)).toEqual({ emailed: false, history: ["copied"] });

  await dialog.getByRole("button", { name: "Mark as Sent" }).click();
  const confirm = dialog.getByRole("group", { name: "Confirm sent" });
  await confirm.getByRole("button", { name: "Not yet" }).click();
  expect(await recorded(id)).toEqual({ emailed: false, history: ["copied"] });

  await dialog.getByRole("button", { name: "Mark as Sent" }).click();
  await confirm.getByRole("button", { name: /sent it/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => recorded(id)).toEqual({ emailed: true, history: ["copied", "sent_manually"] });
  await expect(row).toContainText("Emailed");
});

test("workshop staff can work delivery notes but aren't offered e-mail", async ({ page }) => {
  const ref = `DN-W-${w.runId}`;
  await note(ref, `Workshop Co ${w.runId}`);
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/delivery-notes");
  const row = page.getByRole("row").filter({ hasText: ref });
  await expect(row.getByRole("button", { name: "Mark Signed" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Email Customer" })).toHaveCount(0);
});
