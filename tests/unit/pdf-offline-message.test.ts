/**
 * A PDF or PDF export pressed while the device is offline: its code is loaded on the press (phone lag, fix 1), so the load fails.
 * The person is told "PDF needs an internet connection to load. Connect and try again." (lib/download-pdf.tsx PDF_OFFLINE_MESSAGE),
 * not the generic "Couldn't generate the PDF" / "Failed to export PDF". Any other failure keeps its message.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
  pdf: () => ({ toBlob: async () => { if (render.fail) throw render.fail; return new Blob(["%PDF"]); } }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const audit = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async (event: unknown) => { audit.events.push(event); }) }));
vi.mock("@/lib/company", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/company")>();
  return { ...original, requireCompanyProfile: async () => original.JNR_PROFILE };
});

import { CompanyProfileMissingError } from "@/lib/company";
import { PDF_OFFLINE_MESSAGE, downloadPdf, pdfCodeUnreachable, pdfErrorMessage } from "@/lib/download-pdf";
import { exportRows } from "@/lib/export-records";

const downloads: string[] = [];
const chunkError = () => Object.assign(new Error("Loading chunk 4821 failed.\n(error: https://app.test/_next/static/chunks/4821.js)"), { name: "ChunkLoadError" });
const setOnline = (onLine: boolean) => vi.stubGlobal("navigator", { onLine });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  downloads.length = 0;
  audit.events.length = 0;
  render.fail = null;
  setOnline(true);
  vi.stubGlobal("document", {
    createElement: () => {
      const link = { href: "", download: "", click: () => downloads.push(link.download), remove: () => undefined };
      return link;
    },
    body: { appendChild: () => undefined },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("pdfCodeUnreachable", () => {
  it("offline (navigator.onLine === false), or a failed lazy import (webpack ChunkLoadError, native import() in Chrome, Firefox, Safari)", () => {
    expect(pdfCodeUnreachable(chunkError())).toBe(true);
    expect(pdfCodeUnreachable(new Error("Loading css chunk 12 failed.\n(error: /x.css)"))).toBe(true);
    expect(pdfCodeUnreachable(new TypeError("Failed to fetch dynamically imported module: https://app.test/_next/static/chunks/pdf.js"))).toBe(true);
    expect(pdfCodeUnreachable(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(pdfCodeUnreachable(new TypeError("Importing a module script failed."))).toBe(true);
    setOnline(false);
    expect(pdfCodeUnreachable(new Error("anything"))).toBe(true);
  });

  it("online, any other failure is not", () => {
    expect(pdfCodeUnreachable(new Error("Invalid line item"))).toBe(false);
    expect(pdfCodeUnreachable(new TypeError("Failed to fetch"))).toBe(false); // a data request, not the PDF code
    expect(pdfCodeUnreachable("text")).toBe(false);
    expect(pdfCodeUnreachable(null)).toBe(false);
  });

  it("pdfErrorMessage keeps the specific messages first (a missing company profile), offline or not", () => {
    setOnline(false);
    const missing = new CompanyProfileMissingError();
    expect(pdfErrorMessage(missing)).toBe(missing.message);
    expect(pdfErrorMessage(chunkError())).toBe(PDF_OFFLINE_MESSAGE);
  });
});

describe("downloadPdf (the document buttons on quotes, invoices, credit notes, sales orders, delivery notes, purchase orders)", () => {
  it("the document's code fails to load (ChunkLoadError from the builder's import): the offline message, nothing saved", async () => {
    const ok = await downloadPdf(async () => { throw chunkError(); }, "quote-Q-1.pdf", { entityTable: "quotes", entityId: "Q-1" });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(PDF_OFFLINE_MESSAGE);
    expect(downloads).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it("offline: the offline message", async () => {
    setOnline(false);
    render.fail = new TypeError("Failed to fetch dynamically imported module: https://app.test/_next/static/chunks/react-pdf.js");
    expect(await downloadPdf(createElement("div"), "invoice-INV-1.pdf", { entityTable: "invoices", entityId: "INV-1" })).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(PDF_OFFLINE_MESSAGE);
  });

  it("online, any other failure: the generic message, as before", async () => {
    render.fail = new Error("Invalid line item");
    expect(await downloadPdf(createElement("div"), "invoice-INV-1.pdf", { entityTable: "invoices", entityId: "INV-1" })).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Couldn't generate the PDF. Try again.");
  });
});

describe("exportRows(\"pdf\") (the PDF export on quotes, invoices and jobs)", () => {
  const rows = [{ Ref: "Q-1" }];

  it("offline: the offline message", async () => {
    setOnline(false);
    render.fail = chunkError();
    await exportRows("pdf", "Quotes Export", rows, "quotes");
    expect(toast.error).toHaveBeenCalledWith(PDF_OFFLINE_MESSAGE);
    expect(downloads).toEqual([]);
  });

  it("the renderer's code fails to load online (ChunkLoadError): the offline message", async () => {
    render.fail = chunkError();
    await exportRows("pdf", "Quotes Export", rows, "quotes");
    expect(toast.error).toHaveBeenCalledWith(PDF_OFFLINE_MESSAGE);
  });

  it("online, any other failure: the generic message, as before", async () => {
    render.fail = new Error("Invalid row");
    await exportRows("pdf", "Quotes Export", rows, "quotes");
    expect(toast.error).toHaveBeenCalledWith("Failed to export PDF. Try again.");
  });

  it("a working export is unchanged", async () => {
    await exportRows("pdf", "Quotes Export", rows, "quotes");
    expect(toast.error).not.toHaveBeenCalled();
    expect(downloads).toEqual(["Quotes Export.pdf"]);
  });
});
