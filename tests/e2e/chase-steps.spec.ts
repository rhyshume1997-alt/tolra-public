/**
 * Late-payer chasing, phase 1 (migration 138), in a company of its own, in the browser and the database behind it:
 *   - Settings > Email schedules > Chase steps: with none saved the suggested four (3 days before due, 7, 14 and 30 after) show as not
 *     saved; Save stores them (chase_steps).
 *   - Pause and resume: on an invoice's details, Pause chasing (a reason) shows "Chasing paused" and the list marks it; Resume takes it off.
 *   - The scheduled pass (/api/cron/daily, the invoice_reminder schedule due now) makes DRAFTS only: one chase draft for the owed invoice,
 *     none for the paused one or the paid one, and the mock mailer receives nothing for this company.
 *   - Approvals: the chase draft has Approve and send; edited on the card and approved, it goes through the company mailer (the Resend
 *     mock, playwright.config.ts) with the edited text, leaves the queue, and chase_sends records who approved it and the sent e-mail.
 * The invoices are due in 3 days, so only the before-due step (-3) has been reached: one step, whatever the selection rule (lib/chasing/
 * steps.ts, TODO-CHATGPT) chooses between steps reached together. Not covered here (no way to switch the mailer off per test): the
 * no-mailer answer, which tests/unit/chase-approve.test.ts proves.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type { RecordedEmail } from "../support/mock-providers";
import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";
import { E2E_CRON_SECRET, E2E_MOCK_PORT } from "./paths";

import { optionalBackendConfigured } from "../support/optional-backend";

test.skip(!optionalBackendConfigured(), "No disposable test database configured.");
const w = world();

async function recordedMail(): Promise<RecordedEmail[]> {
  return (await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`)).json();
}
const toOf = (mail: RecordedEmail) => JSON.stringify((mail.body as { to?: unknown })?.to ?? "");

/** Today's date in UK time plus `days`, YYYY-MM-DD. */
function ukDatePlus(days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe("Chase steps in their own company", () => {
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let org: Awaited<ReturnType<typeof createSoloTenant>>;
  const tag = randomUUID().slice(0, 6);
  const customer = `Chase ${tag} Ltd`;
  let address = "";
  const ids: Record<"owed" | "paused" | "paid", string> = { owed: "", paused: "", paid: "" };

  test.beforeAll(async ({ browser }) => {
    address = `chase.${tag}.${w.runId}@example.test`; // the world is read inside hooks only
    org = await createSoloTenant(w.runId, `chase-${tag}`);
    const service = adminClient();
    expect((await service.from("customers").insert({ organization_id: org.id, name: customer, email: address, contact_name: "Pat" })).error).toBeNull();
    for (const [key, extra] of [["owed", {}], ["paused", {}], ["paid", { status: "paid", amount_paid: 120 }]] as const) {
      const { data, error } = await service.from("invoices").insert({
        organization_id: org.id, invoice_ref: `INV-CH-${tag}-${key}`, customer, status: "sent", subtotal: 100, vat: 20, total: 120, vat_enabled: true, amount_paid: 0,
        due_date: ukDatePlus(3), ...extra,
      }).select("id").single();
      expect(error).toBeNull();
      ids[key] = data!.id;
    }
    page = await browser.newPage();
    await signIn(page, org.admin);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("Settings shows the suggested steps, not saved; Save stores them", async () => {
    await page.goto("/settings");
    const steps = page.getByTestId("chase-steps");
    await expect(steps).toBeVisible();
    await expect(steps.getByTestId("chase-steps-suggested")).toBeVisible();
    await expect(steps.getByTestId("chase-step")).toHaveCount(4);
    expect((await adminClient().from("chase_steps").select("id").eq("organization_id", org.id)).data).toEqual([]);
    const savedRequest = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/rpc/save_chase_steps_atomic") && response.request().method() === "POST");
    await steps.getByRole("button", { name: "Save chase steps" }).click();
    const savedResponse = await savedRequest;
    expect(savedResponse.status(), "The real atomic save must succeed before showing success").toBe(200);
    await expect(page.getByText("Chase steps saved.", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => ((await adminClient().from("chase_steps").select("offset_days, tone").eq("organization_id", org.id).order("offset_days")).data ?? []))
      .toEqual([{ offset_days: -3, tone: "before_due" }, { offset_days: 7, tone: "friendly" }, { offset_days: 14, tone: "firm" }, { offset_days: 30, tone: "final" }]);
    await page.reload();
    await expect(page.getByTestId("chase-steps-suggested")).toHaveCount(0);
    await expect(page.getByTestId("chase-step")).toHaveCount(4);
  });

  test("Pause chasing on an invoice shows it paused; Resume takes it off; paused again for the pass", async () => {
    await page.goto(`/invoices?invoice=${ids.paused}`);
    const control = page.getByTestId("chase-pause-invoice");
    await expect(control).toBeVisible();
    await control.getByRole("button", { name: "Pause chasing" }).click();
    await control.getByLabel("Reason for pausing chasing").fill("Query on the delivery");
    await control.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(control.getByTestId("chase-pause-status")).toHaveText("Chasing paused");
    await expect(control).toContainText("Reason: Query on the delivery");
    expect((await adminClient().from("chase_pauses").select("reason, paused_by").eq("invoice_id", ids.paused)).data).toEqual([{ reason: "Query on the delivery", paused_by: org.admin.id }]);

    await control.getByRole("button", { name: "Resume chasing" }).click();
    await expect(control.getByRole("button", { name: "Pause chasing" })).toBeVisible();
    expect((await adminClient().from("chase_pauses").select("id").eq("invoice_id", ids.paused)).data).toEqual([]);

    await control.getByRole("button", { name: "Pause chasing" }).click();
    await control.getByLabel("Reason for pausing chasing").fill("On hold");
    await control.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(control.getByTestId("chase-pause-status")).toHaveText("Chasing paused");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("row").filter({ hasText: `INV-CH-${tag}-paused` }).getByTestId("chase-paused-badge")).toBeVisible();
  });

  test("the scheduled pass makes drafts only: one for the owed invoice, none for the paused or the paid one, nothing e-mailed", async ({ request }) => {
    const service = adminClient();
    // A once schedule a moment from now (the cron never fires for a moment before the schedule last changed).
    const runAt = new Date(Date.now() + 3_000).toISOString();
    expect((await service.from("email_schedules").insert({ organization_id: org.id, kind: "invoice_reminder", enabled: true, frequency: "once", run_at: runAt, time_of_day: "08:00" })).error).toBeNull();
    await page.waitForTimeout(4_000);
    const before = (await recordedMail()).length;
    const response = await request.get("/api/cron/daily", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
    expect(response.status()).toBe(200);
    expect((await response.json()).emailSchedules).not.toHaveProperty("error");

    const drafts = (await service.from("email_history").select("id, status, related_to_id, to_email").eq("organization_id", org.id)).data ?? [];
    expect(drafts.map((d) => [d.related_to_id, d.status, d.to_email])).toEqual([[ids.owed, "drafted", address]]);
    expect((await service.from("chase_sends").select("invoice_id, offset_days, tone, status, drafted_by").eq("organization_id", org.id)).data)
      .toEqual([{ invoice_id: ids.owed, offset_days: -3, tone: "before_due", status: "drafted", drafted_by: null }]);
    expect((await recordedMail()).slice(before).filter((m) => toOf(m).includes(address))).toEqual([]);
  });

  test("Approve and send: edited in Approvals, exact reviewed text sent, off the queue, approval recorded", async () => {
    await page.goto("/approval");
    const card = page.locator('[data-slot="card"]').filter({ hasText: address });
    await expect(card).toBeVisible();
    const before = (await recordedMail()).length;
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    // The real page's Edit Email dialog is portalled outside the card and labels this field Body.
    // #161 also carries the inline chase editor (Message); both must expose exactly one active message editor.
    const body = page.getByRole("textbox", { name: /^(Body|Message)$/ });
    const subject = page.getByRole("textbox", { name: "Subject", exact: true });
    await expect(body).toHaveCount(1);
    await expect(body).toBeVisible();
    const approvedSubject = await subject.inputValue();
    const approvedBody = `${await body.inputValue()}\n\nEdited before sending ${tag}`;
    await body.fill(approvedBody);
    await page.getByRole("button", { name: /^Save draft$/i }).click();
    await expect(body).toHaveCount(0);
    await expect.poll(async () => (await adminClient().from("email_history").select("subject, body")
      .eq("organization_id", org.id).eq("related_to_id", ids.owed).eq("status", "drafted").single()).data)
      .toEqual({ subject: approvedSubject, body: approvedBody });

    const confirmation = page.getByRole("dialog", { name: "Approve and send", exact: true });
    const sentResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chase/approve" && response.request().method() === "POST");
    const nextStep = Promise.race([
      confirmation.waitFor({ state: "visible" }).then(() => "review"),
      sentResponse.then(() => "sent"),
    ]);
    await expect(card.getByRole("button", { name: "Approve and send", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "Approve and send", exact: true }).click();
    if (await nextStep === "review") {
      await expect(confirmation.getByRole("textbox", { name: "Subject", exact: true })).toHaveValue(approvedSubject);
      await expect(confirmation.getByRole("textbox", { name: "Body", exact: true })).toHaveValue(approvedBody);
      await confirmation.getByRole("button", { name: "Approve and send", exact: true }).click();
    }
    expect((await sentResponse).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);

    await expect.poll(async () => (await recordedMail()).slice(before).filter((m) => toOf(m).includes(address)).length).toBe(1);
    const sent = (await recordedMail()).slice(before).find((m) => toOf(m).includes(address))!;
    expect((sent.body as { subject?: string; text?: string })).toMatchObject({ subject: approvedSubject, text: approvedBody });

    const service = adminClient();
    const chase = (await service.from("chase_sends").select("status, approved_by, sent_history_id, draft_history_id").eq("invoice_id", ids.owed).single()).data!;
    expect(chase).toMatchObject({ status: "sent", approved_by: org.admin.id, draft_history_id: null });
    expect((await service.from("email_history").select("id, status, subject, body").eq("organization_id", org.id)).data).toEqual([
      { id: chase.sent_history_id, status: "sent_via_system", subject: approvedSubject, body: approvedBody },
    ]);
    await page.reload();
    await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
  });
});
