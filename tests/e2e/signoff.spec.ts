/**
 * Operator sign-off (M4, migration 045) in the browser: a finished job is signed with a drawn signature against its current revision;
 * an edit afterwards shows "edited since: sign again"; signing again (typed) signs the new revision; the history lists each revision's
 * signatures with a hash prefix; print shows the current sign-off; offline the signature is kept on the device ("Pending upload") and
 * uploads when the connection is back, or is held as a conflict when the revision changed meanwhile; a viewer sees history only.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function finishedJob(jobNo: string) {
  const { data, error } = await adminClient().from("jobs").insert({
    organization_id: w.tenants.beta.id, job_no: jobNo, customer: "Sign Co", description: "Bush", stage: "inspection",
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z",
  }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

/** A finished job waiting for inspection is listed under the Waiting for inspection tile, as tests/e2e/inspection.spec.ts opens it. */
async function openWorksheet(page: Page, jobNo: string) {
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: jobNo }).getByRole("button", { name: "Worksheet" }).click();
  const dialog = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  await expect(dialog.getByRole("button", { name: "Save Worksheet" })).toBeEnabled();
  return dialog;
}

const signed = async (id: string) => ((await adminClient().from("job_signoffs").select("worksheet_version, initials, signer_name, signature_kind, signature_data, snapshot_sha256").eq("job_id", id).order("created_at")).data ?? []);

test("sign off with a drawn signature, edit, sign again typed; history and print follow the current revision", async ({ page }) => {
  const jobNo = `J-SIGN-${w.runId}`;
  const id = await finishedJob(jobNo);
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo);
  const section = sheet.getByRole("region", { name: "Operator sign-off" });
  await expect(section.locator("[data-signoff-status]")).toHaveText("Not signed off");

  await section.getByLabel("Initials").fill("WB");
  await section.getByLabel("Signer name").fill("Will Barnes");
  const sign = section.getByRole("button", { name: "Sign off", exact: true });
  await expect(sign).toBeDisabled();
  const pad = section.getByLabel(/Signature pad/);
  // The pad sits below the fold of the worksheet dialog: scroll it into view first, or the pointer lands on the overlay and closes the dialog.
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 15, box.y + box.height / 2 + (i % 2 ? 12 : -12));
  await page.mouse.up();
  await expect(sign).toBeEnabled();
  await sign.click();
  await expect(section.locator('[data-signoff-status="signed"]')).toContainText("Signed off on revision 0 by WB (Will Barnes)");
  const [first] = await signed(id);
  expect(first).toMatchObject({ worksheet_version: 0, initials: "WB", signer_name: "Will Barnes", signature_kind: "drawn" });
  expect(first.signature_data).toMatch(/^M\d+ \d+(L\d+ \d+)+$/);
  await expect(section.locator('[data-signoff-revision="0"]')).toContainText(`sha256 ${first.snapshot_sha256.slice(0, 12)}`);

  // An edit makes revision 1: the sign-off stays with revision 0 and the sheet asks for a new one.
  await sheet.getByLabel("Drawing #").fill("DWG-SIGN-2");
  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  await expect(page.getByText("Worksheet saved")).toBeVisible();
  await expect(section.locator('[data-signoff-status="stale"]')).toHaveText(/Signed off on revision 0 by WB on .*; edited since \(now revision 1\): sign again\./);

  await page.goto(`/jobs/${id}/print`);
  await expect(page.locator('[data-signoff="unsigned"]')).toContainText("NOT SIGNED OFF (revision 0 was signed; edited since)");

  // Sign again, typed, on revision 1.
  const again = await openWorksheet(page, jobNo);
  const section2 = again.getByRole("region", { name: "Operator sign-off" });
  await section2.getByLabel("Initials").fill("WB");
  await section2.getByLabel("Signer name").fill("Will Barnes");
  await section2.getByRole("button", { name: "Type instead" }).click();
  await section2.getByLabel("Typed signature").fill("Will Barnes");
  await section2.getByRole("button", { name: "Sign off", exact: true }).click();
  await expect(section2.locator('[data-signoff-status="signed"]')).toContainText("Signed off on revision 1 by WB");
  const rows = await signed(id);
  expect(rows.map((r) => [r.worksheet_version, r.signature_kind])).toEqual([[0, "drawn"], [1, "typed"]]);
  await expect(section2.locator('[data-signoff-revision="1"]')).toContainText(`sha256 ${rows[1].snapshot_sha256.slice(0, 12)}`);
  await expect(section2.locator('[data-signoff-revision="0"]')).toContainText(`sha256 ${rows[0].snapshot_sha256.slice(0, 12)}`);

  await page.goto(`/jobs/${id}/print`);
  await expect(page.locator('[data-signoff="signed"]')).toContainText(`WB Will Barnes (signed `);
  await expect(page.locator('[data-signoff="signed"]')).toContainText(`revision 1, sha256 ${rows[1].snapshot_sha256.slice(0, 12)}`);
});

