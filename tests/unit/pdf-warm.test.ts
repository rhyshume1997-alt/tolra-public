/**
 * Offline PDF export on the Job Board (lib/pdf-warm.ts): once the page has loaded, the device is online and the browser is idle, the
 * board fetches the modules its Export PDF uses, once, so the export later works with no signal. It goes through the export's own
 * loader (loadExportPdfCode in lib/export-records.ts), so the two can never load different code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** The PDF modules loaded in the current module registry, in order; `fail` makes the renderer's load fail (a ChunkLoadError). */
const pdfCode = { loaded: [] as string[], fail: false };
/** Registered again for each fresh page, so each load of the modules is seen (a mock's result is otherwise kept across resetModules). */
function mockPdfCode() {
  vi.doMock("@react-pdf/renderer", async (importOriginal) => {
    if (pdfCode.fail) throw Object.assign(new Error("Loading chunk 4821 failed."), { name: "ChunkLoadError" });
    pdfCode.loaded.push("@react-pdf/renderer");
    return { ...(await importOriginal<typeof import("@react-pdf/renderer")>()), pdf: () => ({ toBlob: async () => new Blob(["%PDF"]) }) };
  });
  vi.doMock("@/components/pdf/BaseDocumentPDF", async (importOriginal) => {
    pdfCode.loaded.push("@/components/pdf/BaseDocumentPDF");
    return importOriginal();
  });
}
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async () => undefined) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/company", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/company")>();
  return { ...original, requireCompanyProfile: async () => original.JNR_PROFILE };
});

