/**
 * Job photos on the worksheet (migration 040), in the browser: a photo taken on a phone, tablet and desktop is prepared on the
 * device (turned upright, no EXIF, no GPS), uploaded once and shown with who added it and when; a photo pending on the device
 * survives a reload; a connection lost mid-upload, or a real offline spell, still ends in exactly one photo; the office removes
 * a photo after confirming; the workshop can't remove; a viewer sees none and gets none from the server.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIResponse, type Browser, type Locator, type Page } from "@playwright/test";

import { jpegInfo } from "@/lib/photo-image";

import { JPEG_4x2, carriesTestExif, taggedJpeg } from "../support/exif";
import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { VIEWPORTS, deviceContext, type ViewportSpec } from "../support/ui-pr1-screenshots";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);
const BUCKET = "job-photos";
const SHOTS_DIR = process.env.JOB_PHOTOS_SHOTS_DIR ?? path.resolve(__dirname, "../../test-results/job-photos-screenshots");
/** A 4x2 JPEG (left black, right white) tagged as turned 90 degrees, with a camera make and a GPS position. */
const TAGGED = Buffer.from(taggedJpeg(new Uint8Array(JPEG_4x2), { orientation: 6, gps: true }));

async function newJob(jobNo: string, tenant = w.tenants.alpha.id) {
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: tenant, job_no: jobNo, customer: "Photo Co", description: "Bracket" }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}
async function openWorksheet(page: Page, jobNo: string) {
  await page.goto("/jobs");
  // A card on a phone, a table row elsewhere (UI PR 1 and 2).
  await page.locator(`[data-testid="job-card"][data-job-no="${jobNo}"]:visible, tr:has-text("${jobNo}"):visible`).first().getByRole("button", { name: "Worksheet" }).click();
  const dialog = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  await expect(dialog).toBeVisible();
  return dialog;
}
const photosOf = (dialog: Locator) => dialog.getByTestId("job-photos");
const takePhoto = (photos: Locator, buffer: Buffer, name = "IMG_0001.jpg", mimeType = "image/jpeg") => photos.getByLabel("Camera").setInputFiles({ name, mimeType, buffer });
const rowsOf = async (jobId: string) => (await adminClient().from("job_files").select("id, upload_state, deleted_at, deleted_by, created_by, note, byte_size, storage_path").eq("job_id", jobId).eq("kind", "photo").order("created_at")).data ?? [];
const objectsOf = async (jobId: string, tenant = w.tenants.alpha.id) => ((await adminClient().storage.from(BUCKET).list(`${tenant}/${jobId}/photos`)).data ?? []).map((o) => o.name);
const download = async (storagePath: string) => Buffer.from(await (await adminClient().storage.from(BUCKET).download(storagePath)).data!.arrayBuffer());
/** The named events (ADD_PHOTO / REMOVE_PHOTO) written for a photo, from the audit trail (not exposed through the API). */
const photoEvents = (action: string, photoId: string) => withDb(async (db) => (await db.query<{ actor_user_id: string }>("select actor_user_id from security_audit.audit_log where action = $1 and metadata ->> 'photo_id' = $2", [action, photoId])).rows);
const addedEvents = (photoId: string) => photoEvents("ADD_PHOTO", photoId);
async function saveShot(page: Page, name: string) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  // Playwright empties test-results/ on every run: a copy outside it is kept when asked (JOB_PHOTOS_SHOTS_DIR).
  if (process.env.JOB_PHOTOS_SHOTS_DIR) copyFileSync(file, path.join(process.env.JOB_PHOTOS_SHOTS_DIR, `${name}.png`));
}
/** Exactly one uploaded photo of the job, with its one stored object, and the bytes it holds. */
async function exactlyOnePhoto(jobId: string) {
  const rows = await rowsOf(jobId);
  expect(rows.map((r) => [r.upload_state, r.deleted_at])).toEqual([["uploaded", null]]);
  const objects = await objectsOf(jobId);
  expect(objects).toEqual([`${rows[0].id}.jpg`]);
  const bytes = await download(rows[0].storage_path);
  expect(bytes.length).toBe(rows[0].byte_size);
  expect(await addedEvents(rows[0].id)).toHaveLength(1);
  return { row: rows[0], bytes };
}

