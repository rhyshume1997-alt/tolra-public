/**
 * Offline PDF export on the Job Board (lib/pdf-warm.ts): the board opened online, on a device that has never made a PDF, fetches the
 * PDF code once the page has loaded and the browser is idle (not with the page); with the signal then gone, Export -> PDF still
 * downloads "Job Board Export.pdf", the same file name as online, and never says the PDF needs an internet connection.
 * Runs in its own company (createSoloTenant), in a fresh browser context (nothing cached from another spec).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

/** Text only the PDF writer inside @react-pdf/renderer carries (the file header it writes); no page of the app has it. */
const PDF_WRITER = "%PDF-";
/** The start of PDF_OFFLINE_MESSAGE (lib/download-pdf.tsx), shown when the PDF code could not be loaded. */
const OFFLINE_MESSAGE = /PDF needs an internet connection/;

test("Job Board: Export PDF works offline once the board has fetched the PDF code, which is not part of the first load", async ({ browser }) => {
  const solo = await createSoloTenant(w.runId, `pdfwarm-${randomUUID().slice(0, 6)}`);
  const jobNo = `J-PDFW-${w.runId}`;
  expect((await adminClient().from("jobs").insert({ organization_id: solo.id, job_no: jobNo, customer: "Offline Pdf Co", description: "Offline export" })).error).toBeNull();

  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    // Room for every request of the board in the resource timings (the default 250 can fill before the PDF code is fetched).
    await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
    await signIn(page, solo.admin);
    await page.goto("/jobs");
    await expect(page.getByText(jobNo).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-pdf-warm", "ready");

    // The board's own scripts are requested before the load event; the PDF code only afterwards (the warm waits for load, then idle).
    const scripts = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const files = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((entry) => /^\/_next\/static\/.+\.js$/.test(new URL(entry.name).pathname));
      return { firstLoad: files.filter((entry) => entry.startTime < nav.loadEventStart).map((entry) => entry.name), afterLoad: files.filter((entry) => entry.startTime >= nav.loadEventEnd).map((entry) => entry.name) };
    });
    const withWriter = async (urls: string[]) => {
      const found: string[] = [];
      for (const url of urls) if ((await (await page.request.get(url)).text()).includes(PDF_WRITER)) found.push(url);
      return found;
    };
    expect(scripts.firstLoad.length, "the board's first-load scripts").toBeGreaterThan(0);
    expect(await withWriter(scripts.firstLoad), "the PDF renderer in the board's first load").toEqual([]);
    const renderer = await withWriter(scripts.afterLoad);
    expect(renderer.length, "the PDF renderer fetched after the board loaded").toBeGreaterThan(0);

    // The service worker keeps it for this deploy (cache-first /_next/static), so a later visit needs no download either.
    await expect.poll(() => page.evaluate(async (urls) => {
      for (const url of urls) if (!(await caches.match(url))) return false;
      return true;
    }, renderer)).toBe(true);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "PDF", exact: true }).click()]);
    expect(download.suggestedFilename()).toBe("Job Board Export.pdf");
    expect(readFileSync(await download.path()).subarray(0, 5).toString("latin1")).toBe(PDF_WRITER);
    await expect(page.getByText("PDF export downloaded")).toBeVisible();
    await expect(page.getByText(OFFLINE_MESSAGE)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
