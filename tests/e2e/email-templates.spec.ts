/**
 * E11: Settings > Email templates in the browser. The admin edits the invoice subject and text with placeholders, sees the live
 * preview fill them in with example values, saves, and finds the text after a reload; Reset to default puts the default back; an
 * office user is turned away from Settings (admin-only page). The preview never shows a raw {{...}} for a placeholder the app knows.
 * Synthetic data only (tenant beta, whose admin no other spec edits templates for). Saved rows are removed at the end of each test.
 */
import { expect, test, type Locator } from "@playwright/test";

import { DEFAULT_TEMPLATES, PLACEHOLDERS, SAMPLE_VARS, TEMPLATE_KEYS } from "@/lib/email/templates/defaults";
import { detailLabel, detailParts, emailSections } from "@/lib/email/templates/editor";
import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const org = () => w.tenants.beta.id;

const clearSaved = async () => {
  const { error } = await adminClient().from("email_templates").delete().eq("organization_id", org());
  expect(error).toBeNull();
};

// The editor is token based: each part of an e-mail (Subject line, Greeting, Main message, Sign-off) is a labelled group of text boxes
// with a chip for each inserted detail ({{name}}), so there is no single "Subject" or "Text" box to read or fill.
type Shown = { kind: "text"; text: string } | { kind: "detail"; label: string };
const group = (card: Locator, label: string) => card.getByRole("group", { name: label, exact: true });
/** Fills one part with `raw` text, where {{name}} markers become detail chips: removes the part's chips, then types into its only box. */
const setField = async (card: Locator, label: string, raw: string) => {
  const chips = group(card, label).getByRole("button", { name: /^Remove .+ from / });
  while ((await chips.count()) > 0) await chips.first().click();
  await group(card, label).getByRole("textbox").fill(raw);
};
/** What one part shows, box by box and chip by chip (a chip is its label, e.g. "Document number"). */
const shown = (card: Locator, label: string) =>
  group(card, label).evaluate((el): Shown[] => [...el.querySelector(":scope > div")!.children].map((child) =>
    child instanceof HTMLTextAreaElement ? { kind: "text", text: child.value } : { kind: "detail", label: (child.firstChild?.textContent ?? "").trim() }));
/** One part shows exactly `raw` (text and {{name}} markers), as boxes and chips. */
const expectField = (card: Locator, label: string, raw: string) =>
  expect.poll(() => shown(card, label)).toEqual(detailParts(raw).map((part): Shown => (part.kind === "text" ? part : { kind: "detail", label: detailLabel(part.name) })));
/** The three body parts (Greeting, Main message, Sign-off) are joined by blank lines into the stored text. */
const setBody = async (card: Locator, greeting: string, message: string, signoff = "") => {
  await setField(card, "Greeting", greeting);
  await setField(card, "Main message", message);
  await setField(card, "Sign-off", signoff);
};
/** The body parts show `body` as the editor splits it on load (same split as the editor, so this is for defaults). */
const expectBody = async (card: Locator, body: string) => {
  const sections = emailSections(body);
  await expectField(card, "Greeting", sections.greeting);
  await expectField(card, "Main message", sections.message);
  await expectField(card, "Sign-off", sections.signoff);
};
const saved = async (key: string) => (await adminClient().from("email_templates").select("subject, body").eq("organization_id", org()).eq("key", key).maybeSingle()).data;

test("admin edits the invoice template, sees the preview fill in, saves, reloads, then resets to default", async ({ page }) => {
  const tag = w.runId;
  const subject = `Invoice {{document_number}} for {{customer_name}} (${tag})`;
  const greeting = "Dear {{customer_name}},";
  const message = `Invoice {{document_number}} for {{total}} is due on {{due_date}}.\n\nFrom {{company_name}} ${tag}`;
  const body = `${greeting}\n\n${message}`;
  await clearSaved();
  try {
    await signIn(page, w.tenants.beta.users.admin);
    await page.goto("/settings");
    const card = page.getByTestId("email-template-invoice");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Default text");
    await expectField(card, "Subject line", DEFAULT_TEMPLATES.invoice.subject);

    // Typing updates the preview at once, with the example values; nothing is stored until Save.
    await setField(card, "Subject line", subject);
    await setBody(card, greeting, message);
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
    await expectField(reloaded, "Subject line", subject);
    await expectField(reloaded, "Greeting", greeting);
    await expectField(reloaded, "Main message", message);
    await expectField(reloaded, "Sign-off", "");
    await expect(reloaded).toContainText("Your own text");
    await expect(reloaded.getByTestId("email-template-invoice-preview-subject")).toContainText(`(${tag})`);

    // Reset to default removes the company's text.
    await reloaded.getByRole("button", { name: "Reset to default" }).click();
    await expectField(reloaded, "Subject line", DEFAULT_TEMPLATES.invoice.subject);
    await expectBody(reloaded, DEFAULT_TEMPLATES.invoice.body);
    await expect(reloaded).toContainText("Default text");
    await expect.poll(() => saved("invoice")).toBeNull();
    await page.reload();
    await expectField(page.getByTestId("email-template-invoice"), "Subject line", DEFAULT_TEMPLATES.invoice.subject);
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
  await setField(card, "Subject line", "Check {{document_number}} {{ company_name }}");
  await setBody(card, "", `${known}\n{{not_a_placeholder}}`);
  const subject = card.getByTestId("email-template-invoice-preview-subject");
  const preview = card.getByTestId("email-template-invoice-preview-body");
  await expect(subject).toHaveText(`Check ${SAMPLE_VARS.document_number} ${SAMPLE_VARS.company_name}`);
  await expect(preview).toContainText("{{not_a_placeholder}}");
  await expect(preview).toContainText(SAMPLE_VARS.customer_name);
  const text = (await preview.textContent()) ?? "";
  expect(text.replace("{{not_a_placeholder}}", "")).not.toMatch(/\{\{/);
  await expect(card.getByRole("alert")).toContainText("{{not_a_placeholder}}");
});