async function goOffline(page: Page) {
  // Only the browser loses Supabase (as when it is blocked locally); the app server still reaches it.
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
}
async function goOnline(page: Page) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

for (const viewport of VIEWPORTS satisfies ViewportSpec[]) {
  test(`take a photo at ${viewport.width}px (${viewport.name}): prepared on the device, uploaded once, shown with who and when`, async ({ browser, baseURL }) => {
    const context = await deviceContext(browser, viewport, baseURL!);
    const page = await context.newPage();
    const jobNo = `J-PH${viewport.width}-${tag()}`;
    const jobId = await newJob(jobNo);
    await signIn(page, w.tenants.alpha.users.workshop);
    const sheet = await openWorksheet(page, jobNo);
    const photos = photosOf(sheet);
    await photos.scrollIntoViewIfNeeded();
    await expect(photos.getByText("No photos yet.")).toBeVisible();
    // Camera and gallery are separate, one photo at a time, with 48 px targets.
    await expect(photos.getByLabel("Camera")).toHaveAttribute("capture", "environment");
    await expect(photos.getByLabel("Gallery file")).not.toHaveAttribute("capture", /.*/);
    await expect(photos.getByLabel("Camera")).not.toHaveAttribute("multiple", /.*/);
    await expect(photos.getByLabel("Gallery file")).not.toHaveAttribute("multiple", /.*/);
    for (const name of ["Take photo", "Gallery"]) {
      const box = await photos.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(48);
    }
    await photos.getByLabel("Photo note").fill("Bore after finishing");
    await takePhoto(photos, TAGGED);
    const tile = photos.getByTestId("job-photo");
    await expect(tile).toHaveCount(1);
    await expect(tile).toContainText("Bore after finishing");
    await expect(tile).toContainText("Added by Workshop alpha");
    await expect(photos.getByTestId("pending-photo")).toHaveCount(0);
    await expect(photos.getByLabel("Photo note")).toHaveValue("");
    // The picture comes through the server route and is the turned one: 2 wide, 4 high.
    await expect.poll(() => tile.getByRole("img").evaluate((el) => [(el as HTMLImageElement).naturalWidth, (el as HTMLImageElement).naturalHeight])).toEqual([2, 4]);
    await saveShot(page, `workshop-${viewport.width}x${viewport.height}-photo`);

    const { row, bytes } = await exactlyOnePhoto(jobId);
    expect(row).toMatchObject({ created_by: w.tenants.alpha.users.workshop.id, note: "Bore after finishing" });
    // Stored upright (orientation applied, so the 4x2 became 2x4), with no EXIF, no GPS, no camera make, no other metadata segment.
    expect(jpegInfo(new Uint8Array(bytes))).toEqual({ width: 2, height: 4, orientation: null, metadataSegments: [] });
    expect(carriesTestExif(new Uint8Array(bytes))).toBe(false);
    expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    await context.close();
  });
}

