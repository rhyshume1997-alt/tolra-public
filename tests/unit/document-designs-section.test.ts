// @vitest-environment jsdom
/**
 * Module J: an ordinary Settings visit does no document-template work. The Settings page mounts only DocumentDesignsSection, a closed card; the real
 * card (store reads, design list, PDF preview) is imported only once it is opened, or when the page is reached on #setup-designs. Also checks, from the
 * source, that Settings and the section import nothing that loads the PDF code, the design list or the template store.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ cardModuleLoaded: 0, store: 0, company: 0, pdf: 0 }));
vi.mock("@/components/document-templates/document-designs-card", () => {
  probe.cardModuleLoaded += 1;
  return { DocumentDesignsCard: () => createElement("div", { "data-testid": "real-card" }, "real card") };
});
vi.mock("@/lib/document-templates/document-template-store", () => { probe.store += 1; return { loadDocumentTemplates: async () => ({ enabled: false }), saveDocumentTemplates: async () => ({ enabled: false }) }; });
vi.mock("@react-pdf/renderer", () => { probe.pdf += 1; return {}; });
vi.mock("@/lib/company", () => { probe.company += 1; return { loadCompanyProfile: async () => null }; });

import { DocumentDesignsSection } from "@/components/document-templates/document-designs-section";

const ROOT = join(__dirname, "..", "..");
let host: HTMLDivElement;
let root: Root;
const mount = async () => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root.render(createElement(DocumentDesignsSection)); }); };
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.location.hash = ""; });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("DocumentDesignsSection", () => {
  it("closed by default: shows the title and an Open button, and loads nothing (no card, no store, no company profile, no PDF code)", async () => {
    await mount(); await settle();
    expect(host.querySelector("#setup-designs")?.textContent).toContain("Document designs");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open document designs"]);
    expect(host.querySelector('[data-testid="real-card"]')).toBeNull();
    expect(probe).toEqual({ cardModuleLoaded: 0, store: 0, company: 0, pdf: 0 });
  });

  it("opening it loads the real card", async () => {
    await mount();
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    await settle();
    expect(host.querySelector('[data-testid="real-card"]')).not.toBeNull();
    expect(probe.cardModuleLoaded).toBe(1);
  });

  it("arriving on #setup-designs (the company setup's link) opens it, and so does a later hash change", async () => {
    window.location.hash = "#setup-designs";
    await mount(); await settle();
    expect(host.querySelector('[data-testid="real-card"]')).not.toBeNull();
  });

  it("a hash change after the page loaded opens it too", async () => {
    await mount(); await settle();
    expect(host.querySelector('[data-testid="real-card"]')).toBeNull();
    await act(async () => { window.location.hash = "#setup-designs"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await settle();
    expect(host.querySelector('[data-testid="real-card"]')).not.toBeNull();
  });
});

describe("what Settings imports for Document designs (from the source)", () => {
  const imports = (file: string) => [...readFileSync(join(ROOT, file), "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  it("the Settings page imports the closed section, never the real card, the design list, the store or the PDF code", () => {
    const list = imports("app/(dashboard)/settings/page.tsx");
    expect(list).toContain("@/components/document-templates/document-designs-section");
    for (const forbidden of ["@/components/document-templates/document-designs-card", "@/components/pdf/templates/registry", "@/lib/document-templates/document-template-store", "@/lib/document-templates/sample-documents", "@react-pdf/renderer"]) expect(list).not.toContain(forbidden);
  });
  it("the section imports the real card only through a dynamic import()", () => {
    const source = readFileSync(join(ROOT, "components/document-templates/document-designs-section.tsx"), "utf8");
    expect(imports("components/document-templates/document-designs-section.tsx")).not.toContain("@/components/document-templates/document-designs-card");
    expect(source).toMatch(/lazy\(\(\) => import\("@\/components\/document-templates\/document-designs-card"\)/);
    for (const forbidden of ["@react-pdf/renderer", "@/lib/company", "@/lib/supabase", "document-template-store", "templates/registry"]) expect(source).not.toContain(`"${forbidden}`);
  });
});
