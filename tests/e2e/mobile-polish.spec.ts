/**
 * Mobile polish: the inspection "Attach files" control is a real button (>= 44px on touch), stacked-record captions are
 * bold, and User management fits phone and tablet widths with every action reachable.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { VIEWPORTS, deviceContext } from "../support/ui-pr1-screenshots";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);
const baseURL = () => String(test.info().project.use.baseURL);
const [PHONE, TABLET] = VIEWPORTS;

const noSidewaysScroll = async (page: Page, where: string) => {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, `${where}: scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth + 1);
};

test("Job Board card: bold captions; inspection dialog has an Attach files button of at least 44px", async ({ browser }) => {
  const no = `J-MP-${tag()}`;
  const { error } = await adminClient().from("jobs").insert({
    organization_id: w.tenants.alpha.id, job_no: no, customer: "Polish Co", description: "Bush", stage: "inspection",
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  });
  expect(error).toBeNull();
  const context = await deviceContext(browser, PHONE, baseURL());
  const page = await context.newPage();
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  const card = page.locator(`[data-testid="job-card"][data-job-no="${no}"]`);
  await expect(card).toBeVisible();
  for (const caption of ["Customer", "Description", "Machine"]) {
    const style = await card.locator("dt", { hasText: new RegExp(`^${caption}$`) }).evaluate((el) => { const s = getComputedStyle(el); return { weight: Number(s.fontWeight), border: parseFloat(s.borderTopWidth) + parseFloat(s.borderLeftWidth), radius: parseFloat(s.borderTopLeftRadius) }; });
    expect(style.weight, `${caption} caption weight`).toBeGreaterThanOrEqual(700);
    // Boxed, not just underlined (Rhys, 15 Oct): a border on every side and rounded corners.
    expect(style.border, `${caption} caption box`).toBeGreaterThanOrEqual(2);
    expect(style.radius, `${caption} caption corners`).toBeGreaterThan(0);
  }
  await card.getByRole("button", { name: "Inspected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  const attach = dialog.getByRole("button", { name: "Attach files" });
  await attach.scrollIntoViewIfNeeded();
  await expect(attach).toBeVisible();
  const box = await attach.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(43.5);
  // Choosing a file still fills the (visually hidden) input and shows its name.
  await dialog.locator('input[name="inspection_file"]').setInputFiles({ name: "proof.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await expect(dialog.getByText("proof.pdf")).toBeVisible();
  await context.close();
  await adminClient().from("jobs").delete().eq("organization_id", w.tenants.alpha.id).eq("job_no", no);
});

for (const viewport of [PHONE, TABLET]) {
  test(`User management: no sideways scroll at ${viewport.width}px, bold captions, every user's actions visible`, async ({ browser }) => {
    const context = await deviceContext(browser, viewport, baseURL());
    const page = await context.newPage();
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/admin/users");
    const rows = page.getByTestId("user-row");
    await expect(rows.first()).toBeVisible();
    await noSidewaysScroll(page, `/admin/users @${viewport.width}`);
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      await row.scrollIntoViewIfNeeded();
      const edit = row.getByRole("button", { name: /^(Edit|Revoke support access)$/ });
      await expect(edit).toBeVisible();
      const box = await edit.boundingBox();
      expect(box!.x + box!.width, `row ${i} action inside the viewport`).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box!.x).toBeGreaterThanOrEqual(0);
    }
    const caption = await rows.first().locator("td[data-label]").first().evaluate((el) => { const s = getComputedStyle(el, "::before"); return { content: s.content, weight: Number(s.fontWeight), border: parseFloat(s.borderLeftWidth) }; });
    expect(caption.content).toContain("Name");
    expect(caption.weight).toBeGreaterThanOrEqual(700);
    expect(caption.border).toBeGreaterThanOrEqual(1);
    await context.close();
  });
}

// Non-boxed captions (Rhys, 15 Oct: "doesn't necessarily need to be boxed in like the cards, just a bold header"): the
// shared stat tile renders .field-label at every width, so one page covers the dashboard tiles; no box is expected.
for (const viewport of VIEWPORTS) {
  test(`Dashboard stat tile labels are bold headers at ${viewport.width}px`, async ({ browser }) => {
    const context = await deviceContext(browser, viewport, baseURL());
    const page = await context.newPage();
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/dashboard");
    const label = page.locator("p.field-label").first();
    await expect(label).toBeVisible();
    const style = await label.evaluate((el) => { const s = getComputedStyle(el); return { weight: Number(s.fontWeight) }; });
    expect(style.weight, "stat tile label weight").toBeGreaterThanOrEqual(700);
    await context.close();
  });
}
