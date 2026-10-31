/**
 * Worksheet safety on the shop floor (audit B5: D5, D7, A12, D6). Unsaved edits are guarded; a save that would
 * overwrite someone else's is refused and the local edits stay; an unfinished job past its date shows overdue.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function newJob(jobNo: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Floor Co", ...extra }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

async function openWorksheet(page: Page, jobNo: string) {
  await page.goto("/jobs");
  await page.getByRole("row").filter({ hasText: jobNo }).getByRole("button", { name: "Worksheet" }).click();
  const dialog = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  await expect(dialog.getByRole("button", { name: "Save Worksheet" })).toBeEnabled();
  return dialog;
}

test("unsaved edits are guarded on close; saving clears the guard", async ({ page }) => {
  const jobNo = `J-WS-${w.runId}`;
  const id = await newJob(jobNo);
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo);
  await sheet.getByLabel("Drawing #").fill("DWG-77");
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("dialog", { name: "Discard unsaved worksheet changes?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(sheet.getByLabel("Drawing #")).toHaveValue("DWG-77");

  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  await expect(page.getByText("Worksheet saved")).toBeVisible();
  expect((await adminClient().from("jobs").select("drawing_no").eq("id", id).single()).data?.drawing_no).toBe("DWG-77");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(confirm).toBeHidden();
});

test("someone else saved first: the save is refused, local edits stay, their data is kept", async ({ page }) => {
  const jobNo = `J-WC-${w.runId}`;
  const id = await newJob(jobNo);
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo);
  await adminClient().from("jobs").update({ heat_cast_no: "THEIRS" }).eq("id", id); // another person's save
  await sheet.getByLabel("Heat / Cast #").fill("MINE");
  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  await expect(sheet.getByRole("alert").filter({ hasText: "Someone else saved this worksheet" })).toBeVisible();
  await expect(sheet.getByLabel("Heat / Cast #")).toHaveValue("MINE");
  expect((await adminClient().from("jobs").select("heat_cast_no").eq("id", id).single()).data?.heat_cast_no).toBe("THEIRS");
  await sheet.getByRole("button", { name: "Load their version (discards yours)" }).click();
  await expect(sheet.getByLabel("Heat / Cast #")).toHaveValue("THEIRS");
});

test("an unfinished job past its required date shows Late; due today doesn't", async ({ page }) => {
  const late = `J-LATE-${w.runId}`;
  const today = `J-TODAY-${w.runId}`;
  await newJob(late, { date_required: "2026-01-05", status: "on_track" });
  await newJob(today, { date_required: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()), status: "on_track" });
  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  await expect(page.getByRole("row").filter({ hasText: late })).toContainText(/Late/);
  await expect(page.getByRole("row").filter({ hasText: today })).not.toContainText(/Late/);
});

test("workshop pack: the selected jobs print together on one worksheet sheet", async ({ page }) => {
  const jobs = [`J-PK1-${w.runId}`, `J-PK2-${w.runId}`];
  for (const jobNo of jobs) await newJob(jobNo, { drawing_no: `DWG-${jobNo}`, heat_cast_no: `HEAT-${jobNo}` });
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/jobs");
  for (const jobNo of jobs) await page.getByRole("row").filter({ hasText: jobNo }).getByRole("checkbox").check();
  const [pack] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Print Workshop Pack" }).click()]);
  // P1 (D30-4): a company other than JNR prints the Basic pack by default; the JNR sheet is one pick away on the print page.
  await expect(pack.locator('[data-print-layout="basic"]')).toHaveCount(1);
  await expect(pack.getByText("JOB SHEETS", { exact: true })).toHaveCount(1);
  for (const jobNo of jobs) await expect(pack.getByText(jobNo, { exact: true })).toBeVisible();
  // Each job has a heat/cast no., so it is traceable (082) and Basic prints its traceability numbers.
  for (const jobNo of jobs) await expect(pack.locator("[data-traceability]").filter({ hasText: `HEAT-${jobNo}` })).toHaveCount(1);
  await expect(pack.getByLabel("Print layout")).toHaveValue("");
  await pack.getByLabel("Print layout").selectOption("jnr");
  await expect(pack.locator('[data-print-layout="basic"]')).toHaveCount(0);
  await expect(pack.getByText("(MULTI PART) WORKSHEET")).toHaveCount(1);
  for (const jobNo of jobs) {
    await expect(pack.getByText(jobNo, { exact: true })).toBeVisible();
    await expect(pack.getByText(`HEAT-${jobNo}`)).toBeVisible();
  }
  await pack.emulateMedia({ media: "print" });
  const pdf = (await pack.pdf({ preferCSSPageSize: true })).toString("latin1");
  expect(pdf.match(/\/Type\s*\/Page(?![s\w])/g)?.length).toBe(1);
});

test("workshop pack with no job selected says what to do instead of failing silently", async ({ page }) => {
  await newJob(`J-PK0-${w.runId}`);
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/jobs");
  await page.getByRole("button", { name: "Print Workshop Pack" }).click();
  await expect(page.getByText(/No jobs selected\. Tick the jobs to print/)).toBeVisible();
});

test("prints show the sign-off of the current revision only; an earlier revision's is not signed off; the old typed box prints as an earlier typed record (R5, M4)", async ({ page }) => {
  const signed = `J-SG-${w.runId}`;
  const stale = `J-ST-${w.runId}`;
  const legacy = `J-CL-${w.runId}`;
  const finished = { started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" };
  const signedId = await newJob(signed, finished);
  const staleId = await newJob(stale, finished);
  const legacyId = await newJob(legacy, { signed_off_by: "Old Name", signed_off_at: "2026-10-09T13:05:00Z" });
  const office = await signedInClient(w.tenants.beta.users.office);
  for (const id of [signedId, staleId]) {
    const revision = await office.rpc("job_signoff_revision", { p_job_id: id });
    expect(revision.error).toBeNull();
    const done = await office.rpc("sign_off_job", { p_job_id: id, p_expected_version: revision.data.worksheet_version, p_expected_snapshot_sha256: revision.data.snapshot_sha256, p_initials: "DS", p_signer_name: "Dave Signer", p_signed_on: "2026-10-09", p_signature_kind: "typed", p_signature_data: "Dave Signer" });
    expect(done.error).toBeNull();
  }
  expect((await adminClient().from("jobs").update({ drawing_no: "DWG-EDITED" }).eq("id", staleId)).error).toBeNull();
  await signIn(page, w.tenants.beta.users.admin);

  await page.goto(`/jobs/${signedId}/print`);
  await expect(page.locator('[data-signoff="signed"]')).toContainText(/DS Dave Signer \(signed 09\/10\/2026, revision 0, sha256 [0-9a-f]{12}\)/);
  await page.goto(`/jobs/${staleId}/print`);
  await expect(page.locator('[data-signoff="unsigned"]')).toContainText("NOT SIGNED OFF (revision 0 was signed; edited since)");
  await expect(page.locator('[data-signoff="signed"]')).toHaveCount(0);
  await page.goto(`/jobs/${legacyId}/print`);
  await expect(page.locator('[data-signoff="legacy"]')).toContainText(/^Signed off \(earlier typed record\): Old Name, 09\/10\/2026, \d\d:\d\d, no signature or hash$/);
  await expect(page.locator('[data-signoff="signed"]')).toHaveCount(0);
  await expect(page.locator('[data-signoff="unsigned"]')).toHaveCount(0);

  await page.goto(`/jobs/print?ids=${signedId},${staleId},${legacyId}`);
  await expect(page.locator('[data-signoff="signed"]')).toHaveCount(1);
  await expect(page.locator('[data-signoff="signed"]')).toContainText("DS Dave Signer");
  await expect(page.locator('[data-signoff="signed"]')).toContainText(/Signed 09\/10\/2026 \(rev 0, sha256 [0-9a-f]{12}\)/);
  await expect(page.locator('[data-signoff="unsigned"]')).toHaveCount(1);
  await expect(page.locator('[data-signoff="unsigned"]')).toContainText(/NOT SIGNED OFF\s*\(revision 0 was signed; edited since\)/); // the pack puts the reason on its own line
  await expect(page.locator('[data-signoff="legacy"]')).toHaveCount(1);
  await expect(page.locator('[data-signoff="legacy"]')).toContainText(/^Signed off \(earlier typed record\): Old Name, 09\/10\/2026, \d\d:\d\d, no signature or hash$/);
});

test("on a phone, the worksheet's Close button stays on screen at the bottom of a long worksheet, and closes it", async ({ page }) => {
  const jobNo = `J-CLOSE-${w.runId}`;
  await newJob(jobNo);
  await page.setViewportSize({ width: 390, height: 700 });
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo);
  const close = sheet.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeInViewport();
  const scrolled = await sheet.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
  expect(scrolled, "the worksheet is long enough to scroll on a phone").toBeGreaterThan(0);
  await expect(close).toBeInViewport();
  const box = await close.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  await close.click();
  await expect(sheet).toBeHidden();
});
