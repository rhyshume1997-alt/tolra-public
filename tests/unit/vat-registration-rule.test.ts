/**
 * The app's "is this company VAT registered" rule, pinned to the same cases as the server's
 * public.org_vat_registered (migration 030, tests/db/issue-vat-registration.test.ts): only JSON false means not
 * registered; missing, null, true, the string "false" and 0 all count as registered.
 */
import { describe, expect, it } from "vitest";

import { parseCompanyProfile } from "@/lib/company";
import { companyVat } from "@/lib/vat";

const base = { documentName: "Synthetic Co", addressLines: ["1 Test Street"], vatNumber: "GB000000000" };

describe("VAT registration rule (app side, matches org_vat_registered)", () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["false", { ...base, vatRegistered: false }, false],
    ["true", { ...base, vatRegistered: true }, true],
    ["missing", { ...base }, true],
    ["null", { ...base, vatRegistered: null }, true],
    ["string 'false'", { ...base, vatRegistered: "false" }, true],
    ["0", { ...base, vatRegistered: 0 }, true],
  ];
  for (const [label, stored, expected] of cases) {
    it(`${label} -> ${expected ? "registered" : "not registered"}`, () => {
      const profile = parseCompanyProfile(JSON.parse(JSON.stringify(stored)));
      expect(profile?.vatRegistered).toBe(expected);
      expect(companyVat(profile).registered).toBe(expected);
    });
  }
});
