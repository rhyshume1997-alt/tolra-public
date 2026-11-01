/**
 * P1 print pack (D30-4): Settings > Print layout and the per-company default. The per-print override on the pack page is covered by
 * worksheet.spec.ts ("workshop pack: the selected jobs print together..."); this spec covers the Settings card, the saved choice, and
 * what the single job print page does with it.
 *
 * Runs in its own company (createSoloTenant): the layout is saved per company (organization_settings.company_profile.printLayout), so
 * in the shared alpha/beta tenants it would flip the layout other specs read (worksheet.spec expects Basic by default on beta).
 * The solo company is not JNR (its slug is not "jnr-engineering"), so its default is Basic. Alpha is only read: it must still show
 * Basic after the solo company chose the JNR sheet (isolation). The JNR sheet carries no data-print-layout attribute, so it is
 * recognised by its own wording ("Part Checklist Must Be Completed") and by the absence of the Basic marker.
 * Synthetic data only. The world is read inside the tests, never at import.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

type Solo = Awaited<ReturnType<typeof createSoloTenant>>;
let solo: Solo;
const START_PHONE = "01000 000000"; // createSoloTenant's profile phone

const BASIC_SHEET = '[data-print-layout="basic"]';
const JNR_ONLY = "Part Checklist Must Be Completed";

test.beforeAll(async () => {
  solo = await createSoloTenant(w.runId, `printlayout-${randomUUID().slice(0, 6)}`);
});

async function profileOf(orgId: string): Promise<Record<string, unknown>> {
  const { data, error } = await adminClient().from("organization_settings").select("company_profile").eq("organization_id", orgId).single();
  expect(error).toBeNull();
  return data!.company_profile as Record<string, unknown>;
}

/** Back to "never chosen" and the starting phone before each test, so the tests do not depend on each other's order. */
test.beforeEach(async () => {
  const { printLayout: _drop, ...rest } = await profileOf(solo.id); // eslint-disable-line @typescript-eslint/no-unused-vars
  const { error } = await adminClient().from("organization_settings").update({ company_profile: { ...rest, phone: START_PHONE } }).eq("organization_id", solo.id);
  expect(error).toBeNull();
});

async function newJob(jobNo: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: solo.id, job_no: jobNo, customer: "Layout Co", ...extra }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

/** Opens Settings and waits for the Print layout card to have read the company's setting. */
async function openSettings(page: Page) {
  await page.goto("/settings");
  const select = page.getByTestId("print-layout-setting");
  await expect(select).toBeVisible();
  return select;
}

async function chooseOnCard(page: Page, layout: "basic" | "jnr", toastText: string) {
  await page.getByTestId("print-layout-setting").selectOption(layout);
  await expect(page.getByText(toastText)).toBeVisible();
  await expect(page.locator("[data-print-layout-source]")).toHaveAttribute("data-print-layout-source", "saved");
}

test("admin sees the Print layout card with Basic by default and what the JNR sheet prints; office and workshop never reach it", async ({ page, browser }) => {
  await signIn(page, solo.admin);
  const select = await openSettings(page);
  await expect(page.locator('[data-slot="card-title"]').filter({ hasText: /^\s*Print layout\s*$/ })).toBeVisible(); // CardTitle is a div, not a heading; its text is " Print layout" (icon, then a space), and a regex hasText is matched without trimming
  await expect(select).toHaveValue("basic");
  await expect(select.locator("option")).toHaveText(["Basic", "JNR sheet"]);
  await expect(page.getByText("The JNR sheet prints material cert, heat/cast, machines and the part checklist; Basic prints only the traceability numbers, and only on traceable jobs.")).toBeVisible();
  // Never chosen: the status line says it is the company's default, and nothing is stored.
  await expect(page.locator("[data-print-layout-source]")).toHaveAttribute("data-print-layout-source", "default");
  await expect(page.getByText("Not chosen yet: your company prints the Basic layout, the default for your company.")).toBeVisible();
  expect((await profileOf(solo.id)).printLayout).toBeUndefined();

  // Settings is admin-only (RoleGate): office and workshop are sent to the dashboard and never see the card.
  for (const user of [w.tenants.alpha.users.office, w.tenants.alpha.users.workshop]) {
    const other = await browser.newPage();
    try {
      await signIn(other, user);
      await other.goto("/settings");
      await expect(other).toHaveURL(/\/dashboard/);
      await expect(other.getByTestId("print-layout-setting")).toHaveCount(0);
    } finally {
      await other.close();
    }
  }
});

