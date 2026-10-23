import { describe, expect, it } from "vitest";

import { generatePassword, passwordProblem } from "@/lib/password";
import { MEMBER_SECTION_KEYS, sectionForPath, sectionsForRoles } from "@/lib/sections";

describe("password rules", () => {
  it("accepts 12+ characters with a letter and a number", () => {
    expect(passwordProblem("abcdefghijk1")).toBeNull();
    expect(passwordProblem("a1".repeat(36))).toBeNull(); // 72, the limit
  });
  it("rejects short, letter-only, digit-only and over-long passwords", () => {
    expect(passwordProblem("abcdefgh1")).toMatch(/12 characters/); // the old minimum of 8 is no longer enough
    expect(passwordProblem("abcdefghij1")).toMatch(/12 characters/); // 11
    expect(passwordProblem("abc1")).toMatch(/12 characters/);
    expect(passwordProblem("abcdefghijkl")).toMatch(/letter and one number/);
    expect(passwordProblem("123456789012")).toMatch(/letter and one number/);
    expect(passwordProblem(`a1${"x".repeat(80)}`)).toMatch(/72/);
  });
  it("generates passwords that pass the rules, without look-alike characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(14);
      expect(passwordProblem(password)).toBeNull();
      expect(password).not.toMatch(/[0O1lI]/);
    }
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50);
  });
});

describe("page sections", () => {
  it("maps pages to their section", () => {
    expect(sectionForPath("/quotes")).toBe("quotes");
    expect(sectionForPath("/quotes/new")).toBe("quotes");
    expect(sectionForPath("/purchase-orders/abc/print")).toBe("purchase-orders");
    expect(sectionForPath("/quotesx")).toBeNull();
    expect(sectionForPath("/dashboard")).toBeNull();
    expect(sectionForPath("/admin/users")).toBeNull();
    expect(sectionForPath("/settings")).toBeNull();
  });
  it("offers only the sections a person's roles allow", () => {
    expect(sectionsForRoles(["workshop"]).map((s) => s.key)).toEqual(["jobs", "schedule", "delivery-notes"]);
    expect(sectionsForRoles(["viewer", ""]).map((s) => s.key)).toEqual(["jobs", "schedule"]);
    expect(sectionsForRoles(["office", "workshop"]).map((s) => s.key)).toContain("delivery-notes");
    expect(sectionsForRoles(["admin"])).toHaveLength(MEMBER_SECTION_KEYS.length);
  });
  it("matches the database's list of keys (migration 012)", () => {
    expect(MEMBER_SECTION_KEYS).toEqual(["email", "rfq", "quotes", "sales-orders", "jobs", "schedule", "invoices", "approval",
      "purchase-orders", "delivery-notes", "customers", "suppliers"]);
  });
});
