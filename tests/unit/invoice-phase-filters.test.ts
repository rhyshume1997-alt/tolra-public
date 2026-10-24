import { describe, expect, it } from "vitest";

import { chipsForPhase } from "@/lib/invoice-phase-filters";

describe("invoice status chips by Show tab", () => {
  it("drops Paid when the tab becomes Open, and Overdue/Outstanding when it becomes Done", () => {
    expect([...chipsForPhase(new Set(["paid"]), "open")]).toEqual(["all"]);
    expect([...chipsForPhase(new Set(["overdue"]), "done")]).toEqual(["all"]);
    expect([...chipsForPhase(new Set(["partial", "paid"]), "open")]).toEqual(["partial"]);
    expect([...chipsForPhase(new Set(["outstanding", "paid"]), "done")]).toEqual(["paid"]);
  });
  it("keeps everything for Archived and All, and keeps All", () => {
    expect([...chipsForPhase(new Set(["paid", "overdue"]), "archived")]).toEqual(["paid", "overdue"]);
    expect([...chipsForPhase(new Set(["paid"]), "all")]).toEqual(["paid"]);
    expect([...chipsForPhase(new Set(["all"]), "done")]).toEqual(["all"]);
  });
});
