/** AZ: real browser and persisted-state acceptance. Fake tenants only, removed by global cleanup.
 * Requires the approved 145 fixture already installed on the isolated backend. Never installs SQL here.
 * Run only in the separately authorised rehearsal; --list checks collection without starting it.
 */
import { expect, test, type Locator } from "@playwright/test";
import { dayTotals, settingsFromRow, type AttendanceEvent } from "@/lib/time-sheet";
import { paidDay } from "@/lib/working-hours";
import { adminClient, createSoloTenant, verifyBackendIdentity } from "../support/fixtures";
import { signIn, world } from "./helpers";

const rows = async (table: string, org: string) => {
  const result = await adminClient().from(table).select("*").eq("organization_id", org).order("id");
  expect(result.error, `${table} must be readable on the rehearsal schema`).toBeNull();
  return result.data!;
};
const timeSettings = async (org: string) => {
  const result = await adminClient().from("time_settings").select("*").eq("organization_id", org).maybeSingle();
  expect(result.error).toBeNull();
  return result.data;
};
const template = async (org: string) => {
  const result = await adminClient().from("email_templates").select("subject,body").eq("organization_id", org).eq("key", "invoice").maybeSingle();
  expect(result.error).toBeNull();
  return result.data;
};
const field = async (card: Locator, label: string, text: string) => {
  const group = card.getByRole("group", { name: label, exact: true });
  const remove = group.getByRole("button", { name: /^Remove .+ from / });
  while (await remove.count()) await remove.first().click();
  await group.getByRole("textbox").fill(text);
};

test("N1 paid breaks: saved company rule survives reload and agrees with clocked and planned hours", async ({ page }) => {
  await verifyBackendIdentity();
  const company = await createSoloTenant(world().runId, "az-breaks");
  const otherBefore = await timeSettings(world().tenants.beta.id);
  await signIn(page, company.admin);
  await page.goto("/settings");
  const paid = page.getByRole("checkbox", { name: /^Breaks are paid/ });
  await expect(page.getByRole("button", { name: "Save hours settings", exact: true })).toBeEnabled();
  await page.getByLabel("Lunch (minutes)", { exact: true }).fill("20");
  await page.getByLabel("Break (minutes)", { exact: true }).fill("10");
  await page.getByLabel("Deduct breaks on days of at least (hours)", { exact: true }).fill("5");
  const events: AttendanceEvent[] = [
    { id: "in", user_id: company.admin.id, action: "in", at: "2026-11-02T08:00:00Z", received_at: "2026-11-02T08:00:00Z" },
    { id: "out", user_id: company.admin.id, action: "out", at: "2026-11-02T16:00:00Z", received_at: "2026-11-02T16:00:00Z" },
  ];
  for (const enabled of [true, false]) {
    await paid.setChecked(enabled);
    const response = page.waitForResponse(r => r.url().includes("/rpc/save_time_settings") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save hours settings", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect.poll(async () => (await timeSettings(company.id))?.breaks_paid).toBe(enabled);
    await page.reload();
    await expect(paid).toBeChecked({ checked: enabled });
    const settings = settingsFromRow(await timeSettings(company.id));
    expect(paidDay("08:00", "16:00", settings)?.paid).toBe(enabled ? 480 : 450);
    expect(dayTotals({ date: "2026-11-02", events, labour: [], settings, bankHolidays: new Map(), now: Date.parse("2026-11-03T00:00:00Z") }).paid).toBe(enabled ? 480 : 450);
    expect(await timeSettings(world().tenants.beta.id)).toEqual(otherBefore);
  }
});

test("N5 blank setup: fresh company has no business records and one reviewed tick changes only its own progress", async ({ page }) => {
  await verifyBackendIdentity();
  const company = await createSoloTenant(world().runId, "az-blank", undefined, { salesOrders: false });
  const progress = async (org: string) => {
    const result = await adminClient().from("company_setup_progress").select("step,completed").eq("organization_id", org).order("step");
    expect(result.error, "Install reviewed 145 only in the separately authorised rehearsal").toBeNull();
    return result.data;
  };
  const otherBefore = await progress(world().tenants.beta.id);
  expect(await progress(company.id)).toEqual([]);
  for (const table of ["customers", "jobs", "purchase_orders", "invoices", "invoice_payments"]) expect(await rows(table, company.id)).toEqual([]);
  await signIn(page, company.admin);
  await page.goto("/settings");
  const guide = page.getByRole("region", { name: "Company setup" });
  await expect(guide).toContainText("0 of 9 reviewed");
  const ticks = guide.getByRole("checkbox", { name: "I have checked this", exact: true });
  await expect(ticks).toHaveCount(9);
  for (let i = 0; i < 9; i++) await expect(ticks.nth(i)).not.toBeChecked();
  await ticks.first().check();
  await expect.poll(() => progress(company.id)).toEqual([{ step: "company", completed: true }]);
  await page.reload();
  await expect(guide).toContainText("1 of 9 reviewed");
  await expect(ticks.first()).toBeChecked();
  expect(await progress(world().tenants.beta.id)).toEqual(otherBefore);
  for (const table of ["customers", "jobs", "purchase_orders", "invoices", "invoice_payments"]) expect(await rows(table, company.id)).toEqual([]);
});

test("N6 email editor: opening preserves legacy text and explicit save persists the approved wording only for this company", async ({ page }) => {
  await verifyBackendIdentity();
  const company = await createSoloTenant(world().runId, "az-email");
  const otherBefore = await template(world().tenants.beta.id);
  const legacy = { subject: "Invoice {{document_number}}", body: "Hello {{customer_name}},\n\nKeep this old wording.\n\nThanks" };
  const seed = await adminClient().from("email_templates").upsert({ organization_id: company.id, key: "invoice", ...legacy }, { onConflict: "organization_id,key" });
  expect(seed.error).toBeNull();
  await signIn(page, company.admin);
  await page.goto("/settings");
  const card = page.getByTestId("email-template-invoice");
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
  expect(await template(company.id)).toEqual(legacy);
  await field(card, "Subject line", "Please check your invoice");
  await field(card, "Greeting", "Hello,");
  await field(card, "Main message", "Please check the attached invoice.");
  await field(card, "Sign-off", "Thanks");
  expect(await template(company.id)).toEqual(legacy);
  const approved = { subject: "Please check your invoice", body: "Hello,\n\nPlease check the attached invoice.\n\nThanks" };
  await expect(card.getByTestId("email-template-invoice-preview-subject")).toHaveText(approved.subject);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => template(company.id)).toEqual(approved);
  await page.reload();
  await expect(card.getByRole("group", { name: "Main message", exact: true }).getByRole("textbox")).toHaveValue("Please check the attached invoice.");
  expect(await template(company.id)).toEqual(approved);
  expect(await template(world().tenants.beta.id)).toEqual(otherBefore);
});