test("a big photo from the gallery is brought down to 2048 px on its longest edge and 2 MiB at most", async ({ page }) => {
  const jobNo = `J-PHBIG-${tag()}`;
  const jobId = await newJob(jobNo);
  await signIn(page, w.tenants.alpha.users.office);
  const sheet = await openWorksheet(page, jobNo);
  const photos = photosOf(sheet);
  // A 3000 x 2250 PNG of random blocks, made in the browser (there is no camera here).
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2250;
    const ctx = canvas.getContext("2d")!;
    for (let i = 0; i < 4000; i += 1) {
      ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)} 70% ${30 + Math.floor(Math.random() * 50)}%)`;
      ctx.fillRect(Math.random() * 3000, Math.random() * 2250, 20 + Math.random() * 200, 20 + Math.random() * 200);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await photos.getByLabel("Gallery file").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);
  const { bytes } = await exactlyOnePhoto(jobId);
  const info = jpegInfo(new Uint8Array(bytes));
  expect([info.width, info.height]).toEqual([2048, 1536]);
  expect(info.metadataSegments).toEqual([]);
  expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("a photo pending on the device survives a reload, can be exported, and uploads once the connection is back", async ({ page }) => {
  const jobNo = `J-PHKEEP-${tag()}`;
  const jobId = await newJob(jobNo);
  await signIn(page, w.tenants.alpha.users.workshop);
  await openWorksheet(page, jobNo); // the worksheet is now on the device
  await page.keyboard.press("Escape");
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  let photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByText("Offline: photos already uploaded show when you're back online.")).toBeVisible();
  await takePhoto(photos, TAGGED);
  await expect(page.getByText("Photo saved on this device. Uploading...")).toBeVisible();
  await expect(photos.getByTestId("pending-photo")).toHaveCount(1);
  await expect(photos.getByTestId("pending-photo")).toContainText("Waiting to upload");
  await expect(page.getByText("1 photo waiting to upload")).toBeVisible();
  expect(await rowsOf(jobId)).toEqual([]);

  // Still offline, after a reload: the photo is still on the device.
  await page.keyboard.press("Escape");
  await page.reload();
  photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByTestId("pending-photo")).toHaveCount(1);
  await expect(photos.getByTestId("pending-photo")).toContainText("Waiting to upload");
  await page.keyboard.press("Escape");

  // Export: the picture comes down from the device, as a JPEG named after the job.
  await page.getByText("1 photo waiting to upload").click();
  const waiting = page.waitForEvent("download");
  await page.getByRole("list", { name: "Photos waiting to upload" }).getByRole("button", { name: "Export" }).click();
  const exported = await waiting;
  expect(exported.suggestedFilename()).toMatch(new RegExp(`^photo-${jobNo}-[0-9a-f]{8}\\.jpg$`));
  const exportedBytes = await new Promise<Buffer>((resolve, reject) => {
    void exported.createReadStream().then((stream) => { const chunks: Buffer[] = []; stream.on("data", (c) => chunks.push(Buffer.from(c))); stream.on("end", () => resolve(Buffer.concat(chunks))); stream.on("error", reject); });
  });
  expect(jpegInfo(new Uint8Array(exportedBytes))).toEqual({ width: 2, height: 4, orientation: null, metadataSegments: [] });
  // A discard asks first; Cancel keeps it.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("list", { name: "Photos waiting to upload" }).getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("1 photo waiting to upload")).toBeVisible();

  await goOnline(page);
  await expect(page.getByText("1 photo waiting to upload")).toHaveCount(0);
  await expect.poll(async () => (await rowsOf(jobId)).map((r) => r.upload_state)).toEqual(["uploaded"]);
  const { bytes } = await exactlyOnePhoto(jobId);
  expect(bytes.equals(exportedBytes)).toBe(true);
  photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);
  await expect(photos.getByTestId("pending-photo")).toHaveCount(0);
});

test("a connection lost mid-upload, then a reconnect, gives exactly one photo (whether or not the server received the bytes)", async ({ page }) => {
  const jobNo = `J-PHCUT-${tag()}`;
  const jobId = await newJob(jobNo);
  await signIn(page, w.tenants.alpha.users.workshop);
  const photos = photosOf(await openWorksheet(page, jobNo));
  const uploads = "**/storage/v1/object/job-photos/**";

  // 1. The upload never reaches the server.
  let cut = 0;
  await page.route(uploads, (route) => { cut += 1; void route.abort("connectionreset"); });
  await takePhoto(photos, TAGGED);
  await expect(photos.getByTestId("pending-photo")).toContainText("Waiting to upload");
  await expect.poll(() => cut).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await rowsOf(jobId)).map((r) => r.upload_state)).toEqual(["reserved"]);
  expect(await objectsOf(jobId)).toEqual([]);
  await goOnline(page);
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);
  await expect(photos.getByTestId("pending-photo")).toHaveCount(0);
  const first = await exactlyOnePhoto(jobId);

  // 2. The server receives and stores the bytes, but the answer never arrives: the retry finds the object already there.
  let served = 0;
  await page.route(uploads, async (route) => { await route.fetch(); served += 1; await route.abort("connectionreset"); });
  await photos.getByLabel("Photo note").fill("Second, cut after upload");
  await takePhoto(photos, TAGGED, "IMG_0002.jpg");
  await expect(photos.getByTestId("pending-photo")).toContainText("Waiting to upload");
  await expect.poll(() => served).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await objectsOf(jobId)).length).toBe(2); // the bytes are on the server already
  expect((await rowsOf(jobId)).map((r) => r.upload_state).sort()).toEqual(["reserved", "uploaded"]);
  await goOnline(page);
  await expect(photos.getByTestId("job-photo")).toHaveCount(2);
  await expect(photos.getByTestId("pending-photo")).toHaveCount(0);
  const rows = await rowsOf(jobId);
  expect(rows.map((r) => [r.upload_state, r.note])).toEqual([["uploaded", null], ["uploaded", "Second, cut after upload"]]);
  expect((await objectsOf(jobId)).sort()).toEqual(rows.map((r) => `${r.id}.jpg`).sort());
  expect(await addedEvents(rows[1].id)).toHaveLength(1);
  expect(first.row.id).toBe(rows[0].id);
});

test("really offline (the browser has no network), the photo waits on the device; back online it is uploaded exactly once", async ({ context, page }) => {
  const jobNo = `J-PHOFF-${tag()}`;
  const jobId = await newJob(jobNo);
  await signIn(page, w.tenants.alpha.users.workshop);
  const photos = photosOf(await openWorksheet(page, jobNo));
  await context.setOffline(true);
  await takePhoto(photos, TAGGED);
  await expect(page.getByText("Photo saved on this device. Uploading...")).toBeVisible();
  await expect(photos.getByTestId("pending-photo")).toContainText("Waiting to upload");
  await expect(page.getByText("1 photo waiting to upload")).toBeVisible();
  expect(await rowsOf(jobId)).toEqual([]);
  await context.setOffline(false);
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);
  await expect(photos.getByTestId("pending-photo")).toHaveCount(0);
  await expect(page.getByText("1 photo waiting to upload")).toHaveCount(0);
  await exactlyOnePhoto(jobId);
});

test("the office removes a photo after confirming (recorded, bytes kept); the workshop can't remove; a viewer sees none and gets none", async ({ browser, page }) => {
  const jobNo = `J-PHRM-${tag()}`;
  const jobId = await newJob(jobNo);
  // Two photos added by the workshop, through the same steps the browser takes.
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  const ids: string[] = [];
  for (const note of ["Keep", "Remove me"]) {
    const id = crypto.randomUUID();
    const reserved = await workshop.rpc("reserve_job_photo", { p_id: id, p_job: jobId, p_note: note, p_captured_at: null, p_byte_size: JPEG_4x2.length });
    expect(reserved.error).toBeNull();
    expect((await workshop.storage.from(BUCKET).upload(reserved.data.storage_path, JPEG_4x2, { contentType: "image/jpeg" })).error).toBeNull();
    expect((await workshop.rpc("finalise_job_photo", { p_id: id })).error).toBeNull();
    ids.push(id);
  }

  // The workshop sees both and has no Remove.
  await signIn(page, w.tenants.alpha.users.workshop);
  let photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByTestId("job-photo")).toHaveCount(2);
  await expect(photos.getByRole("button", { name: "Remove" })).toHaveCount(0);
  const asWorkshop = await page.request.get(`/api/job-photos/${ids[0]}`);
  expect(asWorkshop.status()).toBe(200);
  expect(asWorkshop.headers()["content-type"]).toBe("image/jpeg");
  expect(Buffer.from(await asWorkshop.body()).equals(JPEG_4x2)).toBe(true);

  // The office removes one, after confirming.
  const officeContext = await browser.newContext();
  const officePage = await officeContext.newPage();
  await signIn(officePage, w.tenants.alpha.users.office);
  photos = photosOf(await openWorksheet(officePage, jobNo));
  await expect(photos.getByTestId("job-photo")).toHaveCount(2);
  await photos.getByTestId("job-photo").filter({ hasText: "Remove me" }).getByRole("button", { name: "Remove" }).click();
  const confirm = officePage.getByRole("dialog", { name: "Remove this photo?" });
  await expect(confirm).toContainText("added by Workshop alpha");
  await saveShot(officePage, "office-1280x720-remove-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(photos.getByTestId("job-photo")).toHaveCount(2);
  await photos.getByTestId("job-photo").filter({ hasText: "Remove me" }).getByRole("button", { name: "Remove" }).click();
  await officePage.getByRole("dialog", { name: "Remove this photo?" }).getByRole("button", { name: "Remove photo" }).click();
  await expect(officePage.getByText("Photo removed.")).toBeVisible();
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);
  await expect(photos.getByTestId("job-photo")).toContainText("Keep");
  const rows = await rowsOf(jobId);
  expect(rows.find((r) => r.id === ids[1])).toMatchObject({ deleted_by: w.tenants.alpha.users.office.id, upload_state: "uploaded" });
  expect(rows.find((r) => r.id === ids[1])!.deleted_at).toBeTruthy();
  expect(rows.find((r) => r.id === ids[0])).toMatchObject({ deleted_at: null });
  expect((await objectsOf(jobId)).sort()).toEqual(ids.map((id) => `${id}.jpg`).sort()); // bytes kept
  expect(await photoEvents("REMOVE_PHOTO", ids[1])).toEqual([{ actor_user_id: w.tenants.alpha.users.office.id }]);
  // A removed photo is no longer served, even to the office.
  expect((await officePage.request.get(`/api/job-photos/${ids[1]}`)).status()).toBe(404);
  expect((await officePage.request.get(`/api/job-photos/${ids[0]}`)).status()).toBe(200);
  await officeContext.close();

  // After a reload the workshop sees one.
  await page.reload();
  photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);

  // A viewer: no Photos section on the worksheet, nothing from the server.
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await signIn(viewerPage, w.tenants.alpha.users.viewer);
  const sheet = await openWorksheet(viewerPage, jobNo);
  await expect(sheet.getByLabel("Heat / Cast #")).toBeVisible();
  await expect(sheet.getByTestId("job-photos")).toHaveCount(0);
  // The route refuses the viewer's role before any row is read (403); a photo it can't see would be 404 anyway. Never 200.
  expect([403, 404]).toContain((await viewerPage.request.get(`/api/job-photos/${ids[0]}`)).status());
  await viewerContext.close();
  // Signed out: nothing either.
  const anon = await browser.newContext();
  expect((await (await anon.newPage()).request.get(`/api/job-photos/${ids[0]}`)).status()).toBe(401);
  await anon.close();
});

/** A browser context signed in as `user` (or signed out), for the route checks below. */
async function contextFor(browser: Browser, user: Parameters<typeof signIn>[1] | null) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (user) await signIn(page, user);
  return { context, page };
}
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
/** Not an image, and not one byte of a JPEG or the PNG in the body. */
async function noBytes(response: APIResponse) {
  expect(response.headers()["content-type"] ?? "").not.toMatch(/^image\//);
  const body = await response.body();
  expect(body.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
  expect(body.includes(PNG_BYTES.subarray(0, 8))).toBe(false);
}

test("the photo route: another company 404, a viewer 403, a removed photo 404, a stored non-JPEG 404, signed out 401; never any bytes", async ({ browser }) => {
  const jobNo = `PH-R-${tag()}`;
  const jobId = await newJob(jobNo);
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  /** Reserve, upload (by the person, or by the service role straight into the bucket), finalise. */
  async function add(body: Buffer, byService = false) {
    const id = randomUUID();
    const reserved = await workshop.rpc("reserve_job_photo", { p_id: id, p_job: jobId, p_note: null, p_captured_at: null, p_byte_size: body.length });
    expect(reserved.error).toBeNull();
    const store = byService ? adminClient().storage.from(BUCKET) : workshop.storage.from(BUCKET);
    expect((await store.upload(reserved.data.storage_path, body, { contentType: "image/jpeg" })).error).toBeNull();
    expect((await workshop.rpc("finalise_job_photo", { p_id: id })).data).toMatchObject({ state: "uploaded" });
    return id;
  }
  const good = await add(Buffer.from(JPEG_4x2));
  // PNG bytes declared image/jpeg, of the reserved size, put there by the service role: the row says uploaded, the route refuses.
  const notJpeg = await add(PNG_BYTES, true);
  const removed = await add(Buffer.from(JPEG_4x2));
  const office = await signedInClient(w.tenants.alpha.users.office);
  expect((await office.rpc("remove_job_photo", { p_id: removed })).error).toBeNull();

  const own = await contextFor(browser, w.tenants.alpha.users.workshop);
  const served = await own.page.request.get(`/api/job-photos/${good}`);
  expect(served.status()).toBe(200);
  expect(Buffer.from(await served.body()).equals(Buffer.from(JPEG_4x2))).toBe(true);
  for (const id of [removed, notJpeg]) {
    const refused = await own.page.request.get(`/api/job-photos/${id}`);
    expect({ id, status: refused.status() }).toEqual({ id, status: 404 });
    await noBytes(refused);
  }
  await own.context.close();

  const beta = await contextFor(browser, w.tenants.beta.users.admin);
  const otherCompany = await beta.page.request.get(`/api/job-photos/${good}`);
  expect(otherCompany.status()).toBe(404);
  await noBytes(otherCompany);
  await beta.context.close();

  const viewer = await contextFor(browser, w.tenants.alpha.users.viewer);
  const asViewer = await viewer.page.request.get(`/api/job-photos/${good}`);
  expect(asViewer.status()).toBe(403);
  await noBytes(asViewer);
  await viewer.context.close();

  const anon = await contextFor(browser, null);
  const signedOut = await anon.page.request.get(`/api/job-photos/${good}`);
  expect(signedOut.status()).toBe(401);
  await noBytes(signedOut);
  await anon.context.close();
});

test("two photos on a job both show; a thumbnail whose load fails is fetched again, and says so with Retry if it keeps failing", async ({ page }) => {
  const jobNo = `J-PH2-${tag()}`;
  const jobId = await newJob(jobNo);
  await signIn(page, w.tenants.alpha.users.workshop);
  let photos = photosOf(await openWorksheet(page, jobNo));
  await takePhoto(photos, TAGGED, "IMG_0001.jpg");
  await expect(photos.getByTestId("job-photo")).toHaveCount(1);
  await takePhoto(photos, Buffer.from(JPEG_4x2), "IMG_0002.jpg");
  await expect(photos.getByTestId("job-photo")).toHaveCount(2);
  const loaded = (tile: Locator) => tile.getByRole("img").evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);
  for (const tile of await photos.getByTestId("job-photo").all()) await expect.poll(() => loaded(tile)).toBe(true);

  // The server busy once on the second photo (a 503, as the route answers a passing fault): the page asks again and it shows.
  const rows = await rowsOf(jobId);
  expect(rows).toHaveLength(2);
  const second = new RegExp(`/api/job-photos/${rows[1].id}\\?`);
  let refused = 0;
  await page.route(second, (route) => (refused++ === 0 ? route.fulfill({ status: 503, body: "busy" }) : route.continue()));
  photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByTestId("job-photo")).toHaveCount(2);
  for (const tile of await photos.getByTestId("job-photo").all()) await expect.poll(() => loaded(tile), { timeout: 10_000 }).toBe(true);
  expect(refused).toBeGreaterThanOrEqual(2);
  await expect(photos.getByTestId("photo-unavailable")).toHaveCount(0);

  // Still failing after the retries: it says so (no broken image), and Retry brings it back once the server answers.
  await page.unroute(second);
  await page.route(second, (route) => route.fulfill({ status: 503, body: "busy" }));
  photos = photosOf(await openWorksheet(page, jobNo));
  await expect(photos.getByTestId("photo-unavailable")).toHaveCount(1, { timeout: 10_000 });
  await expect(photos.getByTestId("photo-unavailable")).toContainText("Couldn't load this photo.");
  await page.unroute(second);
  await photos.getByTestId("photo-unavailable").getByRole("button", { name: "Retry" }).click();
  await expect(photos.getByTestId("photo-unavailable")).toHaveCount(0);
  for (const tile of await photos.getByTestId("job-photo").all()) await expect.poll(() => loaded(tile)).toBe(true);
});
