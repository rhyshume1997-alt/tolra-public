/**
 * BOUNDARY (guardrail for docs/HARD_RULES.md rule 3: "Extract from large pages, never grow them").
 * Input: the four designated oversized pages, read from disk. Output: a failing unit test (so a red `web` job and a red
 * ci-gate) when any of them is larger, in bytes, than it was on main at 0cea2ee5 (9 Nov 2026).
 * Must not be changed: a ceiling may only be LOWERED, in the same change that extracts code out of that page. Raising a
 * ceiling, removing a page from the list or skipping this test needs Rhys's explicit approval.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/** Size in bytes of each page on main at 0cea2ee50baa777683eef729dc23f053cd266f31. */
const PAGE_BYTE_CEILINGS: Record<string, number> = {
  "app/(dashboard)/jobs/page.tsx": 143_123,
  "app/(dashboard)/invoices/page.tsx": 125_164,
  "app/(dashboard)/quotes/page.tsx": 108_823,
  "app/(dashboard)/schedule/page.tsx": 55_956,
};

/** The message for a page over its ceiling, or null when it is within it. */
function growthProblem(file: string, bytes: number, ceiling: number): string | null {
  if (bytes <= ceiling) return null;
  return `${file} is ${bytes} bytes, ${bytes - ceiling} over its ceiling of ${ceiling}. Extract code into components/ or lib/ instead of adding to this page (docs/HARD_RULES.md rule 3).`;
}

describe("oversized pages never grow", () => {
  it("covers the Jobs, Invoices, Quotes and Schedule pages", () => {
    expect(Object.keys(PAGE_BYTE_CEILINGS)).toEqual([
      "app/(dashboard)/jobs/page.tsx",
      "app/(dashboard)/invoices/page.tsx",
      "app/(dashboard)/quotes/page.tsx",
      "app/(dashboard)/schedule/page.tsx",
    ]);
  });

  it.each(Object.entries(PAGE_BYTE_CEILINGS))("%s is no larger than its ceiling", (file, ceiling) => {
    // A missing page throws here, so a page cannot leave the check by being moved or renamed.
    const bytes = statSync(path.join(ROOT, file)).size;
    expect(growthProblem(file, bytes, ceiling)).toBeNull();
  });

  it("reports a page that grows by a single byte, and accepts one that is equal or smaller", () => {
    expect(growthProblem("app/(dashboard)/jobs/page.tsx", 143_124, 143_123)).toBe(
      "app/(dashboard)/jobs/page.tsx is 143124 bytes, 1 over its ceiling of 143123. Extract code into components/ or lib/ instead of adding to this page (docs/HARD_RULES.md rule 3).",
    );
    expect(growthProblem("app/(dashboard)/jobs/page.tsx", 143_123, 143_123)).toBeNull();
    expect(growthProblem("app/(dashboard)/jobs/page.tsx", 100_000, 143_123)).toBeNull();
  });
});
