// Settings' wider CSP must not be inherited: leaving (or arriving at, by Back/Forward) /settings reloads the document. Real header proof: tests/e2e/settings-csp-navigation.spec.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SettingsCspBoundary", () => {
  const src = readFileSync("components/security/settings-csp-boundary.tsx", "utf8");
  it("reloads the address as a document load when the path crosses the /settings boundary", () => {
    expect(src).toContain('(previous.current === "/settings") !== (pathname === "/settings")');
    expect(src).toContain("window.location.replace(window.location.href)");
  });
  it("is mounted beside UiV2Skin in the dashboard layout, and the global CSP is untouched", () => {
    expect(readFileSync("app/(dashboard)/layout.tsx", "utf8")).toContain("<UiV2Skin /><SettingsCspBoundary />");
    expect(readFileSync("next.config.mjs", "utf8")).toContain('{ source: "/settings", headers: [{ key: "Content-Security-Policy", value: settingsCsp }] }');
  });
});
