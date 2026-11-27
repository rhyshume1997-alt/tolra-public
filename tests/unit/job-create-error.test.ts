import { describe, expect, it } from "vitest";
import { jobCreateErrorMessage, uncertainJobCreateMessage } from "@/lib/job-create-error";
import { ValidationError } from "@/lib/validation/schemas";

describe("jobCreateErrorMessage (CR-014 Module 2)", () => {
  it("never claims nothing was saved on uncertain network or server failures", () => {
    for (const label of ["delivery note", "inspection"] as const) {
      const msgNetwork = jobCreateErrorMessage(new Error("Failed to fetch"), label);
      expect(msgNetwork).toBe(uncertainJobCreateMessage(label));
      expect(msgNetwork.toLowerCase()).not.toContain("nothing was saved");

      const msgTimeout = jobCreateErrorMessage({ code: "57014", message: "timeout" }, label);
      expect(msgTimeout).toBe(uncertainJobCreateMessage(label));
      expect(msgTimeout.toLowerCase()).not.toContain("nothing was saved");
    }
  });

  it("preserves definite validation and database refusals", () => {
    expect(jobCreateErrorMessage(new ValidationError("Bad quantity"), "delivery note")).toBe("Bad quantity");

    const notAuthorised = jobCreateErrorMessage(
      { code: "42501", hint: "not_authorised_inspector", message: "Only an authorised inspector can record an inspection." },
      "inspection",
    );
    expect(notAuthorised).toContain("authorised inspector");

    const paused = jobCreateErrorMessage(
      { code: "P0001", hint: "dln_numbering_not_set", message: "paused" },
      "delivery note",
    );
    expect(paused).toContain("Delivery notes are paused");
  });
});
