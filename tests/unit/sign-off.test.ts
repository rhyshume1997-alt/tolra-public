import { describe, expect, it } from "vitest";

import { signOffState } from "@/lib/job-worksheet";

describe("printed sign-off (R5)", () => {
  it("signed only with a time; a leftover name is 'unsigned'; nothing is blank", () => {
    expect(signOffState({ signed_off_by: "Dave", signed_off_at: "2026-10-09T13:05:00Z" })).toMatchObject({ status: "signed", name: "Dave" });
    expect(signOffState({ signed_off_by: "Dave", signed_off_at: "" })).toEqual({ status: "unsigned", name: "Dave" });
    expect(signOffState({ signed_off_by: "  ", signed_off_at: "" })).toEqual({ status: "blank" });
  });
});
