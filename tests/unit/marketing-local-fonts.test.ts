import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { marketingFontVariables } from "@/components/marketing/fonts";
const root = path.resolve(__dirname, "../..");
describe("marketing fonts build without a Google download", () => {
  it("uses only local font loading and retains all three scoped marketing variables", () => {
    const source = readFileSync(path.join(root, "components/marketing/fonts.ts"), "utf8");
    expect(source).toContain('from "next/font/local"');
    expect(source).not.toMatch(/next\/font\/google|https?:\/\//);
    expect(marketingFontVariables).toBe("--mk-font-display --mk-font-sans --mk-font-mono");
  });
  it("ships actual WOFF2 data for the same five family/weight combinations", () => {
    const source = readFileSync(path.join(root, "components/marketing/fonts.ts"), "utf8");
    const files = [...source.matchAll(/"(\.\.\/\.\.\/node_modules\/[^"\n]+\.woff2)"/g)].map(match => match[1]);
    expect(files.map(file => path.basename(file))).toEqual([
      "barlow-condensed-latin-600-normal.woff2", "ibm-plex-sans-latin-400-normal.woff2", "ibm-plex-sans-latin-600-normal.woff2",
      "ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-mono-latin-500-normal.woff2",
    ]);
    for (const file of files) {
      const buffer = readFileSync(path.resolve(root, "components/marketing", file));
      expect(buffer.subarray(0, 4).toString()).toBe("wOF2"); expect(buffer.length).toBeGreaterThan(1000);
    }
  });
});
