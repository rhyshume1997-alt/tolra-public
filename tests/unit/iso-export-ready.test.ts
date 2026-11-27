// ISO exports are allowed only after a complete read for one company.
import { describe, expect, it } from "vitest";
import { isoReadIsComplete } from "@/lib/iso/iso-export-ready";
import { failedIsoEvidence } from "@/lib/iso/load-iso-evidence-safe";

const company = { name: "Co" } as never;
const ok = { ...failedIsoEvidence(), unread: [] as string[] };

describe("isoReadIsComplete", () => {
  it("complete read (empty evidence included) is allowed", () => expect(isoReadIsComplete("a", "a", "a", company, ok)).toBe(true));
  it("failed and partial reads are blocked", () => {
    expect(isoReadIsComplete("a", "a", "a", company, failedIsoEvidence())).toBe(false);
    expect(isoReadIsComplete("a", "a", "a", company, { ...ok, unread: ["suppliers"] })).toBe(false);
  });
  it("a company mismatch before or after is blocked", () => {
    expect(isoReadIsComplete("a", "b", "a", company, ok)).toBe(false);
    expect(isoReadIsComplete("a", "a", "b", company, ok)).toBe(false);
  });
  it("a missing company id or profile is blocked", () => {
    expect(isoReadIsComplete(null, null, null, company, ok)).toBe(false);
    expect(isoReadIsComplete("a", "a", "a", null, ok)).toBe(false);
  });
});
