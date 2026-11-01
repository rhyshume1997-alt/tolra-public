/**
 * E11: Settings > Email templates in the browser. The admin edits the invoice subject and text with placeholders, sees the live
 * preview fill them in with example values, saves, and finds the text after a reload; Reset to default puts the default back; an
 * office user is turned away from Settings (admin-only page). The preview never shows a raw {{...}} for a placeholder the app knows.
 * Synthetic data only (tenant beta, whose admin no other spec edits templates for). Saved rows are removed at the end of each test.
 */
import { expect, test } from "@playwright/test";

import { DEFAULT_TEMPLATES, PLACEHOLDERS, SAMPLE_VARS, TEMPLATE_KEYS } from "@/lib/email/templates/defaults";
import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const org = () => w.tenants.beta.id;

const clearSaved = async () => {
  const { error } = await adminClient().from("email_templates").delete().eq("organization_id", org());
  expect(error).toBeNull();
};
const saved = async (key: string) => (await adminClient().from("email_templates").select("subject, body").eq("organization_id", org()).eq("key", key).maybeSingle()).data;

test("admin edits the invoice template, sees the preview fill in, saves, reloads, then resets to default", async ({ page }) => {
  const tag = w.runId;
  const subject = `Invoice {{document_number}} for {{customer_name}} (${tag})`;
  const body = `Dear {{customer_name}},\n\nInvoice {{document_number}} for {{total}} is due on {{due_date}}.\n\nFrom {{company_name}} ${tag}`;
  await clearSaved();
  try {
    await signIn(page, w.tenants.beta.users.admin);
    await page.goto("/settings");
    const card = page.getByTestId("email-template-invoice");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Default text");
    await expect(card.getByLabel("Subject")).toHaveValue(DEFAULT_TEMPLATES.invoice.subject);

    // Typing updates the preview at once, with the example values; nothing is stored until Save.
    await card.getByLabel("Subject").fill(subject);
    await card.getByLabel("Text", { exact: true }).fill(body);
    await expect(card.getByTestId("email-template-invoice-preview-subject")).toHaveText(`Invoice ${SAMPLE_VARS.document_number} for ${SAMPLE_VARS.customer_name} (${tag})`);
    const preview = card.getByTestId("email-template-invoice-preview-body");
    await expect(preview).toContainText(`Dear ${SAMPLE_VARS.customer_name},`);
    await expect(preview).toContainText(`Invoice ${SAMPLE_VARS.document_number} for ${SAMPLE_VARS.total} is due on ${SAMPLE_VARS.due_date}.`);
    await expect(preview).toContainText(`From ${SAMPLE_VARS.company_name} ${tag}`);
    await expect(preview).not.toContainText("{{");
    await expect(card).toContainText("unsaved changes");
    expect(await saved("invoice")).toBeNull();

    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("Your own text");
    await expect.poll(() => saved("invoice")).toEqual({ subject, body });

    // After a reload the saved text is what the editor and the preview show.
    await page.reload();
    const reloaded = page.getByTestId("email-template-invoice");
    await expect(reloaded.getByLabel("Subject")).toHaveValue(subject);
    await expect(reloaded.getByLabel("Text", { exact: true })).toHaveValue(body);
    await expect(reloaded).toContainText("Your own text");
    await expect(reloaded.getByTestId("email-template-invoice-preview-subject")).toContainText(`(${tag})`);

    // Reset to default removes the company's text.
    await reloaded.getByRole("button", { name: "Reset to default" }).click();
    await expect(reloaded.getByLabel("Subject")).toHaveValue(DEFAULT_TEMPLATES.invoice.subject);
    await expect(reloaded.getByLabel("Text", { exact: true })).toHaveValue(DEFAULT_TEMPLATES.invoice.body);
    await expect(reloaded).toContainText("Default text");
    await expect.poll(() => saved("invoice")).toBeNull();
    await page.reload();
    await expect(page.getByTestId("email-template-invoice").getByLabel("Subject")).toHaveValue(DEFAULT_TEMPLATES.invoice.subject);
  } finally {
    await clearSaved();
  }
});

test("an office user can't open Settings (admin-only page), so can't reach the templates", async ({ page }) => {
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId("email-template-invoice")).toHaveCount(0);
});

test("the preview never shows a raw {{placeholder}} for a placeholder the app knows; an unknown one stays visible with a warning", async ({ page }) => {
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/settings");
  await expect(page.getByTestId("email-template-invoice")).toBeVisible();

  // Every shipped default renders with example values only.
  for (const key of TEMPLATE_KEYS) {
    const card = page.getByTestId(`email-template-${key}`);
    await expect(card.getByTestId(`email-template-${key}-preview-subject`)).not.toContainText("{{");
    await expect(card.getByTestId(`email-template-${key}-preview-body`)).not.toContainText("{{");
  }

  // Every placeholder the app knows, typed into one template (not saved), is replaced; the unknown one is shown as typed.
  const card = page.getByTestId("email-template-invoice");
  const known = PLACEHOLDERS.map((name) => `{{${name}}}`).join(" ");
  await card.getByLabel("Subject").fill("Check {{document_number}} {{ company_name }}");
  await card.getByLabel("Text", { exact: true }).fill(`${known}\n{{not_a_placeholder}}`);
  const subject = card.getByTestId("email-template-invoice-preview-subject");
  const preview = card.getByTestId("email-template-invoice-preview-body");
  await expect(subject).toHaveText(`Check ${SAMPLE_VARS.document_number} ${SAMPLE_VARS.company_name}`);
  await expect(preview).toContainText("{{not_a_placeholder}}");
  await expect(preview).toContainText(SAMPLE_VARS.customer_name);
  const text = (await preview.textContent()) ?? "";
  expect(text.replace("{{not_a_placeholder}}", "")).not.toMatch(/\{\{/);
  await expect(card.getByRole("alert")).toContainText("{{not_a_placeholder}}");
});