test("one primary signature per revision, then an inspector co-signature by someone else; banner and print list both", async ({ page }) => {
  const jobNo = `J-SIGNC-${w.runId}`;
  const id = await finishedJob(jobNo);
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo);
  const section = sheet.getByRole("region", { name: "Operator sign-off" });
  await section.getByLabel("Initials").fill("WB");
  await section.getByLabel("Signer name").fill("Will Barnes");
  await section.getByRole("button", { name: "Type instead" }).click();
  await section.getByLabel("Typed signature").fill("Will Barnes");
  await section.getByRole("button", { name: "Sign off", exact: true }).click();
  await expect(section.locator('[data-signoff-status="signed"]')).toContainText("Signed off on revision 0 by WB (Will Barnes)");
  // The primary signer gets no second form: the primary is taken and the co-signature is someone else's.
  await expect(section.getByRole("button", { name: "Sign off", exact: true })).toHaveCount(0);
  await expect(section.locator("[data-signoff-form]")).toHaveCount(0);
  await expect(section.locator("[data-signoff-cosign-own]")).toContainText("the inspector co-signature is added by someone else");

  const admin = await page.context().browser()!.newPage();
  await signIn(admin, w.tenants.beta.users.admin);
  const adminSheet = await openWorksheet(admin, jobNo);
  const adminSection = adminSheet.getByRole("region", { name: "Operator sign-off" });
  await expect(adminSection.locator('[data-signoff-status="signed"]')).toContainText("by WB");
  await expect(adminSection.getByRole("button", { name: "Sign off", exact: true })).toHaveCount(0);
  await expect(adminSection.locator('[data-signoff-form="inspector"]')).toContainText("Add co-signature (inspector)");
  await adminSection.getByLabel("Initials").fill("IA");
  await adminSection.getByLabel("Signer name").fill("Inspector Ash");
  await adminSection.getByRole("button", { name: "Type instead" }).click();
  await adminSection.getByLabel("Typed signature").fill("Inspector Ash");
  await adminSection.getByRole("button", { name: "Add co-signature (inspector)" }).click();
  const banner = adminSection.locator('[data-signoff-status="signed"]');
  await expect(banner).toContainText("Signed off on revision 0 by WB (Will Barnes)");
  await expect(banner.locator('[data-signoff-cosign="inspector"]')).toContainText("Inspector co-signed by IA (Inspector Ash)");
  // Both roles are taken on this revision: no form is left.
  await expect(adminSection.locator("[data-signoff-form]")).toHaveCount(0);
  await expect(adminSection.locator('[data-signoff-revision="0"]')).toContainText("Inspector co-signature: IA (Inspector Ash)");
  const rows = (await adminClient().from("job_signoffs").select("kind, initials, worksheet_version").eq("job_id", id).order("created_at")).data;
  expect(rows).toEqual([{ kind: "primary", initials: "WB", worksheet_version: 0 }, { kind: "inspector", initials: "IA", worksheet_version: 0 }]);

  await admin.goto(`/jobs/${id}/print`);
  await expect(admin.locator('[data-signoff="signed"]')).toContainText("WB Will Barnes (signed ");
  await expect(admin.locator('[data-signoff="signed"] [data-signoff-cosign="inspector"]')).toContainText("Inspector co-signature: IA Inspector Ash");
  await admin.close();
});

async function goOffline(page: Page) {
  // Only the browser loses Supabase (as in tests/e2e/offline.spec.ts); the app server still reaches it.
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
}
async function goOnline(page: Page) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}
async function typedSignature(section: ReturnType<Page["getByRole"]>, initials: string, name: string) {
  await section.getByLabel("Initials").fill(initials);
  await section.getByLabel("Signer name").fill(name);
  await section.getByRole("button", { name: "Type instead" }).click();
  await section.getByLabel("Typed signature").fill(name);
}

