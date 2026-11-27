import { describe, expect, it } from "vitest";
import {
  financeCreateErrorMessage,
  uncertainFinanceCreateMessage,
} from "@/lib/finance-create-error";
import { ValidationError } from "@/lib/validation/schemas";

describe("financeCreateErrorMessage (CR-014 Module 4)", () => {
  it("never claims nothing was saved on uncertain network or server failures", () => {
    for (const label of ["invoice", "delivery note", "purchase order", "credit note"] as const) {
      const msgNetwork = financeCreateErrorMessage(new Error("Failed to fetch"), label);
      expect(msgNetwork).toBe(uncertainFinanceCreateMessage(label));
      expect(msgNetwork.toLowerCase()).not.toContain("nothing was saved");

      const msg500 = financeCreateErrorMessage({ code: "57014", message: "statement timeout" }, label);
      expect(msg500).toBe(uncertainFinanceCreateMessage(label));
      expect(msg500.toLowerCase()).not.toContain("nothing was saved");
    }
  });

  it("preserves definite client validation refusals", () => {
    const msg = financeCreateErrorMessage(new ValidationError("Customer is required."), "invoice");
    expect(msg).toBe("Customer is required.");
  });

  it("preserves definite database refusals and fixed hints", () => {
    const perm = financeCreateErrorMessage({ code: "42501", message: "permission denied" }, "purchase order");
    expect(perm).toBe("You don't have permission to do that.");

    const held = financeCreateErrorMessage(
      { code: "P0001", hint: "dln_numbering_not_set", message: "paused" },
      "delivery note",
    );
    expect(held).toContain("Delivery notes are paused");

    const draftExists = financeCreateErrorMessage(
      { code: "23514", hint: "job_has_draft", message: "This job already has a draft invoice." },
      "invoice",
    );
    expect(draftExists).toContain("already has a draft invoice");
  });
});
