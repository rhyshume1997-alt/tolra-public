/**
 * GO-LIVE SMOKE WALK (one ordered walk, one run, on the disposable stack of .github/workflows/golive-smoke.yml). Synthetic data only.
 *
 * The smoke company was made before the post-144 releases (scripts/golive-smoke/seed-company.mjs), so release 147 holds it as it will
 * hold JNR: no delivery note can be made until the cutover-day DLN counter step. The walk, as each role, in the browser:
 *   17 office adds the customers;
 *   18 office tries a delivery note from a job with no order and a hand-made one: both refused, nothing written, no number taken;
 *   19-21 the operator's DLN step on the disposable database (scripts/golive-smoke/dln-step.sh: supabase/cutover at the candidate,
 *      unchanged): last pad number 4521 set, the verify file 10/10 PASS, a second run refused with nothing changed;
 *   22 office quotes with a costing line (the real costing panel, against a loopback stand-in engine: 3 x 33.335 -> 33.34 each);
 *   23 admin sends it, the customer accepts with their PO: the sales order and the job are made;
 *   24 admin finishes and inspects the job;
 *   25 office makes the delivery note from the sales order: DLN-4522; workshop marks it despatched;
 *   26 office makes the delivery note for the job with no order (release 147's route): DLN-4523;
 *   27-29 the print sheet (goods-out wording, Received by / Signature / Date), the PDF downloaded (same wording, read from the PDF),
 *      the e-mail with the PDF through the company mailer into the test sink (the Resend mock the browser suite uses);
 *   30-31 admin issues the job's invoice (100.02 + 20.00 VAT = 120.02), office records a part payment and the rest;
 *   32 office invoices 1.5 x 0.09 (= 0.135, a half-penny tie: 0.14) and two 0.03 lines: VAT per line 0.03 + 0.01 + 0.01 = 0.05, not
 *      the 0.04 VAT on the 0.20 total would give;
 *   33 admin saves the chase steps; the scheduled pass makes a DRAFT for the owed invoice and sends nothing;
 *   34 the customer's account (the money owed to the penny; there is no customer statement document at this SHA: KNOWN GAP);
 *   35 office searches; 36 workshop is kept off money screens and the send route; 37 viewer cannot edit or make a note; 38 another
 *      company's admin sees nothing of this company; 39 every refused action left the company's records exactly as they were.
 * Every step writes "SMOKE <n> <name>: PASS|FAIL ..." (tests/e2e/golive-smoke/results.ts); scripts/golive-smoke/gate.mjs fails the job on
 * any FAIL, skip or missing step.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import type { RecordedEmail } from "../../support/mock-providers";
import { adminClient, signedInClient, withDb, type SyntheticUser } from "../../support/fixtures";
import { pdfText } from "../../support/pdf-text";
import { confirmFinish, confirmSend, signIn, world } from "../helpers";
import { E2E_CRON_SECRET, E2E_MOCK_PORT } from "../paths";
import { COSTING_PART, COSTING_PORT } from "./mock-costing";
import { TENANT_FILE, finding, knownGap, stepRunner } from "./results";

type Tenant = { id: string; slug: string; name: string; run: string; users: Record<"admin" | "office" | "workshop" | "viewer", SyntheticUser> };

const ROOT = path.resolve(__dirname, "../../..");
const LAST_PAD = "4521";
const GOODS_OUT = "Goods out: the items listed above were despatched.";
const RECEIVED_BLANK = "Received by: __________________ Signature: __________________ Date: __________";
const pence = (n: unknown) => Math.round(Number(n) * 100);
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function ukDatePlus(days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** scripts/golive-smoke/dln-step.sh: the cutover files through psql, as the operator runs them. Never throws: returns the exit code. */
function dlnStep(mode: "set" | "verify", slug: string, last: string) {
  try {
    return { code: 0, out: execFileSync("bash", ["scripts/golive-smoke/dln-step.sh", mode, slug, last], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);

const BUSINESS = ["customers", "quotes", "quote_line_items", "sales_orders", "jobs", "invoices", "invoice_line_items", "invoice_payments",
  "delivery_notes", "delivery_note_items", "email_history", "doc_counters"];
/** md5 of every business row of the company, per table (the same measure as tests/db/data-import-pr2.test.ts). */
const checksums = (org: string) => withDb(async (db) => {
  const out: Record<string, string> = {};
  for (const t of BUSINESS) out[t] = (await db.query<{ m: string }>(`select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by to_jsonb(r)::text), '')) as m from public.${t} r where organization_id = $1`, [org])).rows[0].m;
  return out;
});

async function recordedMail(): Promise<RecordedEmail[]> {
  return (await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`)).json();
}
const mailTo = (mail: RecordedEmail, address: string) => JSON.stringify((mail.body as { to?: unknown })?.to ?? "").includes(address);

/** A Resend attachment's bytes, whichever way the SDK serialised them (base64 text, a Buffer as JSON, or an array of bytes). */
function attachmentBytes(content: unknown): Buffer | null {
  if (typeof content === "string") return Buffer.from(content, "base64");
  if (Array.isArray(content)) return Buffer.from(content as number[]);
  if (content && typeof content === "object" && Array.isArray((content as { data?: unknown }).data)) return Buffer.from((content as { data: number[] }).data);
  return null;
}

async function asUser(browser: Browser, user: SyntheticUser): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await signIn(page, user);
  return page;
}

async function openJobCard(page: Page, no: string) {
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Cards", exact: true }).click();
  return page.locator(`[data-testid="job-card"][data-job-no="${no}"]`);
}

test("go-live smoke walk: customer to quote to job to delivery notes (after the DLN step) to invoice, payment, chase, search and refusals", async ({ browser }) => {
  test.setTimeout(35 * 60_000);
  const t = JSON.parse(readFileSync(TENANT_FILE, "utf8")) as Tenant;
  const w = world();
  const org = t.id;
  const service = adminClient();
  const tag = t.run.slice(0, 6);
  const { step, failed } = stepRunner();

  const customerA = `Smoke Bracket Buyer ${tag} Ltd`;
  const customerT = `Smoke Tie Buyer ${tag} Ltd`;
  const customerN = `Smoke No Order ${tag} Ltd`;
  const emailOf = (name: string) => `${name.split(" ")[1].toLowerCase()}.${t.run}@example.test`;
  const customerPo = `CPO-SMK-${tag}`;
  const noOrderJob = `J-NO-SMK-${tag}`;
  const st: Record<string, string> = {};

  const office = await asUser(browser, t.users.office);
  const admin = await asUser(browser, t.users.admin);

  // ---------------------------------------------------------------------------------------------------------------------------
  await step(17, "customer-create", [], async () => {
    for (const name of [customerA, customerT, customerN]) {
      await office.goto("/customers");
      await office.getByRole("button", { name: "New customer" }).click();
      const dialog = office.getByRole("dialog", { name: "Add customer" });
      await dialog.getByRole("textbox", { name: "Customer name" }).fill(name);
      await dialog.getByRole("textbox", { name: "Email" }).fill(emailOf(name));
      await dialog.getByRole("button", { name: "Save Customer" }).click();
      await expect(dialog).toBeHidden();
      await expect(office.getByRole("cell", { name })).toBeVisible();
    }
    const rows = await sql<{ name: string; email: string; id: string }>("select id, name, email from public.customers where organization_id = $1 order by name", [org]);
    expect(rows.map((r) => [r.name, r.email])).toEqual([customerA, customerN, customerT].sort().map((n) => [n, emailOf(n)]));
    for (const r of rows) st[`cust:${r.name}`] = r.id;
    // The job with no sales order (release 147's route), finished and inspected, as tests/e2e/job-delivery-note-no-order.spec.ts makes it.
    const { data: job, error } = await service.from("jobs").insert({
      organization_id: org, job_no: noOrderJob, customer: customerN, description: "Spacers", stage: "complete",
      started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", inspected_at: "2026-10-03T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
    }).select("id").single();
    expect(error).toBeNull();
    st.noOrderJobId = job!.id;
    return `office added ${rows.length} customers through Customers > New customer (each with an e-mail); job ${noOrderJob} (no sales order) ready for step 26`;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  await step(18, "dln-refused-before-step", [17], async () => {
    const before = { notes: (await sql("select id from public.delivery_notes where organization_id = $1", [org])).length, counter: await sql<{ last: number }>("select last from public.doc_counters where organization_id = $1 and prefix = 'DLN'", [org]) };
    expect((await sql("select 1 from public.dln_numbering_pending where organization_id = $1", [org])).length).toBe(1);
    // (a) the job card's Delivery note (release 147's no-order route).
    const card = await openJobCard(office, noOrderJob);
    await card.getByRole("button", { name: "Delivery note", exact: true }).click();
    const dialog = office.getByRole("dialog", { name: `Delivery note - ${noOrderJob}` });
    await expect(dialog.getByLabel("Customer")).toHaveValue(st[`cust:${customerN}`]);
    await dialog.getByLabel("Description 1").fill("Spacer 10mm");
    await dialog.getByLabel("Quantity 1").fill("2");
    await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible();
    const jobRouteText = (await alert.textContent())?.trim() ?? "";
    await office.keyboard.press("Escape");
    // (b) a hand-made note (Delivery notes > New delivery note > Without an order).
    await office.goto("/delivery-notes");
    await office.getByRole("button", { name: "New delivery note" }).first().click();
    const form = office.getByRole("dialog", { name: "New Delivery Note" });
    await form.getByRole("button", { name: "Without an order" }).click();
    await form.locator("select[name=customer]").selectOption({ label: customerN });
    await form.getByPlaceholder(/Items, one per line/).fill("Spacer x 1");
    await form.getByRole("button", { name: "Save Delivery Note" }).click();
    const toast = office.getByText(/Nothing was saved|hasn.t been set yet/).first();
    await expect(toast).toBeVisible();
    const handMadeText = (await toast.textContent())?.trim() ?? "";
    await office.keyboard.press("Escape");
    // (c) the same refusal through the API as the office user (the database's own words), and nothing written anywhere.
    const direct = await (await signedInClient(t.users.office)).rpc("create_job_delivery_note", {
      p_job: st.noOrderJobId, p_customer: st[`cust:${customerN}`], p_request: randomUUID(), p_ship_date: ukDatePlus(0), p_tax_date: ukDatePlus(0), p_ship_via: null, p_notes: null,
      p_lines: [{ description: "Spacer", quantity: 1 }],
    });
    expect(direct.error?.code).toBe("55000");
    expect(direct.error?.message).toMatch(/numbering for this company hasn't been set yet/);
    const after = { notes: (await sql("select id from public.delivery_notes where organization_id = $1", [org])).length, counter: await sql<{ last: number }>("select last from public.doc_counters where organization_id = $1 and prefix = 'DLN'", [org]) };
    expect(after).toEqual(before);
    const documented = /numbering for this company hasn.t been set yet/;
    if (!documented.test(jobRouteText) || !documented.test(handMadeText)) {
      finding("dln-hold-message", `while the company is held, staff see "${jobRouteText}" (job card) and "${handMadeText}" (hand-made note), not the documented "Delivery note numbering for this company hasn't been set yet": the database raises 55000 with hint dln_numbering_not_set, which lib/friendly-error.ts does not pass through (KNOWN_HINTS / OWN_MESSAGE_CODES); safe (refused, nothing saved), but the reason is hidden`);
    }
    return `held: both browser routes refused ("${jobRouteText}" / "${handMadeText}"), API refused 55000 "${direct.error?.message.slice(0, 70)}..."; delivery notes ${after.notes}, DLN counter ${JSON.stringify(after.counter)} unchanged`;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  await step(19, "dln-counter-set", [18], async () => {
    const r = dlnStep("set", t.slug, LAST_PAD);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/DLN step done for .*: counter 0 -> 4521, next delivery note DLN-4522; delivery notes unlocked \(was held: t\)/);
    expect(await sql("select last from public.doc_counters where organization_id = $1 and prefix = 'DLN'", [org])).toEqual([{ last: 4521 }]);
    expect((await sql("select 1 from public.dln_numbering_pending where organization_id = $1", [org])).length).toBe(0);
    return `psql -v company_slug=${t.slug} -v last_pad_number=${LAST_PAD} -f supabase/cutover/set_dln_next_number.sql: exit 0, "${(/DLN step done[^\n]*/.exec(r.out) ?? [""])[0]}"`;
  });

  await step(20, "dln-verify-10-of-10", [19], async () => {
    const r = dlnStep("verify", t.slug, LAST_PAD);
    expect(r.code, r.out).toBe(0);
    const rows = r.out.split("\n").filter((l) => /\|(PASS|FAIL)$/.test(l));
    expect(rows, r.out).toHaveLength(10);
    expect(rows.filter((l) => l.endsWith("|PASS")), rows.join("\n")).toHaveLength(10);
    expect(rows.find((l) => l.startsWith("next DLN number|"))).toBe("next DLN number|DLN-4522|PASS");
    return `supabase/cutover/verify_dln_next_number.sql: 10/10 PASS (next DLN number DLN-4522; ${rows.find((l) => l.startsWith("delivery notes unlocked"))?.split("|")[1]})`;
  });

  await step(21, "dln-second-run-refused", [19], async () => {
    const markers = () => sql<{ n: number }>("select count(*)::int n from security_audit.audit_log where organization_id = $1 and entity_table = 'doc_counters' and action = 'DLN_COUNTER_SET'", [org]);
    expect(await markers()).toEqual([{ n: 1 }]);
    const again = dlnStep("set", t.slug, LAST_PAD);
    expect(again.code).not.toBe(0);
    expect(again.out).toMatch(/DLN step refused: it has already been run/);
    const higher = dlnStep("set", t.slug, "5000");
    expect(higher.code).not.toBe(0);
    expect(higher.out).toMatch(/already been run/);
    expect(await sql("select last from public.doc_counters where organization_id = $1 and prefix = 'DLN'", [org])).toEqual([{ last: 4521 }]);
    expect(await markers()).toEqual([{ n: 1 }]);
    return `second run (4521) and a different number (5000) both refused, exit ${again.code}/${higher.code}: "${(/DLN step refused[^\n.]*/.exec(again.out) ?? [""])[0]}"; counter still 4521, one DLN_COUNTER_SET marker`;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  await step(22, "quote-costing-line", [17], async () => {
    await office.goto("/quotes");
    await office.getByRole("button", { name: "New quote" }).first().click();
    const builder = office.getByRole("dialog", { name: "Quote Builder" });
    await builder.getByRole("combobox").first().selectOption({ label: customerA });
    const panel = builder.getByText("Price from costing engine").locator("xpath=..");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Part").selectOption(String(COSTING_PART.id));
    await panel.getByLabel("Quantity").fill("3");
    await panel.getByRole("button", { name: "Calculate" }).click();
    await panel.getByRole("button", { name: /Add to quote/ }).click();
    const description = `${COSTING_PART.part_number} · ${COSTING_PART.description} · EN1A`;
    await expect(builder.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(description);
    await expect(builder.getByRole("spinbutton", { name: "Unit price" })).toHaveValue("33.34");
    await builder.getByRole("button", { name: "Save Quote" }).click();
    await expect(builder).toBeHidden();
    const quote = (await service.from("quotes").select("id, quote_ref, status, total_value").eq("organization_id", org).eq("customer", customerA).single()).data!;
    const lines = (await service.from("quote_line_items").select("description, quantity, unit_price, vat_pct, source").eq("quote_id", quote.id)).data!;
    expect(lines.map((l) => [l.description, Number(l.quantity), pence(l.unit_price), Number(l.vat_pct), l.source])).toEqual([[description, 3, 3334, 20, "costing_engine"]]);
    expect({ status: quote.status, total: pence(quote.total_value) }).toEqual({ status: "draft", total: 12002 });
    const calls = (await (await fetch(`http://127.0.0.1:${COSTING_PORT}/__calls`)).json()) as { path: string; tokenOk: boolean; org: string | null }[];
    expect(calls.some((c) => c.path === "/api/quotes/calculate-detailed" && c.tokenOk && c.org === org)).toBe(true);
    st.quoteId = quote.id; st.quoteRef = quote.quote_ref; st.description = description;
    return `office: ${quote.quote_ref} with the costing panel's line "${description}" 3 x 33.335 -> 33.34 (half away from zero), source costing_engine, draft total ${gbp(12002)} (100.02 + 20.00 VAT); the engine was called through /api/costing with the company id`;
  });

  await step(23, "quote-to-job", [22], async () => {
    await admin.goto("/quotes");
    const draftCard = admin.getByRole("region", { name: "Draft quotes" }).locator('[data-slot="card"]', { hasText: customerA });
    const download = admin.waitForEvent("download");
    await draftCard.getByRole("button", { name: "Send", exact: true }).click();
    await confirmSend(admin);
    await download;
    await admin.getByRole("dialog", { name: /gone to the customer\?/ }).getByRole("button", { name: /sent it/ }).click();
    await expect.poll(async () => (await service.from("quotes").select("status").eq("id", st.quoteId).single()).data?.status).toBe("sent");
    await admin.reload();
    await admin.getByRole("region", { name: "Sent quotes" }).locator('[data-slot="card"]', { hasText: customerA }).getByRole("button", { name: "View" }).click();
    const details = admin.getByRole("dialog", { name: `${st.quoteRef} quote details` });
    await details.getByRole("button", { name: "Mark Accepted" }).click();
    await admin.getByRole("dialog", { name: `Mark ${st.quoteRef} as accepted?` }).getByLabel("Customer PO (optional)").fill(customerPo);
    await admin.getByRole("button", { name: "Confirm Accepted" }).click();
    await expect.poll(async () => (await service.from("quotes").select("status").eq("id", st.quoteId).single()).data?.status).toBe("accepted");
    await expect.poll(async () => ((await service.from("sales_orders").select("id").eq("quote_id", st.quoteId)).data ?? []).length).toBe(1);
    const order = (await service.from("sales_orders").select("id, total_value, customer_po").eq("quote_id", st.quoteId).single()).data!;
    await expect.poll(async () => ((await service.from("jobs").select("id").eq("converted_from_sales_order_id", order.id)).data ?? []).length).toBe(1);
    const job = (await service.from("jobs").select("id, job_no, quantity_required").eq("converted_from_sales_order_id", order.id).single()).data!;
    expect({ po: order.customer_po, net: pence(order.total_value), qty: job.quantity_required }).toEqual({ po: customerPo, net: 10002, qty: 3 });
    st.orderId = order.id; st.jobId = job.id; st.jobNo = job.job_no;
    return `admin sent ${st.quoteRef} (PDF downloaded, confirmed), customer accepted with PO ${customerPo}: sales order at net ${gbp(10002)}, job ${job.job_no} x 3 made automatically`;
  });

  await step(24, "job-finish-inspect", [23], async () => {
    await admin.goto("/jobs");
    await confirmFinish(admin, admin.getByRole("row").filter({ hasText: st.jobNo }).getByRole("button", { name: "Finish", exact: true }));
    await admin.getByRole("button", { name: /^Waiting for inspection/ }).click();
    await admin.getByRole("row").filter({ hasText: st.jobNo }).getByRole("button", { name: "Inspected", exact: true }).click();
    const inspection = admin.getByRole("dialog", { name: `Record inspection: ${st.jobNo}` });
    await inspection.getByLabel("Acceptance criteria (required)").fill("Drawing SMK-100: length 60.00 +/-0.1");
    await inspection.getByLabel("Measured notes (required)").fill("Length 60.02 mm on all three");
    await inspection.getByLabel(/Reason you are inspecting it yourself/).fill("Sole inspector on site for the smoke run");
    await inspection.getByRole("button", { name: "Record inspection" }).click();
    await expect(admin.getByText(`${st.jobNo} inspected: Complete`)).toBeVisible();
    const job = (await service.from("jobs").select("stage, finished_at, inspected_at").eq("id", st.jobId).single()).data!;
    expect(Boolean(job.finished_at && job.inspected_at)).toBe(true);
    return `admin: ${st.jobNo} finished, then inspected (own work, reason recorded): Complete (stage ${job.stage})`;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  await step(25, "dln-from-sales-order", [20, 24], async () => {
    await office.goto("/delivery-notes");
    await office.getByRole("button", { name: "New delivery note" }).first().click();
    const form = office.getByRole("dialog", { name: "New Delivery Note" });
    await form.getByRole("button", { name: "From a sales order" }).click();
    await form.getByLabel("Sales order").selectOption({ label: `${customerPo} - ${customerA}` });
    await expect(form.getByLabel(`Quantity to despatch: ${st.description}`)).toHaveValue("3");
    await form.getByRole("button", { name: "Save Delivery Note" }).click();
    await expect(form).toBeHidden();
    const note = (await service.from("delivery_notes").select("id, dn_number, sales_order_id, job_ref, status").eq("organization_id", org).eq("customer", customerA).single()).data!;
    expect({ dn: note.dn_number, order: note.sales_order_id, job: note.job_ref }).toEqual({ dn: "DLN-4522", order: st.orderId, job: st.jobNo });
    st.soNoteId = note.id;
    // Workshop works the note: marks it despatched (and is offered no e-mail control: step 36 checks the send route).
    const workshop = await asUser(browser, t.users.workshop);
    await workshop.goto("/delivery-notes");
    const row = workshop.getByRole("row").filter({ hasText: "DLN-4522" });
    await expect(row.getByRole("button", { name: "Email Customer" })).toHaveCount(0);
    await row.getByRole("button", { name: "Mark Despatched" }).click();
    await expect.poll(async () => (await service.from("delivery_notes").select("status").eq("id", note.id).single()).data?.status).toBe("despatched");
    await workshop.context().close();
    return `office: from sales order ${customerPo}, 3 of "${st.description}": ${note.dn_number} (the pad's 4521 + 1), linked to the order and ${st.jobNo}; workshop marked it despatched`;
  });

  await step(26, "dln-job-without-order", [25], async () => {
    const card = await openJobCard(office, noOrderJob);
    await card.getByRole("button", { name: "Delivery note", exact: true }).click();
    const dialog = office.getByRole("dialog", { name: `Delivery note - ${noOrderJob}` });
    await expect(dialog.getByLabel("Customer")).toHaveValue(st[`cust:${customerN}`]);
    await dialog.getByLabel("Description 1").fill("Spacer 10mm");
    await dialog.getByLabel("Quantity 1").fill("4");
    await dialog.getByRole("button", { name: "Save Delivery Note" }).dblclick();
    await expect(office.getByText(/Delivery note DLN-\d+ created/)).toBeVisible();
    const notes = (await service.from("delivery_notes").select("id, dn_number, job_id, customer_id, sales_order_id").eq("job_id", st.noOrderJobId)).data!;
    expect(notes.map((n) => ({ dn: n.dn_number, customer: n.customer_id, order: n.sales_order_id }))).toEqual([{ dn: "DLN-4523", customer: st[`cust:${customerN}`], order: null }]);
    expect(await sql("select last from public.doc_counters where organization_id = $1 and prefix = 'DLN'", [org])).toEqual([{ last: 4523 }]);
    st.noOrderNoteId = notes[0].id;
    return `office: job card Delivery note for ${noOrderJob} (no sales order, release 147's create_job_delivery_note), double click: one note, DLN-4523, linked to the job and the customer by key; counter 4523`;
  });

  await step(27, "dln-print-sheet", [25, 26], async () => {
    const out: string[] = [];
    for (const [id, dn] of [[st.soNoteId, "DLN-4522"], [st.noOrderNoteId, "DLN-4523"]]) {
      await office.goto(`/delivery-notes/${id}/print`);
      await expect(office.getByText(dn).first()).toBeVisible();
      await expect(office.getByTestId("dn-goods-out")).toHaveText(GOODS_OUT);
      await expect(office.getByTestId("dn-received")).toHaveText(/Received by: _+ Signature: _+ Date: _+/);
      await office.emulateMedia({ media: "print" });
      await expect(office.getByTestId("dn-goods-out")).toBeVisible();
      await expect(office.getByTestId("dn-received")).toBeVisible();
      await office.emulateMedia({ media: "screen" });
      out.push(dn);
    }
    return `print sheets of ${out.join(" and ")}: "${GOODS_OUT}" and the Received by / Signature / Date line, on screen and in print media`;
  });

  await step(28, "dln-pdf-download", [25], async () => {
    await office.goto("/delivery-notes");
    await office.getByRole("row").filter({ hasText: "DLN-4522" }).getByRole("button", { name: "View" }).click();
    const detail = office.getByRole("dialog", { name: "DLN-4522" });
    const download = office.waitForEvent("download");
    await detail.getByRole("button", { name: "Download PDF" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("delivery-note-DLN-4522.pdf");
    const bytes = readFileSync((await file.path())!);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = pdfText(bytes);
    for (const want of ["DLN-4522", GOODS_OUT, RECEIVED_BLANK]) expect(text, `PDF text lacks "${want}"`).toContain(want);
    await office.keyboard.press("Escape");
    return `${file.suggestedFilename()} (${bytes.length} bytes, %PDF-): its text has DLN-4522, the goods-out wording and the Received by / Signature line`;
  });

  await step(29, "dln-email", [25], async () => {
    const to = emailOf(customerA);
    const before = (await recordedMail()).length;
    await office.goto("/delivery-notes");
    await office.getByRole("row").filter({ hasText: "DLN-4522" }).getByRole("button", { name: "Email Customer" }).click();
    await office.getByRole("dialog", { name: "Email delivery note" }).getByRole("button", { name: "Send now" }).click();
    const send = office.getByRole("dialog", { name: "Send by e-mail" });
    const toBox = send.getByLabel("To", { exact: true });
    const prefilled = await toBox.inputValue();
    if (!prefilled) await toBox.fill(to);
    await expect(send.getByLabel(/^Attach /)).toBeChecked();
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send.getByRole("status")).toHaveText("Sent");
    await expect.poll(async () => (await recordedMail()).slice(before).filter((m) => mailTo(m, to)).length).toBe(1);
    const mail = (await recordedMail()).slice(before).find((m) => mailTo(m, to))!;
    const attachments = ((mail.body as { attachments?: { filename?: string; content?: unknown }[] }).attachments ?? []);
    expect(attachments.map((a) => a.filename)).toEqual(["delivery-note-DLN-4522.pdf"]);
    const bytes = attachmentBytes(attachments[0].content);
    let pdfNote = "attachment bytes not readable from the mock's record";
    if (bytes) {
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdfText(bytes)).toContain(GOODS_OUT);
      pdfNote = `attachment ${bytes.length} bytes, %PDF-, goods-out wording in it`;
    }
    await expect.poll(async () => (await service.from("email_history").select("status, to_email").eq("related_to_id", st.soNoteId)).data).toEqual([{ status: "sent_via_system", to_email: to }]);
    await expect.poll(async () => Boolean((await service.from("delivery_notes").select("emailed_at").eq("id", st.soNoteId).single()).data?.emailed_at)).toBe(true);
    return `office: Email Customer > Send now > Send: one e-mail to ${to} in the test sink (Resend mock) with delivery-note-DLN-4522.pdf (${pdfNote}); To ${prefilled ? "prefilled" : "typed (the note had no customer e-mail on it)"}; history sent_via_system; note stamped e-mailed`;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  await step(30, "invoice-issue", [24], async () => {
    const counter = (await sql<{ last: number }>("select coalesce(max(last), 0)::int as last from public.doc_counters where organization_id = $1 and prefix = 'INV'", [org]))[0].last;
    const ref = `INV-${String(counter + 1).padStart(4, "0")}`;
    await admin.goto("/invoices");
    const draftRow = admin.getByRole("row").filter({ hasText: customerA });
    await expect(draftRow.getByTestId("draft-job-stage")).toHaveText("Ready to issue");
    const invoice = async () => (await service.from("invoices").select("id, invoice_ref, status, subtotal, vat, total").eq("organization_id", org).eq("customer", customerA).single()).data!;
    const drafted = await invoice();
    expect({ ref: drafted.invoice_ref, status: drafted.status, sub: pence(drafted.subtotal), vat: pence(drafted.vat), total: pence(drafted.total) }).toEqual({ ref: null, status: "draft", sub: 10002, vat: 2000, total: 12002 });
    await draftRow.getByRole("button", { name: "View" }).click();
    await admin.getByRole("dialog", { name: /invoice details/ }).getByRole("button", { name: "Issue Invoice" }).click();
    await admin.getByRole("dialog", { name: `Issue this invoice to ${customerA}?` }).getByRole("button", { name: "Issue Invoice" }).click();
    await expect.poll(async () => (await invoice()).invoice_ref).toBe(ref);
    expect((await invoice()).status).toBe("issued");
    st.invoiceId = drafted.id; st.invoiceRef = ref;
    await admin.keyboard.press("Escape");
    return `admin issued the job's draft (made at Finish, "Ready to issue" once Complete) as ${ref}: net ${gbp(10002)}, VAT ${gbp(2000)} (20.004 rounded), total ${gbp(12002)}`;
  });

  await step(31, "payment", [30], async () => {
    await office.goto("/invoices");
    const row = () => office.getByRole("row").filter({ hasText: st.invoiceRef });
    await row().getByRole("button", { name: "Record payment" }).click();
    const pay = office.getByRole("dialog", { name: `Record a payment on ${st.invoiceRef}` });
    await expect(pay.getByLabel("Amount received")).toHaveValue("120.02");
    await pay.getByLabel("Amount received").fill("50");
    await pay.getByRole("button", { name: "Save payment" }).click();
    await expect(pay).toBeHidden();
    await expect(row()).toContainText("£50.00 paid, £70.02 still owed");
    await row().getByRole("button", { name: "Record payment" }).click();
    const rest = office.getByRole("dialog", { name: `Record a payment on ${st.invoiceRef}` });
    await expect(rest.getByLabel("Amount received")).toHaveValue("70.02");
    await rest.getByRole("button", { name: "Save payment" }).click();
    await expect(office.getByText(`${st.invoiceRef} paid in full`)).toBeVisible();
    const paid = (await service.from("invoices").select("status, amount_paid, total").eq("id", st.invoiceId).single()).data!;
    const payments = (await service.from("invoice_payments").select("amount").eq("invoice_id", st.invoiceId).order("created_at")).data!;
    expect({ status: paid.status, paid: pence(paid.amount_paid), rows: payments.map((p) => pence(p.amount)) }).toEqual({ status: "paid", paid: 12002, rows: [5000, 7002] });
    return `office: ${st.invoiceRef} part payment £50.00 ("£70.02 still owed"), then the rest £70.02: paid, payments sum ${gbp(12002)} = total`;
  });

  await step(32, "invoice-penny-tie", [17], async () => {
    const po = `TIE-${tag}`;
    await office.goto("/invoices");
    await office.getByRole("button", { name: /New invoice/ }).first().click();
    const dialog = office.getByRole("dialog", { name: "Create Invoice" });
    await dialog.getByRole("combobox").first().selectOption({ label: customerT });
    await dialog.getByPlaceholder("Customer PO", { exact: true }).fill(po);
    await dialog.getByLabel("Due date").fill(ukDatePlus(3));
    await dialog.getByRole("textbox", { name: "Description" }).fill("Shim");
    await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("1.5");
    await dialog.getByRole("spinbutton", { name: "Unit price (ex VAT)" }).fill("0.09");
    for (const [n, what] of [[2, "Washer"], [3, "Spacer"]] as const) {
      await dialog.getByRole("button", { name: "Add another line" }).click();
      await dialog.getByRole("textbox", { name: `Line ${n} description` }).fill(what);
      await dialog.getByRole("spinbutton", { name: `Line ${n} quantity` }).fill("1");
      await dialog.getByRole("spinbutton", { name: `Line ${n} unit price` }).fill("0.03");
    }
    await expect(dialog.getByText("£0.25").first()).toBeVisible();
    await dialog.getByRole("button", { name: "Save Invoice" }).click();
    await expect(dialog).toBeHidden();
    const inv = (await service.from("invoices").select("id, subtotal, vat, total, status, due_date").eq("organization_id", org).eq("customer_po", po).single()).data!;
    const lines = (await service.from("invoice_line_items").select("description, quantity, unit_price, vat_pct").eq("invoice_id", inv.id).order("position")).data!;
    expect(lines.map((l) => [l.description, Number(l.quantity), pence(l.unit_price), Number(l.vat_pct)])).toEqual([["Shim", 1.5, 9, 20], ["Washer", 1, 3, 20], ["Spacer", 1, 3, 20]]);
    // Line nets 0.135 -> 0.14, 0.03, 0.03 = 0.20; VAT per line 0.028 -> 0.03, 0.006 -> 0.01, 0.01 = 0.05 (on the 0.20 total it would be 0.04).
    const lineMoney = await sql<{ net: string; vat: string }>("select round(quantity * unit_price, 2)::text as net, round(round(quantity * unit_price, 2) * vat_pct / 100, 2)::text as vat from public.invoice_line_items where invoice_id = $1 order by position", [inv.id]);
    expect(lineMoney).toEqual([{ net: "0.14", vat: "0.03" }, { net: "0.03", vat: "0.01" }, { net: "0.03", vat: "0.01" }]);
    expect({ sub: pence(inv.subtotal), vat: pence(inv.vat), total: pence(inv.total), due: String(inv.due_date).slice(0, 10) }).toEqual({ sub: 20, vat: 5, total: 25, due: ukDatePlus(3) });
    await admin.goto("/invoices");
    await admin.getByRole("row").filter({ hasText: customerT }).getByRole("button", { name: "View" }).click();
    await admin.getByRole("dialog", { name: /invoice details/ }).getByRole("button", { name: "Issue Invoice" }).click();
    await admin.getByRole("dialog", { name: `Issue this invoice to ${customerT}?` }).getByRole("button", { name: "Issue Invoice" }).click();
    await expect.poll(async () => (await service.from("invoices").select("status").eq("id", inv.id).single()).data?.status).toBe("issued");
    const issued = (await service.from("invoices").select("invoice_ref, subtotal, vat, total").eq("id", inv.id).single()).data!;
    expect([pence(issued.subtotal), pence(issued.vat), pence(issued.total)]).toEqual([20, 5, 25]);
    await admin.keyboard.press("Escape");
    st.tieId = inv.id; st.tieRef = issued.invoice_ref;
    return `office drafted, admin issued ${issued.invoice_ref}: 1.5 x 0.09 = 0.135 -> 0.14, 2 x 0.03; VAT per line 0.03 + 0.01 + 0.01 = 0.05 (not 0.04 on the total); total 0.25, due in 3 days`;
  });

  await step(33, "chase-pass-drafts-only", [32], async () => {
    await admin.goto("/settings");
    const steps = admin.getByTestId("chase-steps");
    await expect(steps).toBeVisible();
    const saved = admin.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/rpc/save_chase_steps_atomic") && r.request().method() === "POST");
    await steps.getByRole("button", { name: "Save chase steps" }).click();
    expect((await saved).status()).toBe(200);
    await expect(admin.getByText("Chase steps saved.", { exact: true }).first()).toBeVisible();
    const runAt = new Date(Date.now() + 3_000).toISOString();
    expect((await service.from("email_schedules").insert({ organization_id: org, kind: "invoice_reminder", enabled: true, frequency: "once", run_at: runAt, time_of_day: "08:00" })).error).toBeNull();
    await admin.waitForTimeout(4_000);
    const to = emailOf(customerT);
    const before = (await recordedMail()).length;
    const response = await admin.request.get("/api/cron/daily", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
    expect(response.status()).toBe(200);
    expect((await response.json()).emailSchedules).not.toHaveProperty("error");
    const sends = (await service.from("chase_sends").select("invoice_id, offset_days, tone, status").eq("organization_id", org)).data ?? [];
    expect(sends).toEqual([{ invoice_id: st.tieId, offset_days: -3, tone: "before_due", status: "drafted" }]);
    expect((await service.from("email_history").select("status, to_email").eq("related_to_id", st.tieId)).data).toEqual([{ status: "drafted", to_email: to }]);
    expect((await recordedMail()).slice(before).filter((m) => mailTo(m, to))).toEqual([]);
    return `admin saved the chase steps; the scheduled pass (/api/cron/daily) made ONE draft (${st.tieRef}, 3 days before due, before_due) and e-mailed nothing; the paid ${st.invoiceRef} was not chased`;
  });

  await step(34, "account-balance", [31, 32], async () => {
    const ledger = await sql<{ customer: string; owed: string }>(
      `select customer, sum(total - amount_paid - credited_amount + coalesce(refunded_amount, 0))::text as owed from public.invoices
       where organization_id = $1 and status not in ('draft', 'cancelled', 'void') group by customer order by customer`, [org]);
    expect(ledger).toEqual([{ customer: customerA, owed: "0.00" }, { customer: customerT, owed: "0.25" }]);
    await office.goto("/invoices");
    await expect(office.getByText("Across 1 outstanding invoice", { exact: true })).toBeVisible();
    await expect(office.getByText("£0.25").first()).toBeVisible();
    await expect(office.getByRole("row").filter({ hasText: st.invoiceRef })).toContainText(/paid/i);
    knownGap("customer-statement", "no customer statement document or Statement action at 31f965e (none on Customers or Invoices; grep finds no statement feature): the account is checked here as the money owed per customer on the invoices list and in the ledger, to the penny");
    return `ledger per customer: ${customerA} £0.00 (paid in full), ${customerT} £0.25; Invoices shows "Across 1 outstanding invoice" and £0.25 (statement document: KNOWN GAP)`;
  });

  await step(35, "search", [22, 32], async () => {
    const box = office.getByTestId("global-search-input");
    await office.goto("/dashboard");
    await box.fill(customerA);
    await expect(office.getByTestId("global-search-group-quotes")).toContainText(st.quoteRef);
    await box.fill(st.tieRef);
    const invoices = office.getByTestId("global-search-group-invoices");
    await expect(invoices).toContainText(st.tieRef);
    await invoices.getByTestId("global-search-result").first().click();
    await expect(office).toHaveURL(/\/invoices/);
    await expect(office.getByRole("dialog", { name: /invoice details/ })).toContainText(st.tieRef);
    await office.keyboard.press("Escape");
    return `office: the top-bar search finds ${st.quoteRef} by its customer and opens ${st.tieRef} by its number`;
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  const refusedBefore = await checksums(org);
  await step(36, "workshop-no-money", [30], async () => {
    const workshop = await asUser(browser, t.users.workshop);
    for (const p of ["/invoices", "/quotes", "/customers", "/sales-orders", "/purchase-orders"]) {
      await workshop.goto(p);
      await expect(workshop, `workshop ${p}`).toHaveURL(/\/dashboard/);
    }
    const send = await workshop.request.post("/api/email/send", {
      headers: { origin: new URL(workshop.url()).origin },
      data: { kind: "invoice", record_id: st.invoiceId, to: [emailOf(customerA)], subject: "Refused", text: "Synthetic.", idempotency_key: `smoke-ws-${t.run}` },
    });
    expect(send.status()).toBe(403);
    const api = await signedInClient(t.users.workshop);
    const read = await api.from("invoices").select("id").eq("organization_id", org);
    await workshop.goto("/jobs");
    await expect(workshop).toHaveURL(/\/jobs$/);
    await workshop.context().close();
    return `workshop: invoices, quotes, customers, sales orders, purchase orders go to the dashboard; the send route answers 403; invoices through the API: ${read.error ? `refused (${read.error.code})` : `${read.data?.length ?? 0} rows`}; /jobs opens`;
  });

  await step(37, "viewer-cannot-edit", [26], async () => {
    const viewer = await asUser(browser, t.users.viewer);
    await viewer.goto("/jobs");
    await expect(viewer).toHaveURL(/\/jobs$/);
    await viewer.getByRole("button", { name: /^Complete \(/ }).click();
    await expect(viewer.getByText(noOrderJob).first()).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Delivery note", exact: true })).toHaveCount(0);
    for (const p of ["/invoices", "/quotes", "/delivery-notes"]) {
      await viewer.goto(p);
      await expect(viewer, `viewer ${p}`).toHaveURL(/\/dashboard/);
    }
    const api = await signedInClient(t.users.viewer);
    const made = await api.rpc("create_job_delivery_note", {
      p_job: st.noOrderJobId, p_customer: st[`cust:${customerN}`], p_request: randomUUID(), p_ship_date: ukDatePlus(0), p_tax_date: ukDatePlus(0), p_ship_via: null, p_notes: null,
      p_lines: [{ description: "Spacer", quantity: 1 }],
    });
    expect(made.error?.code).toBe("42501");
    const edit = await api.from("jobs").update({ description: "Viewer edit" }).eq("id", st.noOrderJobId).select("id");
    expect(edit.error !== null || (edit.data ?? []).length === 0).toBe(true);
    const cust = await api.from("customers").update({ email: "viewer@example.test" }).eq("id", st[`cust:${customerA}`]).select("id");
    expect(cust.error !== null || (cust.data ?? []).length === 0).toBe(true);
    await viewer.context().close();
    return `viewer: /jobs opens with no Delivery note button; invoices, quotes, delivery notes go to the dashboard; create_job_delivery_note 42501; a job edit and a customer edit change ${edit.error ? `nothing (${edit.error.code})` : "0 rows"} / ${cust.error ? `nothing (${cust.error.code})` : "0 rows"}`;
  });

  await step(38, "outsider-sees-nothing", [26, 30], async () => {
    const outsider = w.tenants.beta.users.admin;
    const api = await signedInClient(outsider);
    const seen: Record<string, number> = {};
    for (const table of ["customers", "quotes", "jobs", "invoices", "delivery_notes", "invoice_payments"]) {
      const r = await api.from(table).select("id").eq("organization_id", org);
      seen[table] = r.error ? -1 : (r.data ?? []).length;
    }
    expect(Object.values(seen).every((n) => n === 0 || n === -1)).toBe(true);
    const made = await api.rpc("create_job_delivery_note", {
      p_job: st.noOrderJobId, p_customer: st[`cust:${customerN}`], p_request: randomUUID(), p_ship_date: ukDatePlus(0), p_tax_date: ukDatePlus(0), p_ship_via: null, p_notes: null,
      p_lines: [{ description: "Spacer", quantity: 1 }],
    });
    expect(made.error).not.toBeNull();
    const page = await asUser(browser, outsider);
    await page.getByTestId("global-search-input").fill(customerA);
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("global-search-group-quotes")).toHaveCount(0);
    await page.goto(`/invoices?invoice=${st.invoiceId}`);
    await expect(page.getByRole("dialog", { name: new RegExp(`${escapeRe(st.invoiceRef)} invoice details`) })).toHaveCount(0);
    await page.context().close();
    return `another company's admin: 0 of this company's customers, quotes, jobs, invoices, delivery notes, payments (${JSON.stringify(seen)}); its job "${made.error?.code} ${made.error?.message?.slice(0, 30)}"; search and a pasted invoice link show nothing`;
  });

  await step(39, "refusals-leave-data-unchanged", [36, 37, 38], async () => {
    const after = await checksums(org);
    const changed = Object.keys(after).filter((k) => after[k] !== refusedBefore[k]);
    expect(changed).toEqual([]);
    return `md5 of every row of ${BUSINESS.length} business tables of the company identical before and after the refused workshop, viewer and outsider actions`;
  });

  await office.context().close();
  await admin.context().close();
  expect(failed(), `failed smoke steps: ${failed().join(", ")} (see the SMOKE lines)`).toEqual([]);
});
