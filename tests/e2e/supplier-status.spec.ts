/**
 * ISO 9001 PR B (migration 082) in the browser: a supplier's status shows with its colour and word; only an admin is offered the
 * status control; a supplier on a purchase order can't be deleted or renamed (said plainly, the row stays as it was); a purchase
 * order is raised when its draft is issued, so the Issue dialog warns on a conditional supplier and won't issue to a blocked one.
 * Rows are made with the service role (exempt from 082's browser-session rules) and removed afterwards.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

function rows() {
  const w = world();
  const tag = `${w.runId.slice(0, 6)}`;
  const names = { used: `PRB Used Steel ${tag}`, conditional: `PRB Conditional Bar ${tag}`, blocked: `PRB Blocked Tube ${tag}` };
  const refs = { conditional: `PO-PRBC-${tag}`, blocked: `PO-PRBB-${tag}`, used: `PO-PRBU-${tag}` };
  return { w, org: w.tenants.alpha.id, names, refs };
}

async function seed() {
  const { org, names, refs } = rows();
  const service = adminClient();
  for (const [status, name] of [["approved", names.used], ["conditional", names.conditional], ["blocked", names.blocked]] as const) {
    expect((await service.from("suppliers").insert({ organization_id: org, name, supplier_status: status })).error).toBeNull();
  }
  // Drafts (a draft to a blocked supplier can be made; issuing it is what is refused).
  for (const [key, supplier] of [["used", names.used], ["conditional", names.conditional], ["blocked", names.blocked]] as const) {
    const ref = refs[key];
    expect((await service.from("purchase_orders").insert({ organization_id: org, po_ref: ref, po_number: ref, supplier, total_value: 10, status: "draft" })).error).toBeNull();
  }
}

async function clean() {
  const { org, names, refs } = rows();
  const service = adminClient();
  await service.from("purchase_orders").delete().eq("organization_id", org).in("po_ref", Object.values(refs));
  await service.from("suppliers").delete().eq("organization_id", org).in("name", Object.values(names));
}

const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test.describe.serial("supplier status (082)", () => {
  test.beforeAll(seed);
  test.afterAll(clean);

  test("office: badges, no status control, a used supplier is kept and keeps its name, the Issue dialog warns and stops", async ({ page }) => {
    const { w, names, refs } = rows();
    await signIn(page, w.tenants.alpha.users.office);
    await page.goto("/suppliers");
    await expect(row(page, names.blocked).getByTestId("supplier-status")).toHaveText("Blocked");
    await expect(row(page, names.blocked).getByTestId("supplier-status")).toHaveAttribute("data-colour", "red");
    await expect(row(page, names.conditional).getByTestId("supplier-status")).toHaveAttribute("data-colour", "yellow");
    await expect(row(page, names.used).getByTestId("supplier-status")).toHaveText("Approved");

    // Only an admin changes a status: the office sees it read only.
    await row(page, names.used).getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit supplier" });
    await expect(edit.getByRole("combobox", { name: "Status" })).toHaveCount(0);
    await expect(edit.getByTestId("supplier-status-read-only")).toContainText("Only an admin changes it.");
    // 7.5.3: renaming a supplier that a purchase order names is refused, in words.
    await edit.getByPlaceholder("Supplier name").fill(`${names.used} Group`);
    await edit.getByRole("button", { name: "Save Supplier" }).click();
    await expect(page.getByText(`${names.used} is on 1 purchase order and can't be renamed`)).toBeVisible();
    await page.keyboard.press("Escape");

    // 7.5.3: deleting it is refused, in words, and it stays listed under its name.
    page.once("dialog", (dialog) => void dialog.accept());
    await row(page, names.used).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(`${names.used} is on 1 purchase order and can't be deleted`)).toBeVisible();
    await page.reload();
    await expect(row(page, names.used)).toHaveCount(1);

    // 8.4: raised at issue. Conditional warns (and can be issued); blocked is stopped.
    await page.goto("/purchase-orders");
    await row(page, refs.conditional).getByRole("button", { name: "Issue", exact: true }).click();
    const issueConditional = page.getByRole("dialog", { name: `Issue ${refs.conditional}?` });
    await expect(issueConditional.getByTestId("supplier-order-notice")).toHaveText("Conditional supplier: check this order before you issue it.");
    await expect(issueConditional.getByRole("button", { name: "Issue Purchase Order" })).toBeEnabled();
    await issueConditional.getByRole("button", { name: "Cancel" }).click();

    await row(page, refs.blocked).getByRole("button", { name: "Issue", exact: true }).click();
    const issueBlocked = page.getByRole("dialog", { name: `Issue ${refs.blocked}?` });
    await expect(issueBlocked.getByTestId("supplier-order-notice")).toHaveText("Blocked supplier: this order can't be issued until an admin changes its status on the Suppliers page.");
    await expect(issueBlocked.getByRole("button", { name: "Issue Purchase Order" })).toBeDisabled();
    await issueBlocked.getByRole("button", { name: "Cancel" }).click();
    expect((await adminClient().from("purchase_orders").select("status").eq("po_ref", refs.blocked).single()).data?.status).toBe("draft");
  });

  test("admin: the status control is offered and a change saves", async ({ page }) => {
    const { w, names } = rows();
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/suppliers");
    await row(page, names.conditional).getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit supplier" });
    await edit.getByRole("combobox", { name: "Status" }).selectOption("approved");
    await edit.getByRole("button", { name: "Save Supplier" }).click();
    await expect(row(page, names.conditional).getByTestId("supplier-status")).toHaveText("Approved");
  });
});
