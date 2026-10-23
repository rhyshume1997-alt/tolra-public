/**
 * Measured interface and print fixes (audit B7b: D19, D20, D29, D30; D24 checked). Printing shows the document only;
 * long dialogs scroll on a phone; viewers can read but not edit a worksheet; example machines are only added when
 * chosen; the invoice page doesn't overflow narrow screens.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("print routes print the document only (sales order, purchase order, delivery note, worksheet)", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const tag = w.runId;
  const ids = {
    so: (await admin.from("sales_orders").insert({ organization_id: org, so_number: `SO-P-${tag}`, customer: "Print Co" }).select("id").single()).data!.id,
    po: (await admin.from("purchase_orders").insert({ organization_id: org, po_ref: `PO-P-${tag}`, po_number: `PO-P-${tag}`, supplier: "Print Supplies" }).select("id").single()).data!.id,
    dn: (await admin.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-P-${tag}`, customer: "Print Co", status: "pending" }).select("id").single()).data!.id,
    job: (await admin.from("jobs").insert({ organization_id: org, job_no: `J-P-${tag}`, customer: "Print Co" }).select("id").single()).data!.id,
  };
  await signIn(page, w.tenants.alpha.users.admin);
  for (const [route, id, ref] of [["sales-orders", ids.so, `SO-P-${tag}`], ["purchase-orders", ids.po, `PO-P-${tag}`], ["delivery-notes", ids.dn, `DLN-P-${tag}`], ["jobs", ids.job, `J-P-${tag}`]] as const) {
    await page.emulateMedia({ media: "screen" });
    await page.goto(`/${route}/${id}/print`);
    await expect(page.getByText(ref).first()).toBeVisible();
    const topbar = page.locator("header.sticky");
    await expect(topbar).toBeVisible(); // screen navigation unchanged
    await page.emulateMedia({ media: "print" });
    await expect(page.getByText(ref).first(), route).toBeVisible();
    await expect(page.locator("aside"), route).toBeHidden();
    await expect(topbar, route).toBeHidden();
    const padding = await page.locator("main").first().evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(padding, route).toBe("0px");
    const pdf = await page.pdf({ format: "A4" });
    expect(pdf.byteLength, route).toBeGreaterThan(1000);
  }
});

test("long dialogs fit phone screens (portrait and landscape): the last control is reachable", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const customer = `Phone Co ${w.runId}`;
  await admin.from("customers").insert({ organization_id: org, name: customer, email: `phone.${w.runId}@example.test` });
  await admin.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-M-${w.runId}`, customer, status: "pending" });
  await signIn(page, w.tenants.alpha.users.office);
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024]]) {
    await page.setViewportSize({ width, height });
    await page.goto("/delivery-notes");
    await page.getByRole("row").filter({ hasText: `DLN-M-${w.runId}` }).getByRole("button", { name: "Email Customer" }).click();
    const dialog = page.getByRole("dialog", { name: "Email delivery note" });
    const box = await dialog.boundingBox();
    expect(box!.y, `${width}x${height}`).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, `${width}x${height}`).toBeLessThanOrEqual(height);
    const last = dialog.getByRole("button", { name: "Mark as Sent" });
    await last.scrollIntoViewIfNeeded();
    await last.click({ trial: true }); // fails if the button can't be brought on screen
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("viewer: worksheet is read only and the drawings section is still there (workshop editing: worksheet.spec)", async ({ page }) => {
  const jobNo = `J-V-${w.runId}`;
  await adminClient().from("jobs").insert({ organization_id: w.tenants.alpha.id, job_no: jobNo, customer: "Viewer Co", drawing_no: "DWG-1" });
  await signIn(page, w.tenants.alpha.users.viewer);
  await page.goto("/jobs");
  await page.getByRole("row").filter({ hasText: jobNo }).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  const drawing = sheet.getByLabel("Drawing #");
  await expect(drawing).toHaveValue("DWG-1");
  await expect(drawing).not.toBeEditable();
  for (const box of await sheet.getByRole("checkbox").all()) await expect(box).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Sign off now" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Save Worksheet" })).toHaveCount(0);
  await expect(sheet.getByText("Drawings", { exact: true })).toBeVisible();
});

test("example machines are a template: nothing is added until chosen", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.beta.id;
  const otherCount = async () => (await admin.from("machines").select("id").eq("organization_id", w.tenants.alpha.id)).data?.length ?? 0;
  const otherBefore = await otherCount();
  await admin.from("machines").delete().eq("organization_id", org);
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "choose from an example list" }).click();
  const dialog = page.getByRole("dialog", { name: "Example machine list" });
  await expect(dialog.getByRole("button", { name: /Add .*selected/ })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await admin.from("machines").select("id").eq("organization_id", org)).data).toEqual([]);

  await page.getByRole("button", { name: "choose from an example list" }).click();
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByRole("button", { name: /Add 1 selected/ }).click();
  await expect.poll(async () => (await admin.from("machines").select("id").eq("organization_id", org)).data?.length).toBe(1);
  expect(await otherCount()).toBe(otherBefore); // the other company's machines are untouched
});

test("touch screens (coarse pointer): every button is at least 44px high, and nothing scrolls sideways at tablet width", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 820, height: 1000 } });
  const page = await context.newPage();
  try {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await signIn(page, w.tenants.alpha.users.admin);
    const small: string[] = [];
    for (const path of ["/jobs", "/quotes", "/customers", "/purchase-orders"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const found = await page.evaluate(() => ({
        by: document.documentElement.scrollWidth - window.innerWidth,
        short: [...document.querySelectorAll<HTMLElement>("button[data-slot='button'], a[data-slot='button']")]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5; })
          .map((el) => `${(el.textContent ?? "").trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}px`).slice(0, 5),
      }));
      expect({ path, sideways: found.by }).toEqual({ path, sideways: 0 });
      if (found.short.length) small.push(`${path}: ${found.short.join(" | ")}`);
    }
    expect(small).toEqual([]);
  } finally {
    await context.close();
  }
});

// One test per page, and each page is loaded once then resized, instead of one test making 44 page loads (it ran past the
// test timeout when the whole suite was busy). A layout that depends on being loaded at a width is not what this checks:
// the pages are responsive, so resizing shows the same layout a fresh load at that width would.
for (const path of ["/dashboard", "/invoices", "/quotes", "/sales-orders", "/jobs", "/delivery-notes", "/purchase-orders", "/schedule", "/rfq", "/approval", "/customers"]) {
  test(`${path}: no sideways scrolling at phone and tablet widths`, async ({ page }) => {
    await signIn(page, w.tenants.alpha.users.admin);
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const problems: string[] = [];
    for (const width of [768, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      // Wait for the layout to settle at the new width (a frame after the resize), not for a fixed time.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const found = await page.evaluate(() => {
        const wide = [...document.querySelectorAll("body *")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest("[data-allow-scroll-x]") && getComputedStyle(el).position !== "fixed";
        }).map((el) => `${el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(el.getBoundingClientRect().right)}`);
        return { by: document.documentElement.scrollWidth - window.innerWidth, wide: wide.slice(0, 3) };
      });
      if (found.by > 0) problems.push(`@${width}: +${found.by}px ${found.wide.join(" | ")}`);
    }
    expect(problems).toEqual([]);
  });
}