/** A browser just enough for the helper: window events, requestIdleCallback (held until `idle()`), readyState, onLine, <html> dataset. */
let win: EventTarget & { requestIdleCallback?: unknown; cancelIdleCallback: ReturnType<typeof vi.fn>; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
let idleQueue: Array<() => void>;
let doc: { readyState: string; documentElement: { dataset: Record<string, string> }; createElement: () => unknown; body: { appendChild: () => void } };
let nav: { onLine: boolean };
const downloads: string[] = [];

function browser({ onLine = true, readyState = "complete", idleCallback = true } = {}) {
  idleQueue = [];
  win = Object.assign(new EventTarget(), {
    cancelIdleCallback: vi.fn((id: number) => { idleQueue[id - 1] = () => undefined; }),
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as typeof clearTimeout,
  });
  if (idleCallback) win.requestIdleCallback = vi.fn((fn: () => void) => idleQueue.push(fn));
  doc = {
    readyState,
    documentElement: { dataset: {} },
    createElement: () => {
      const link = { href: "", download: "", click: () => downloads.push(link.download), remove: () => undefined };
      return link;
    },
    body: { appendChild: () => undefined },
  };
  nav = { onLine };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", nav);
}

/** Runs the idle callbacks the helper asked for. */
const idle = () => { for (const fn of idleQueue.splice(0)) fn(); };
const ready = () => vi.waitFor(() => expect(doc.documentElement.dataset.pdfWarm).toBe("ready"));
/** A fresh page load: the helper's once-per-load flag and the PDF modules start unloaded. */
async function freshPage() {
  vi.resetModules();
  mockPdfCode();
  pdfCode.loaded = [];
  return import("@/lib/pdf-warm");
}

beforeEach(() => {
  pdfCode.fail = false;
  downloads.length = 0;
  browser();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("warmPdfExport", () => {
  it("loads exactly the modules exportRows(\"pdf\") loads (the renderer and BaseDocumentPDF), after idle, once", async () => {
    vi.resetModules();
    mockPdfCode();
    pdfCode.loaded = [];
    const { exportRows, EXPORT_TITLES } = await import("@/lib/export-records");
    await exportRows("pdf", EXPORT_TITLES.jobs, [{ Job: "J-1" }], "jobs");
    expect(downloads).toEqual(["Job Board Export.pdf"]);
    const exportLoads = [...pdfCode.loaded].sort();
    expect(exportLoads).toEqual(["@/components/pdf/BaseDocumentPDF", "@react-pdf/renderer"]);

    const { warmPdfExport } = await freshPage();
    warmPdfExport();
    await Promise.resolve();
    expect(pdfCode.loaded).toEqual([]); // not before the browser is idle
    idle();
    await ready();
    expect([...pdfCode.loaded].sort()).toEqual(exportLoads);

    // Once per page load: a second board visit (or a second effect run) fetches nothing more.
    warmPdfExport();
    expect(idleQueue).toEqual([]);
    expect(pdfCode.loaded).toHaveLength(2);
  });

  it("asks for idle time with a timeout, and only once while waiting", async () => {
    const { warmPdfExport } = await freshPage();
    warmPdfExport();
    expect(win.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 10_000 });
    warmPdfExport(); // a second mount before idle: its own wait, but the fetch still happens once
    idle();
    await ready();
    expect(pdfCode.loaded).toHaveLength(2);
  });

  it("waits for the page to finish loading before asking for idle time", async () => {
    browser({ readyState: "interactive" });
    const { warmPdfExport } = await freshPage();
    warmPdfExport();
    expect(win.requestIdleCallback).not.toHaveBeenCalled();
    doc.readyState = "complete";
    win.dispatchEvent(new Event("load"));
    expect(win.requestIdleCallback).toHaveBeenCalledTimes(1);
    idle();
    await ready();
  });

  it("offline: does nothing; when the device comes back online, warms once", async () => {
    browser({ onLine: false });
    const { warmPdfExport } = await freshPage();
    warmPdfExport();
    expect(win.requestIdleCallback).not.toHaveBeenCalled();
    expect(pdfCode.loaded).toEqual([]);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    idle();
    await ready();
    expect(pdfCode.loaded).toHaveLength(2);
    win.dispatchEvent(new Event("online")); // the listener was once-only
    expect(idleQueue).toEqual([]);
  });

  it("offline again by the time the browser is idle: waits for the next 'online' instead of fetching", async () => {
    const { warmPdfExport } = await freshPage();
    warmPdfExport();
    nav.onLine = false;
    idle();
    await Promise.resolve();
    expect(pdfCode.loaded).toEqual([]);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    idle();
    await ready();
  });

  it("without requestIdleCallback (Safari): a short timer after load instead", async () => {
    vi.useFakeTimers();
    browser({ idleCallback: false });
    const { warmPdfExport } = await freshPage();
    warmPdfExport();
    expect(pdfCode.loaded).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await ready();
    expect(pdfCode.loaded).toHaveLength(2);
  });

  it("a failed fetch is swallowed (nothing thrown, nothing marked) and tried again on the next 'online'", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      pdfCode.fail = true;
      const { warmPdfExport } = await freshPage();
      expect(() => warmPdfExport()).not.toThrow();
      expect(() => idle()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(doc.documentElement.dataset.pdfWarm).toBeUndefined();
      expect(rejections).toEqual([]);
      pdfCode.fail = false;
      vi.resetModules(); // the failed module load is not cached by the bundler either
      mockPdfCode();
      win.dispatchEvent(new Event("online"));
      idle();
      await ready();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("the board unmounted before idle: the wait is cancelled and nothing is fetched", async () => {
    const { warmPdfExport } = await freshPage();
    const cleanup = warmPdfExport();
    cleanup();
    expect(win.cancelIdleCallback).toHaveBeenCalledTimes(1);
    idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pdfCode.loaded).toEqual([]);
  });

  it("on the server (no window): does nothing", async () => {
    vi.stubGlobal("window", undefined);
    const { warmPdfExport } = await freshPage();
    expect(() => warmPdfExport()()).not.toThrow();
    expect(pdfCode.loaded).toEqual([]);
  });
});

describe("the warm and the export share one loader, so they cannot drift", () => {
  const source = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("lib/export-records.ts: every import() is in loadExportPdfCode, and exportRows(\"pdf\") calls it", () => {
    const code = source("lib/export-records.ts");
    const loader = code.match(/export function loadExportPdfCode\(\) \{([\s\S]*?)\n\}/);
    expect(loader, "loadExportPdfCode").not.toBeNull();
    const dynamicImports = (text: string) => [...text.matchAll(/\bimport\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(dynamicImports(loader![1])).toEqual(["@react-pdf/renderer", "@/components/pdf/BaseDocumentPDF"]);
    expect(dynamicImports(code)).toEqual(dynamicImports(loader![1]));
    expect(code).toMatch(/await loadExportPdfCode\(\)/);
  });

  it("lib/pdf-warm.ts loads nothing of its own: it calls loadExportPdfCode from lib/export-records", () => {
    const code = source("lib/pdf-warm.ts");
    expect(code).not.toMatch(/\bimport\(/);
    expect(code).toMatch(/import \{ loadExportPdfCode \} from "@\/lib\/export-records";/);
    expect(code).toMatch(/loadExportPdfCode\(\)/);
  });

  it("only the Job Board warms (no other page imports lib/pdf-warm)", () => {
    const pages = ["jobs", "quotes", "invoices", "sales-orders", "delivery-notes", "purchase-orders", "customers", "suppliers", "time/week"];
    const warming = pages.filter((page) => source(`app/(dashboard)/${page}/page.tsx`).includes("@/lib/pdf-warm"));
    expect(warming).toEqual(["jobs"]);
    expect(source("app/(dashboard)/jobs/page.tsx")).toMatch(/useEffect\(\(\) => warmPdfExport\(\), \[\]\);/);
  });
});
