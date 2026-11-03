import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE = readFileSync(path.join(ROOT, "components/marketing/fonts.ts"), "utf8");

describe("public pages' fonts do not depend on a build-time download", () => {
  it("uses next/font/local, never next/font/google", () => {
    expect(SOURCE).toContain('from "next/font/local"');
    expect(SOURCE).not.toContain("next/font/google");
  });

  it("every font file the setup names is committed, a real woff2, and has the same three CSS variables as before", () => {
    const files = [...SOURCE.matchAll(/path: "(\.\/fonts-files\/[^"]+)"/g)].map((m) => m[1]);
    expect(files).toHaveLength(5);
    for (const f of files) {
      const full = path.join(ROOT, "components/marketing", f);
      expect(existsSync(full), f).toBe(true);
      expect(readFileSync(full).subarray(0, 4).toString("latin1"), `${f} is woff2`).toBe("wOF2");
    }
    for (const v of ["--mk-font-display", "--mk-font-sans", "--mk-font-mono"]) expect(SOURCE).toContain(`"${v}"`);
  });

  it("keeps the licence texts beside the fonts", () => {
    for (const n of ["barlow-condensed", "ibm-plex-sans", "ibm-plex-mono"]) {
      expect(existsSync(path.join(ROOT, `components/marketing/fonts-files/LICENSE-${n}.txt`)), n).toBe(true);
    }
  });
});
