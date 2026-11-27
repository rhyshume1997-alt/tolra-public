/**
 * Drawings on the job and the cert pack (migration 034, W3), in the browser: a drawing carried over from the quote shows on the
 * worksheet with its revision, a newer revision replaces it, and a material certificate attached on the delivery note screen
 * stays with the job. A failed drawing metadata read blocks stale downloads and printing until retry.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);
// 1x1 PNG: the buckets accept image/png.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("a drawing carried from the quote shows its revision on the worksheet; a new revision replaces it", async ({ browser, page: workshopPage }) => {
  let page = workshopPage;
  const org = w.tenants.alpha.id;
  const no = `J-DWG-${tag()}`;
  const service = adminClient();
  const { data: job } = await service.from("jobs").insert({ organization_id: org, job_no: no, customer: "Drawing Co", description: "Bracket" }).select("id").single();
  const quotePath = `${org}/QUO-DWG-${tag()}/1-bracket.png`;
  expect((await service.storage.from("quote-attachments").upload(quotePath, PNG, { contentType: "image/png" })).error).toBeNull();
  const { data: row, error } = await service.from("job_files").insert({ organization_id: org, job_id: job!.id, kind: "drawing", ref: "bracket", file_name: "bracket.png", storage_bucket: "quote-attachments", storage_path: quotePath }).select("id").single();
  expect(error).toBeNull();

  // The workshop sees the drawing and its download, but approving a revision is for admins.
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Worksheet" }).click();
  await expect(page.getByRole("dialog", { name: `Worksheet - ${no}` }).getByText("bracket.png")).toBeVisible();
  await expect(page.getByLabel("Revision of bracket.png")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New revision" })).toHaveCount(0);

  // The admin, in a second browser, approves revisions.
  const adminContext = await browser.newContext();
  page = await adminContext.newPage();
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs");
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${no}` });
  await expect(sheet.getByText("bracket.png")).toBeVisible();

  // Set the revision of the carried drawing.
  await sheet.getByLabel("Revision of bracket.png").fill("B");
  await sheet.getByLabel("Revision of bracket.png").blur();
  await expect(page.getByText("bracket.png: revision B")).toBeVisible();
  await expect.poll(async () => (await service.from("job_files").select("revision").eq("id", row!.id).single()).data?.revision).toBe("B");

  // A newer revision replaces it: the latest is listed, the older one is named as replaced.
  await sheet.getByRole("button", { name: "New revision" }).click();
  await sheet.getByLabel("New revision label").fill("C");
  await sheet.getByLabel("New revision file").setInputFiles({ name: "bracket-C.png", mimeType: "image/png", buffer: PNG });
  await sheet.getByRole("button", { name: "Upload revision" }).click();
  await expect(page.getByText("bracket-C.png is now revision C")).toBeVisible();
  await expect(sheet.getByRole("listitem").filter({ hasText: "bracket-C.png" })).toContainText("RevC"); // a set revision is no longer editable
  await expect(sheet.getByText("(replaces B)")).toBeVisible();
  await expect(sheet.getByText("bracket.png", { exact: true })).toHaveCount(0);

  const rows = (await service.from("job_files").select("file_name, revision, superseded_at").eq("job_id", job!.id).order("created_at")).data!;
  expect(rows.map((r) => [r.file_name, r.revision, r.superseded_at !== null])).toEqual([["bracket.png", "B", true], ["bracket-C.png", "C", false]]);

  // After a reload the worksheet still shows only the latest revision.
  await page.reload();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Worksheet" }).click();
  const again = page.getByRole("dialog", { name: `Worksheet - ${no}` });
  await expect(again.getByRole("listitem").filter({ hasText: "bracket-C.png" })).toContainText("RevC");
  await expect(again.getByText("bracket.png", { exact: true })).toHaveCount(0);

  await service.storage.from("quote-attachments").remove([quotePath]);
});

test("a failed drawing metadata refresh removes stale downloads and blocks both print routes until retry", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const no = `J-DWG-FAIL-${tag()}`;
  const service = adminClient();
  const { data: jobs, error } = await service.from("jobs").insert([
    { organization_id: org, job_no: no, customer: "Drawing Co", description: "Bracket" },
    { organization_id: org, job_no: `J-DWG-EMPTY-${tag()}`, customer: "Drawing Co", description: "Empty drawing folder" },
  ]).select("id, job_no");
  expect(error).toBeNull();
  const id = jobs!.find((job) => job.job_no === no)!.id;
  const emptyId = jobs!.find((job) => job.job_no !== no)!.id;
  const name = "bracket-current.png";
  const path = `${org}/${id}/1700000000000-${name}`;
  expect((await service.storage.from("job-drawings").upload(path, PNG, { contentType: "image/png" })).error).toBeNull();
  expect((await service.from("job_files").insert({
    organization_id: org, job_id: id, kind: "drawing", ref: "bracket", revision: "B",
    file_name: name, storage_bucket: "job-drawings", storage_path: path,
  })).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.workshop);
  let metadataDown = false;
  await page.route((url) => url.pathname.endsWith("/rest/v1/job_files") &&
    url.searchParams.get("job_id") === `eq.${id}` && url.searchParams.get("kind") === "eq.drawing", async (route) => {
    if (metadataDown) {
      await route.fulfill({ status: 500, json: { message: "Drawing metadata unavailable" } });
    } else {
      await route.continue();
    }
  });

  await page.goto("/jobs");
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${no}` });
  const download = sheet.getByRole("button", { name: "Download", exact: true });
  await expect(download).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save Worksheet" })).toBeEnabled();
  expect((await service.from("jobs").update({ heat_cast_no: "THEIRS" }).eq("id", id)).error).toBeNull();
  await sheet.getByLabel("Heat / Cast #").fill("MINE");
  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  const reload = sheet.getByRole("button", { name: "Load their version (discards yours)" });
  await expect(reload).toBeVisible();

  metadataDown = true;
  await reload.click();
  await expect(sheet.getByRole("alert").filter({ hasText: "Drawings unavailable" })).toBeVisible();
  await expect(download).toHaveCount(0);
  await expect(sheet.getByText(name, { exact: true })).toHaveCount(0);
  await expect(sheet.getByText("No drawings uploaded yet.")).toHaveCount(0);

  metadataDown = false;
  await sheet.getByRole("button", { name: "Retry drawings" }).click();
  await expect(download).toBeVisible();
  await expect(sheet.getByText(name, { exact: true })).toBeVisible();

  for (const route of [`/jobs/${id}/print`, `/jobs/print?ids=${id},${emptyId}`]) {
    metadataDown = true;
    await page.goto(route);
    await expect(page.getByText(/^Drawings unavailable/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Print Now" })).toBeDisabled();
    await expect(page.getByText(no, { exact: false })).toHaveCount(0);
    await expect(page.getByText(`${name} (Rev B)`, { exact: false })).toHaveCount(0);

    metadataDown = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("button", { name: "Print Now" })).toBeEnabled();
    await expect(page.getByText(`${name} (Rev B)`, { exact: false })).toBeVisible();
  }
});

test("a certificate attached on the delivery note screen is in the job's cert pack", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const no = `J-CERT-${tag()}`;
  const service = adminClient();
  const { data: job } = await service.from("jobs").insert({ organization_id: org, job_no: no, customer: "Cert Co", description: "Shaft" }).select("id").single();
  const dn = `DLN-CERT-${tag()}`;
  const { error } = await service.from("delivery_notes").insert({ organization_id: org, dn_number: dn, customer: "Cert Co", job_ref: no, status: "awaiting" });
  expect(error).toBeNull();

  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/delivery-notes");
  await page.getByRole("row").filter({ hasText: dn }).getByRole("button", { name: "View" }).click();
  const detail = page.getByRole("dialog", { name: dn });
  await expect(detail.getByRole("region", { name: "Cert pack" })).toContainText("No certificates attached");
  await detail.getByLabel("Certificate number or heat number").fill("Heat 7788");
  await detail.getByLabel("Certificate file").setInputFiles({ name: "cert-en8.png", mimeType: "image/png", buffer: PNG });
  await expect(detail.getByRole("list", { name: "Certificates" })).toContainText("Heat 7788");

  const stored = (await service.from("job_files").select("kind, ref, file_name, organization_id, storage_bucket").eq("job_id", job!.id)).data;
  expect(stored).toEqual([{ kind: "cert", ref: "Heat 7788", file_name: "cert-en8.png", organization_id: org, storage_bucket: "job-drawings" }]);

  await page.reload();
  await page.getByRole("row").filter({ hasText: dn }).getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog", { name: dn }).getByRole("list", { name: "Certificates" })).toContainText("cert-en8.png");
  // Workshop can add but not take away; the file sits in the company's folder of the job.
  await expect(page.getByRole("dialog", { name: dn }).getByRole("button", { name: "Remove" })).toHaveCount(0);
  const listed = await service.storage.from("job-drawings").list(`${org}/${job!.id}/certs`);
  expect((listed.data ?? []).map((f) => f.name.replace(/^\d+-/, ""))).toEqual(["cert-en8.png"]);
  await service.storage.from("job-drawings").remove((listed.data ?? []).map((f) => `${org}/${job!.id}/certs/${f.name}`));
});
