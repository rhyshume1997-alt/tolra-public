import { describe, expect, it } from "vitest";

import { defaultNoteSource } from "@/lib/delivery-note-source";

describe("defaultNoteSource", () => {
  it("office and admin open on From a job when there are jobs to pick", () => {
    expect(defaultNoteSource("office", true)).toBe("job");
    expect(defaultNoteSource("admin", true)).toBe("job");
  });

  it("office and admin open on the sales order when no job was made from an order", () => {
    expect(defaultNoteSource("office", false)).toBe("order");
    expect(defaultNoteSource("admin", false)).toBe("order");
  });

  it("the workshop always opens on From a job, as before", () => {
    expect(defaultNoteSource("workshop", false)).toBe("job");
    expect(defaultNoteSource("workshop", true)).toBe("job");
  });

  it("an unknown role keeps the sales order default", () => {
    expect(defaultNoteSource(null, true)).toBe("order");
    expect(defaultNoteSource(undefined, true)).toBe("order");
  });
});