test("admin picks the JNR sheet and saves: it survives a reload, and the job print page defaults to it, with Basic one pick away for that view only", async ({ page }) => {
  const jobNo = `J-PL-${w.runId}`;
  const jobId = await newJob(jobNo, { drawing_no: "DWG-PL-1" });
  await signIn(page, solo.admin);

  // Before any choice the print page is Basic (the company default), with no JNR-only element.
  await page.goto(`/jobs/${jobId}/print`);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(1);
  await expect(page.getByText(JNR_ONLY)).toHaveCount(0);
  await expect(page.getByLabel("Print layout")).toHaveValue("");

  await openSettings(page);
  await chooseOnCard(page, "jnr", "Worksheets now print in the JNR sheet layout");
  expect((await profileOf(solo.id)).printLayout).toBe("jnr");

  await page.reload();
  await expect(page.getByTestId("print-layout-setting")).toHaveValue("jnr");
  await expect(page.getByText("Your company prints the JNR sheet layout.")).toBeVisible();

  // The job print page now prints the JNR sheet by default.
  await page.goto(`/jobs/${jobId}/print`);
  await expect(page.getByText(JNR_ONLY)).toHaveCount(1);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(0);
  await expect(page.getByLabel("Print layout")).toHaveValue("");
  await expect(page.getByLabel("Print layout").locator("option").first()).toHaveText("Company setting (JNR sheet)");

  // The per-print dropdown switches to Basic for this view only: nothing is saved.
  await page.getByLabel("Print layout").selectOption("basic");
  await expect(page.locator(BASIC_SHEET)).toHaveCount(1);
  await expect(page.getByText(JNR_ONLY)).toHaveCount(0);
  expect((await profileOf(solo.id)).printLayout).toBe("jnr");
  await page.reload();
  await expect(page.getByText(JNR_ONLY)).toHaveCount(1);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(0);
  await expect(page.getByLabel("Print layout")).toHaveValue("");

  // And back to Basic on the card: the print page follows.
  await openSettings(page);
  await chooseOnCard(page, "basic", "Worksheets now print in the Basic layout");
  expect((await profileOf(solo.id)).printLayout).toBe("basic");
  await page.goto(`/jobs/${jobId}/print`);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(1);
  await expect(page.getByText(JNR_ONLY)).toHaveCount(0);
});

test("saving Company details keeps the JNR choice (P1-4)", async ({ page }) => {
  await signIn(page, solo.admin);
  await openSettings(page);
  await chooseOnCard(page, "jnr", "Worksheets now print in the JNR sheet layout");

  // Same page, no reload: the form must not write back an older copy of the profile without the choice.
  const form = page.getByTestId("company-details-form");
  await expect(form).toHaveAttribute("data-loaded", "true");
  const phone = form.getByRole("textbox", { name: "Phone", exact: true });
  const newPhone = "01234 567890";
  await phone.fill(newPhone);
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Company details saved")).toBeVisible();

  const profile = await profileOf(solo.id);
  expect(profile.phone).toBe(newPhone);
  expect(profile.printLayout).toBe("jnr");

  await page.reload();
  await expect(page.getByTestId("print-layout-setting")).toHaveValue("jnr");
  await expect(page.locator("[data-print-layout-source]")).toHaveAttribute("data-print-layout-source", "saved");
  await expect(page.getByTestId("company-details-form")).toHaveAttribute("data-loaded", "true");
  await expect(page.getByTestId("company-details-form").getByRole("textbox", { name: "Phone", exact: true })).toHaveValue(newPhone);
});

test("a company that never chose a layout keeps getting Basic after Company details is saved (no choice invented)", async ({ page }) => {
  await signIn(page, solo.admin);
  await page.goto("/settings");
  const form = page.getByTestId("company-details-form");
  await expect(form).toHaveAttribute("data-loaded", "true");
  await form.getByRole("textbox", { name: "Phone", exact: true }).fill("01234 000111");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Company details saved")).toBeVisible();
  expect((await profileOf(solo.id)).printLayout).toBeUndefined();
  await page.reload();
  await expect(page.getByTestId("print-layout-setting")).toHaveValue("basic");
  await expect(page.locator("[data-print-layout-source]")).toHaveAttribute("data-print-layout-source", "default");
});

test("Basic prints the Traceability block on a traceable job (marked, or with a heat/cast number) and not on a plain job", async ({ page }) => {
  const flagged = `J-PT1-${w.runId}`;
  const heat = `J-PT2-${w.runId}`;
  const plain = `J-PT3-${w.runId}`;
  const flaggedId = await newJob(flagged, { traceable: true });
  const heatId = await newJob(heat, { heat_cast_no: `HEAT-${w.runId}` });
  const plainId = await newJob(plain);
  await signIn(page, solo.admin);

  await page.goto(`/jobs/${flaggedId}/print`);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(1);
  await expect(page.locator("[data-traceability]")).toHaveCount(1);
  await expect(page.locator("[data-traceability]")).toContainText("Material cert no.");
  await expect(page.locator("[data-traceability]")).toContainText("Heat/cast no.");

  await page.goto(`/jobs/${heatId}/print`);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(1);
  await expect(page.locator("[data-traceability]")).toHaveCount(1);
  await expect(page.locator("[data-traceability]")).toContainText(`HEAT-${w.runId}`);

  await page.goto(`/jobs/${plainId}/print`);
  await expect(page.locator(BASIC_SHEET)).toHaveCount(1);
  await expect(page.locator("[data-traceability]")).toHaveCount(0);
  await expect(page.getByText("Traceability", { exact: true })).toHaveCount(0);
});

test("another company's admin still sees Basic after this company chose the JNR sheet", async ({ page, browser }) => {
  await signIn(page, solo.admin);
  await openSettings(page);
  await chooseOnCard(page, "jnr", "Worksheets now print in the JNR sheet layout");

  const other = await browser.newPage();
  try {
    await signIn(other, w.tenants.alpha.users.admin);
    const select = await openSettings(other);
    await expect(select).toHaveValue("basic");
    await expect(other.locator("[data-print-layout-source]")).toHaveAttribute("data-print-layout-source", "default");
    expect((await profileOf(w.tenants.alpha.id)).printLayout).toBeUndefined();
  } finally {
    await other.close();
  }
});
