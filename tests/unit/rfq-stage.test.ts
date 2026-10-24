import { describe, expect, it } from "vitest";

import { linkedQuotes, matchesStatusFilter, rfqFigures, rfqSpec, rfqStage, rfqStageLabel, shouldMarkClarification, showsStatusBadge } from "@/lib/rfq-stage";

describe("RFQ stage and the intake status", () => {
  it("the stage comes from the linked quote, not from rfqs.status", () => {
    expect(rfqStage({ status: "new" }, undefined)).toBe("outstanding");
    expect(rfqStage({ status: "new" }, { ref: "QUO-1", status: "draft" })).toBe("quoted"); // go-live polish 11: a quote exists
    expect(rfqStage({ status: "new" }, { ref: "QUO-1", status: "sent" })).toBe("quoted");
    expect(rfqStage({ status: "new" }, { ref: "QUO-1", status: "accepted" })).toBe("won");
    expect(rfqStage({ status: "ready" }, { ref: "QUO-1", status: "rejected" })).toBe("lost");
    expect(rfqStage({ status: "quoted" }, undefined)).toBe("quoted");
  });

  it("the New / Clarification / Ready badge shows only while the RFQ is outstanding", () => {
    expect(showsStatusBadge("outstanding")).toBe(true);
    for (const stage of ["quoted", "won", "lost"] as const) expect(showsStatusBadge(stage)).toBe(false);
  });

  it("the status chips narrow outstanding RFQs only, so a quoted RFQ with the old status 'new' is never hidden by a chip", () => {
    expect(matchesStatusFilter(new Set(["all"]), "outstanding", "new")).toBe(true);
    expect(matchesStatusFilter(new Set(["ready"]), "outstanding", "new")).toBe(false);
    expect(matchesStatusFilter(new Set(["new"]), "outstanding", "new")).toBe(true);
    expect(matchesStatusFilter(new Set(["ready"]), "quoted", "new")).toBe(true);
    expect(matchesStatusFilter(new Set(["ready"]), "won", "new")).toBe(true);
  });
});

describe("RFQs with a quote are Quoted; one set of figures for RFQ Control and the dashboard (go-live polish 11, 18)", () => {
  it("the label says whether the quote has gone", () => {
    expect(rfqStageLabel("quoted", { ref: "QUO-0002", status: "draft" })).toBe("Quoted, draft");
    expect(rfqStageLabel("quoted", { ref: "QUO-0002", status: "sent" })).toBe("Quoted, awaiting reply");
    expect(rfqStageLabel("outstanding", undefined)).toBe("Outstanding");
  });
  it("the quote that speaks for an RFQ: accepted, then sent, then draft, then rejected; newest among equals", () => {
    const map = linkedQuotes([
      { rfq_id: "r1", quote_ref: "QUO-0001", status: "accepted", created_at: "2026-09-01" },
      { rfq_id: "r1", quote_ref: "QUO-0009", status: "draft", created_at: "2026-10-01" },
      { rfq_id: "r2", quote_ref: "QUO-0002", status: "draft", created_at: "2026-09-01" },
      { rfq_id: "r2", quote_ref: "QUO-0004", status: "draft", created_at: "2026-10-01" },
      { rfq_id: null, quote_ref: "QUO-0005", status: "sent" },
    ]);
    expect(map.get("r1")).toEqual({ ref: "QUO-0001", status: "accepted" });
    expect(map.get("r2")).toEqual({ ref: "QUO-0004", status: "draft" });
    expect(map.size).toBe(2);
  });
  it("outstanding = no quote yet; New / Clarification / Ready count outstanding RFQs only", () => {
    const rfqs = [
      { id: "a", status: "new" }, { id: "b", status: "new" }, { id: "c", status: "new" }, { id: "d", status: "ready" }, { id: "e", status: "clarification" },
      { id: "f", status: "new" }, { id: "g", status: "ready" }, { id: "h", status: "new" },
    ];
    const linked = linkedQuotes([
      { rfq_id: "f", quote_ref: "QUO-0002", status: "draft" },
      { rfq_id: "g", quote_ref: "QUO-0004", status: "sent" },
      { rfq_id: "h", quote_ref: "QUO-0006", status: "accepted" },
    ]);
    expect(rfqFigures(rfqs, linked)).toEqual({ outstanding: 5, new: 3, clarification: 1, ready: 1, quoted: 2, won: 1, lost: 0 });
  });
});

describe("linkedQuotes keeps the quote id for deep links", () => {
  it("carries the id of the quote that speaks for the RFQ", () => {
    const map = linkedQuotes([
      { id: "q1", rfq_id: "r1", quote_ref: "QUO-1", status: "draft", created_at: "2026-01-01" },
      { id: "q2", rfq_id: "r1", quote_ref: "QUO-2", status: "sent", created_at: "2026-01-02" },
    ]);
    expect(map.get("r1")).toEqual({ id: "q2", ref: "QUO-2", status: "sent" });
  });
});

describe("rfqSpec: the quantity and material shown in the RFQ View dialog", () => {
  it("returns what was stored, and nothing for 0, blank or missing", () => {
    expect(rfqSpec(50, "Titanium Grade 5")).toEqual({ quantity: 50, material: "Titanium Grade 5" });
    expect(rfqSpec("12", "  Mild Steel ")).toEqual({ quantity: 12, material: "Mild Steel" });
    expect(rfqSpec(0, "")).toEqual({ quantity: null, material: "" });
    expect(rfqSpec(null, null)).toEqual({ quantity: null, material: "" });
    expect(rfqSpec(undefined, undefined)).toEqual({ quantity: null, material: "" });
  });
});

describe("shouldMarkClarification", () => {
  it("moves only outstanding RFQs that are not already in clarification; a quoted, won or lost RFQ is never moved back", () => {
    expect(shouldMarkClarification({ status: "new" }, undefined)).toBe(true);
    expect(shouldMarkClarification({ status: "ready" }, undefined)).toBe(true);
    expect(shouldMarkClarification({ status: "clarification" }, undefined)).toBe(false);
    expect(shouldMarkClarification({ status: "quoted" }, undefined)).toBe(false);
    expect(shouldMarkClarification({ status: "new" }, { ref: "QUO-1", status: "draft" })).toBe(false);
    expect(shouldMarkClarification({ status: "ready" }, { ref: "QUO-1", status: "accepted" })).toBe(false);
    expect(shouldMarkClarification({ status: "new" }, { ref: "QUO-1", status: "rejected" })).toBe(false);
  });
});
