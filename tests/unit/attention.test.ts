import { describe, expect, it } from "vitest";

import { attentionState } from "@/lib/attention";
import { deletedOne } from "@/lib/delete-result";

describe("attentionState", () => {
  it("only says all clear when nothing failed", () => {
    expect(attentionState(0, false)).toBe("clear");
    expect(attentionState(0, true)).toBe("incomplete");
    expect(attentionState(2, false)).toBe("items");
    expect(attentionState(2, true)).toBe("incomplete");
  });
});

describe("deletedOne", () => {
  it("needs exactly one deleted row back", () => {
    expect(deletedOne([{ id: "a" }])).toBe(true);
    expect(deletedOne([])).toBe(false);
    expect(deletedOne(null)).toBe(false);
    expect(deletedOne([{ id: "a" }, { id: "b" }])).toBe(false);
  });
});
