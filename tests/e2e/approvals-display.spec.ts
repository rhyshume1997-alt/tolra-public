/**
 * Approval Queue display preferences: hide one field from the Columns picker, it is gone, it is still gone after a reload, at
 * desktop (1280) and phone (390) widths, and the Mark as Sent Manually action still works with fields hidden.
 * Synthetic data only (alpha tenant). The queue is a card list, so there is no header row to count.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const org = () => w.tenants.alpha.id;
const tag = `APD${Date.now().toString(36)}`;
const subject = (n: number) => `${tag} draft ${n}`;
const card = (page: Page, n: number) => page.locator('[data-slot="card"]').filter({ hasText: subject(n) });

async function resetPreference() {
  const admin = adminClient();
  const { data } = await admin.from("organization_settings").select("hidden_columns").eq("organization_id", org()).maybeSingle();
  const hidden = { ...((data?.hidden_columns as Record<string, string[]> | null) ?? {}) };
  delete hidden.approvals;
  await admin.from("organization_settings").upsert({ organization_id: org(), hidden_columns: hidden }, { onConflict: "organization_id" });
}

test.beforeAll(async () => {
  const admin = adminClient();
  await resetPreference();
  const rows = [1, 2, 3].map((n) => ({ organization_id: org(), to_email: `apd${n}.${tag.toLowerCase()}@example.test`, to_name: `Display Co ${tag} ${n}`, subject: subject(n), body: `Body line ${n}`, status: "drafted", related_to_type: "general" }));
  expect((await admin.from("email_history").insert(rows)).error).toBeNull();
});

test.afterAll(async () => {
  await resetPreference();
  await adminClient().from("email_history").delete().eq("organization_id", org()).like("subject", `${tag}%`);
});

async function hideField(page: Page, label: string) {
  await page.getByRole("button", { name: "Columns" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: label });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
}

for (const [name, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
  test(`hiding Message preview is remembered after a reload (${name})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signIn(page, w.tenants.alpha.users.admin);
    await resetPreference();
    await page.goto("/approval");
    await expect(card(page, 1)).toBeVisible();
    await expect(card(page, 1).getByText("Body line 1")).toBeVisible();

    await hideField(page, "Message preview");
    await expect(card(page, 1)).toBeVisible();
    await expect(page.getByText("Body line 1")).toHaveCount(0);
    // Locked fields are listed ticked and disabled, and stay on the card with the actions.
    await page.getByRole("button", { name: "Columns" }).click();
    for (const locked of ["Recipient", "Subject line", "To address"]) {
      const item = page.getByRole("menuitemcheckbox", { name: locked });
      await expect(item).toHaveAttribute("aria-checked", "true");
      await expect(item).toHaveAttribute("aria-disabled", "true");
    }
    await page.keyboard.press("Escape");
    await expect(card(page, 1).getByText(`Display Co ${tag} 1`)).toBeVisible();
    await expect(card(page, 1).getByText(subject(1)).first()).toBeVisible();
    await expect(card(page, 1).getByRole("button", { name: "Mark as Sent Manually" })).toBeVisible();

    await page.reload();
    await expect(card(page, 1)).toBeVisible();
    await expect(page.getByText("Body line 1")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await resetPreference();
  });
}

test("Mark as Sent Manually still works with fields hidden", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await resetPreference();
  await page.goto("/approval");
  await expect(card(page, 2)).toBeVisible();
  await hideField(page, "Subject");
  await hideField(page, "Drafted date");
  await expect(card(page, 2)).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await card(page, 2).getByRole("button", { name: "Mark as Sent Manually" }).click();
  await expect(card(page, 2)).toHaveCount(0);
  const { data } = await adminClient().from("email_history").select("status").eq("organization_id", org()).eq("subject", subject(2));
  expect(data?.[0]?.status).toBe("sent_manually");
});
