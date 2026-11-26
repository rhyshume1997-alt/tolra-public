/**
 * Settings entry links are full document loads (so the /settings Content-Security-Policy header applies). Reads sources (not rendered here).
 * Must not change: the global policy is not widened; only /settings uses this path list.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { needsFullDocumentLoad } from "@/lib/full-document-load";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");

describe("Settings entry is a full document load", () => {
  it("only /settings (with or without hash, query or trailing slash) needs it", () => {
    expect(needsFullDocumentLoad("/settings")).toBe(true);
    expect(needsFullDocumentLoad("/settings#workshop-network")).toBe(true);
    expect(needsFullDocumentLoad("/settings?x=1")).toBe(true);
    expect(needsFullDocumentLoad("/settings/")).toBe(true);
    for (const other of ["/dashboard", "/settings-old", "/admin/users", "/jobs", "/"]) expect(needsFullDocumentLoad(other), other).toBe(false);
  });

  it("the sidebar renders a plain <a> for those routes and keeps next/link for the rest", () => {
    const sidebar = read("components/sidebar.tsx");
    expect(sidebar).toContain("needsFullDocumentLoad(item.href) ? (");
    expect(sidebar).toMatch(/<a key=\{item\.href\} href=\{item\.href\}/);
    expect(sidebar).toMatch(/<Link key=\{item\.href\} href=\{item\.href\}/);
  });

  it("the unrecognised-network banner link to Settings is a plain <a>", () => {
    const banner = read("components/time/unrecognised-network-banner.tsx");
    expect(banner).toMatch(/<a [^>]*href="\/settings#workshop-network"/);
    expect(banner).not.toMatch(/<Link [^>]*href="\/settings/);
  });

  it("the company setup guide links to Settings steps as plain <a> (it shows on other pages, where a client navigation would keep their policy)", () => {
    const guide = read("components/company-setup-guide.tsx");
    expect(guide).toContain("needsFullDocumentLoad(step.href) ? <a href={step.href}");
    const progress = read("lib/company-setup/progress.ts");
    for (const href of progress.match(/href: "\/settings[^"]*"/g) ?? []) expect(needsFullDocumentLoad(href.slice(7, -1)), href).toBe(true);
  });
});
