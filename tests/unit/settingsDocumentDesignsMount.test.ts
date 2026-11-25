// @vitest-environment jsdom
/**
 * BOUNDARY (Settings preview, PREVIEW ONLY). Inputs: the SOURCE of components/settings/preview/SettingsPreview.tsx and the rendered Settings preview.
 * Outputs: pins that the Document designs panel is mounted exactly once in the Settings preview, after the Company details block (id="setup-company") and before the
 * archive card, and that the panel carries id="setup-designs". Must not change: no real settings, no network; it only reads and renders the preview.
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import SettingsPreview from "@/components/settings/preview/SettingsPreview";

const SRC = fs.readFileSync(path.join(process.cwd(), "components/settings/preview/SettingsPreview.tsx"), "utf8");

describe("Settings preview mounts the Document designs panel", () => {
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  afterEach(() => { act(() => root?.unmount()); host?.remove(); host = null; root = null; });

  it("imports the panel and renders it exactly once, between Company details and the archive card", () => {
    expect(SRC).toContain('import { DocumentDesignsPanel } from "@/components/settings/preview/DocumentDesignsPreview";');
    expect(SRC.match(/<DocumentDesignsPanel /g)?.length).toBe(1);
    const company = SRC.indexOf('<div id="setup-company">');
    const panel = SRC.indexOf("<DocumentDesignsPanel preview={preview} />");
    const archive = SRC.indexOf("<ArchiveCard preview={preview} />");
    expect(company).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(company);
    expect(archive).toBeGreaterThan(panel);
  });

  it("the rendered page has one #setup-designs panel, after #setup-company", () => {
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(createElement(SettingsPreview)));
    expect(host.querySelectorAll("#setup-designs").length).toBe(1);
    const company = host.querySelector("#setup-company")!;
    const designs = host.querySelector("#setup-designs")!;
    expect(company.compareDocumentPosition(designs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(designs.textContent).toContain("Document designs");
  });
});
