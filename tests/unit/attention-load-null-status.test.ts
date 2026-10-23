import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { invoiceStatus } from "@/lib/receivables";

describe("the dashboard's invoice loader keeps drafts with no status", () => {
  const source = readFileSync("lib/attention-load.ts", "utf8");

  it("a missing status is a draft in the app", () => {
    expect(invoiceStatus(null)).toBe("draft");
  });

  it("the loader reads status null OR not paid (a bare .neq drops NULL rows in SQL)", () => {
    expect(source).toContain('.or("status.is.null,status.neq.paid")');
    expect(source).not.toContain('.neq("status", "paid")');
  });
});
