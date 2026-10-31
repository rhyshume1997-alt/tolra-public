/**
 * Phone lag (fix 1): @react-pdf/renderer (about 460 kB gzipped) is loaded when a PDF or export button is pressed, not with the
 * page. No list page reaches it through a static import any more, and the PDF a button makes is unchanged: the same document,
 * the same file name and the same audit entry.
 */
import { createElement } from "react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");

// ---- the buttons still make the same file (first: nothing in this file has loaded the renderer yet) -----------------------
const hoisted = vi.hoisted(() => ({ rendererLoaded: false, rendered: [] as unknown[] }));
vi.mock("@react-pdf/renderer", async (importOriginal) => {
  hoisted.rendererLoaded = true;
  return {
    ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
    pdf: (element: unknown) => {
      hoisted.rendered.push(element);
      return { toBlob: async () => new Blob(["%PDF"]) };
    },
  };
});
const audit = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async (event: unknown) => { audit.events.push(event); }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const downloads: string[] = [];
beforeEach(() => {
  downloads.length = 0;
  audit.events.length = 0;
  hoisted.rendered.length = 0;
  vi.stubGlobal("document", {
    createElement: () => {
      const link = { href: "", download: "", click: () => downloads.push(link.download), remove: () => undefined };
      return link;
    },
    body: { appendChild: () => undefined },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the PDF and export buttons load the renderer on the press and make the same file", () => {
  it("downloadPdf: nothing loaded until a PDF is made; then the given document is rendered and saved under the given name", async () => {
    const { downloadPdf } = await import("@/lib/download-pdf");
    expect(hoisted.rendererLoaded).toBe(false);
    const element = createElement("div", { id: "quote" });
    const ok = await downloadPdf(async () => element, "quote-Q-0001.pdf", { entityTable: "quotes", entityId: "Q-0001" });
    expect(ok).toBe(true);
    expect(hoisted.rendererLoaded).toBe(true);
    expect(hoisted.rendered).toEqual([element]);
    expect(downloads).toEqual(["quote-Q-0001.pdf"]);
    expect(audit.events).toEqual([{ action: "DOWNLOAD_PDF", entityTable: "quotes", entityId: "Q-0001", metadata: { filename: "quote-Q-0001.pdf" } }]);
  });

  it("exportRows(\"pdf\"): the shared document with the export's rows, saved as <title>.pdf", async () => {
    const { JNR_PROFILE } = await import("@/lib/company");
    vi.doMock("@/lib/company", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/company")>()), requireCompanyProfile: async () => JNR_PROFILE }));
    vi.resetModules();
    const { exportRows, EXPORT_TITLES } = await import("@/lib/export-records");
    const { BaseDocumentPDF } = await import("@/components/pdf/BaseDocumentPDF");
    await exportRows("pdf", EXPORT_TITLES.quotes, [{ Ref: "Q-0001", Customer: "Synthetic Customer Ltd" }], "quotes");
    expect(downloads).toEqual(["Quotes Export.pdf"]);
    expect(hoisted.rendered).toHaveLength(1);
    const element = hoisted.rendered[0] as { type: unknown; props: { data: { title: string; lineItems: unknown[]; billTo: string[] } } };
    expect(element.type).toBe(BaseDocumentPDF);
    expect(element.props.data).toMatchObject({ title: "Quotes Export", billTo: [JNR_PROFILE.name], lineItems: [{ description: "Ref: Q-0001 | Customer: Synthetic Customer Ltd", quantity: 1 }] });
    vi.doUnmock("@/lib/company");
  });
});

// ---- static import graph ----------------------------------------------------------------------------------------------------
/** The modules a file imports at load time: `import type` (erased) and `import()` (on demand) are not followed. */
function staticImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specs: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(?!type\s)([^;]*?)\s+from\s+"([^"]+)"/gm)) specs.push(m[3]);
  for (const m of code.matchAll(/^\s*import\s+"([^"]+)"/gm)) specs.push(m[1]);
  return specs;
}

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** True when `entry` reaches `pkg` through static imports only. */
function reachesStatically(entry: string, pkg: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, trail: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      if (spec === pkg || spec.startsWith(`${pkg}/`)) return [...trail, file, spec];
      const next = resolveLocal(spec, file);
      if (next) {
        const found = walk(next, [...trail, file]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(entry, []);
}

const PAGES = ["jobs", "quotes", "invoices", "sales-orders", "delivery-notes", "purchase-orders", "customers", "suppliers", "time/week"];

describe("the PDF renderer is not part of any list page's first load", () => {
  for (const page of PAGES) {
    it(`/${page}`, () => {
      const entry = join(ROOT, "app", "(dashboard)", page, "page.tsx");
      expect(reachesStatically(entry, "@react-pdf/renderer"), `/${page} imports the PDF renderer through`).toBeNull();
    });
  }

  it("the walker does find it where it is still imported up front (the documents themselves and the year-end pack)", () => {
    expect(reachesStatically(join(ROOT, "components", "pdf", "QuotePDF.tsx"), "@react-pdf/renderer")).not.toBeNull();
    expect(reachesStatically(join(ROOT, "lib", "year-end-export.tsx"), "@react-pdf/renderer")).not.toBeNull();
  });

  it("the totals helpers come from a module without the renderer, and BaseDocumentPDF still re-exports the same functions", async () => {
    expect(reachesStatically(join(ROOT, "components", "pdf", "pdf-totals.ts"), "@react-pdf/renderer")).toBeNull();
    expect(reachesStatically(join(ROOT, "lib", "invoice-totals.ts"), "@react-pdf/renderer")).toBeNull();
    const [base, totals] = await Promise.all([import("@/components/pdf/BaseDocumentPDF"), import("@/components/pdf/pdf-totals")]);
    expect(base.computePdfTotals).toBe(totals.computePdfTotals);
    expect(base.resolvePdfTotals).toBe(totals.resolvePdfTotals);
    expect(base.storedTotalsProblem).toBe(totals.storedTotalsProblem);
  });
});
