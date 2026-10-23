import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hm, hmSigned } from "@/lib/time-sheet";

describe("hmSigned: a zero total never carries a minus sign", () => {
  it("shows 0:00 for a deduction of nothing, including negative zero", () => {
    expect(hmSigned(-0)).toBe("0:00");
    expect(hmSigned(0)).toBe("0:00");
    expect(hmSigned(-0.4)).toBe("0:00"); // rounds to nothing
  });

  it("shows a real deduction with the minus sign", () => {
    expect(hmSigned(-45)).toBe("−0:45");
    expect(hmSigned(-270)).toBe("−4:30");
    expect(hmSigned(-0.6)).toBe("−0:01");
  });

  it("a positive time has no sign and matches hm", () => {
    expect(hmSigned(435)).toBe("7:15");
    expect(hmSigned(435)).toBe(hm(435));
  });
});

describe("Breaks are shown through hmSigned, never as a bare minus beside hm", () => {
  for (const file of ["components/time/week-review.tsx", "components/time/time-print.tsx", "components/time/day-sheet.tsx"]) {
    it(file, () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/−\{hm\(|`−\$\{hm\(/);
      expect(source).toContain("hmSigned(-");
    });
  }
});