test("offline: the signature is saved on the device as 'Pending upload', survives a reload, and uploads once when the connection is back", async ({ page }) => {
  const jobNo = `J-SIGNO-${w.runId}`;
  const id = await finishedJob(jobNo);
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo); // online once: the history and the revision are kept on the device
  const section = sheet.getByRole("region", { name: "Operator sign-off" });
  await expect(section.locator("[data-signoff-status]")).toHaveText("Not signed off");

  await goOffline(page);
  await typedSignature(section, "OF", "Olly Field");
  await section.getByRole("button", { name: "Sign off", exact: true }).click();
  await expect(page.getByText("Signed on this device: pending upload.")).toBeVisible();
  const pending = section.locator('[data-signoff-pending="waiting"]');
  await expect(pending).toContainText("OF (Olly Field)");
  await expect(pending).toContainText("revision 0");
  await expect(pending).toContainText("Pending upload");
  // Captured once: no second form for the same revision while it waits.
  await expect(section.getByRole("button", { name: "Sign off", exact: true })).toHaveCount(0);
  expect(await signed(id)).toEqual([]);

  // Durable: a reload while still offline opens the job from the device and the signature is still waiting.
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
  const again = await openWorksheet(page, jobNo);
  const section2 = again.getByRole("region", { name: "Operator sign-off" });
  await expect(section2.locator('[data-signoff-pending="waiting"]')).toContainText("Pending upload");

  await goOnline(page);
  await expect.poll(async () => (await signed(id)).map((r) => [r.worksheet_version, r.initials, r.signature_kind, r.signature_data])).toEqual([[0, "OF", "typed", "Olly Field"]]);
  await expect(section2.locator("[data-signoff-pending]")).toHaveCount(0);
  await expect(section2.locator('[data-signoff-status="signed"]')).toContainText("Signed off on revision 0 by OF (Olly Field)");
  // Sync again: the same client key, nothing new.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1000);
  expect(await signed(id)).toHaveLength(1);
});

test("offline: a signature whose revision changed before it uploaded is held as a conflict and shown as not uploaded; it is never attached to the new revision", async ({ page }) => {
  const jobNo = `J-SIGNS-${w.runId}`;
  const id = await finishedJob(jobNo);
  await signIn(page, w.tenants.beta.users.workshop);
  const sheet = await openWorksheet(page, jobNo);
  const section = sheet.getByRole("region", { name: "Operator sign-off" });
  await expect(section.locator("[data-signoff-status]")).toHaveText("Not signed off");
  await goOffline(page);
  await typedSignature(section, "OF", "Olly Field");
  await section.getByRole("button", { name: "Sign off", exact: true }).click();
  await expect(section.locator('[data-signoff-pending="waiting"]')).toContainText("Pending upload");

  // Meanwhile the office edits the worksheet: revision 1.
  expect((await adminClient().from("jobs").update({ drawing_no: "DWG-CHANGED" }).eq("id", id)).error).toBeNull();

  await goOnline(page);
  const failed = section.locator('[data-signoff-pending="failed"]');
  await expect(failed).toContainText(`Not uploaded: ${jobNo} changed after this signature was captured (it signed revision 0)`);
  // The offline notice (behind the worksheet dialog) lists it too, as a signature with the same reason.
  await page.keyboard.press("Escape");
  await expect(page.getByText("1 offline change needs attention")).toBeVisible();
  await page.getByText("1 offline change needs attention").click();
  await expect(page.locator('[data-offline-conflict="signoff"]')).toContainText("was not attached to the new revision");
  expect(await signed(id)).toEqual([]);
});

test("a viewer sees the history only", async ({ page }) => {
  const jobNo = `J-SIGNV-${w.runId}`;
  await finishedJob(jobNo);
  const viewer = page;
  await signIn(viewer, w.tenants.beta.users.viewer);
  await viewer.goto("/jobs");
  await viewer.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await viewer.getByRole("row").filter({ hasText: jobNo }).getByRole("button", { name: "Worksheet" }).click();
  const view = viewer.getByRole("dialog", { name: `Worksheet - ${jobNo}` }).getByRole("region", { name: "Operator sign-off" });
  await expect(view.locator("[data-signoff-status]")).toHaveText("Not signed off");
  await expect(view.getByRole("button", { name: "Sign off", exact: true })).toHaveCount(0);
});
