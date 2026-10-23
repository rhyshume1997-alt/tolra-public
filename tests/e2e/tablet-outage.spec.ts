/**
 * A real tablet outage. The browser keeps its data on disk (a persistent profile, as a tablet does): changes are made while
 * Supabase can't be reached, the browser is CLOSED and started again while it is still unreachable, the app opens from the
 * device's copy with the changes still waiting, and when the connection is back each change is sent exactly once.
 */
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { adminClient } from "../support/fixtures";
import { playJob, signIn, world } from "./helpers";

const w = world();

const BLOCKED = ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"];
async function cutSupabase(context: BrowserContext) {
  for (const pattern of BLOCKED) await context.route(pattern, (route) => route.abort("internetdisconnected"));
}

test("outage: change offline, restart the browser while still offline, reconnect: each change is sent once", async ({ baseURL }) => {
  test.setTimeout(240_000);
  const admin = adminClient();
  const profile = mkdtempSync(path.join(tmpdir(), "tolra-tablet-"));
  const startNo = `J-OUT-A-${w.runId}`;
  const sheetNo = `J-OUT-B-${w.runId}`;
  const { data: rows, error } = await admin.from("jobs").insert([
    { organization_id: w.tenants.beta.id, job_no: startNo, customer: "Outage Co", heat_cast_no: "H0" },
    { organization_id: w.tenants.beta.id, job_no: sheetNo, customer: "Outage Co", heat_cast_no: "H1" },
  ]).select("id, job_no");
  expect(error).toBeNull();
  const idOf = (no: string) => rows!.find((r) => r.job_no === no)!.id as string;
  const launch = () => chromium.launchPersistentContext(profile, { baseURL, headless: true, ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}) });
  const row = (page: Page, no: string) => page.getByRole("row").filter({ hasText: no });
  const worksheetOf = async () => (await admin.from("jobs").select("heat_cast_no, worksheet_version").eq("id", idOf(sheetNo)).single()).data!;
  const startedAt = async () => (await admin.from("jobs").select("started_at").eq("id", idOf(startNo)).single()).data!.started_at as string | null;

  try {
    // 1. Online: sign in, let the device take its copy of both jobs and the worksheet.
    let context = await launch();
    let page = context.pages()[0] ?? (await context.newPage());
    await signIn(page, w.tenants.beta.users.workshop);
    await page.goto("/jobs");
    await expect(row(page, startNo)).toBeVisible();
    await row(page, sheetNo).getByRole("button", { name: "Worksheet" }).click();
    const sheet = page.getByRole("dialog", { name: `Worksheet - ${sheetNo}` });
    await expect(sheet.getByLabel("Heat / Cast #")).toHaveValue("H1");
    await page.keyboard.press("Escape");
    const before = await worksheetOf();

    // 2. The connection goes: two changes made offline.
    await cutSupabase(context);
    await page.reload();
    await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
    await playJob(page, row(page, startNo), startNo, { bench: true });
    await row(page, sheetNo).getByRole("button", { name: "Worksheet" }).click();
    await expect(sheet.getByText("Offline: showing this device's copy.")).toBeVisible(); // the form has loaded from the device
    await sheet.getByLabel("Heat / Cast #").fill("MINE");
    await sheet.getByRole("button", { name: "Save Worksheet" }).click();
    await expect(page.getByText("Saved on this device. It will sync when you're back online.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("2 changes waiting to sync.")).toBeVisible();
    const offlineAt = Date.now();

    // 3. The browser is closed and started again, still offline.
    await context.close();
    context = await launch();
    await cutSupabase(context);
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto("/jobs");
    await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
    await expect(page.getByText("2 changes waiting to sync.")).toBeVisible();
    await expect(row(page, startNo)).toBeVisible();
    expect(await startedAt()).toBeNull();
    expect(await worksheetOf()).toEqual(before);

    // 4. The connection returns. Count what the browser writes from here on.
    const writes: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      // Changes to records only: not reads (GET/HEAD) and not read-only function calls (POST .../rpc/...). start_machine_run writes: a Start of
      // a job with no machine replays through it (migration 046: its bench run), so it is counted.
      const changes = ["PATCH", "PUT", "DELETE"].includes(request.method()) || (request.method() === "POST" && (!url.includes("/rpc/") || url.includes("/rpc/start_machine_run")));
      if (changes && url.includes("/rest/v1/")) writes.push(`${request.method()} ${new URL(url).pathname}`);
    });
    await context.unrouteAll({ behavior: "ignoreErrors" });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(startedAt, { timeout: 30_000 }).not.toBeNull();
    await expect.poll(async () => (await worksheetOf()).heat_cast_no, { timeout: 30_000 }).toBe("MINE");
    await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);

    // The Start keeps the time it was made offline, and the worksheet moved up by exactly one version.
    expect(Date.parse((await startedAt())!)).toBeLessThanOrEqual(offlineAt);
    expect((await worksheetOf()).worksheet_version).toBe(Number(before.worksheet_version) + 1);

    // 5. Nothing is sent twice: more sync triggers (reconnect event, tab visible again, a reload, a restart) change nothing.
    const startedOnce = await startedAt();
    const versionOnce = (await worksheetOf()).worksheet_version;
    const writesSoFar = [...writes];
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    await page.reload();
    await expect(row(page, startNo)).toBeVisible();
    await context.close();
    context = await launch();
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto("/jobs");
    await expect(row(page, startNo)).toBeVisible();
    await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);
    expect(await startedAt()).toBe(startedOnce);
    expect((await worksheetOf()).worksheet_version).toBe(versionOnce);
    // Exactly the writes that replayed the two changes, once each, then none: the Start, its stage move to Machining (two filtered
    // updates: from an earlier stage, or from none), the worksheet.
    expect([...writesSoFar].sort()).toEqual(["PATCH /rest/v1/jobs", "PATCH /rest/v1/jobs", "PATCH /rest/v1/jobs", "POST /rest/v1/rpc/start_machine_run"]);
    expect(writes).toEqual(writesSoFar);
    // The Start opened exactly one bench run (046), however often it was offered again.
    expect((await admin.from("machine_runs").select("machine_id").eq("job_id", idOf(startNo))).data).toEqual([{ machine_id: null }]);
    await context.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
