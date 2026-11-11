import { describe, expect, it } from "vitest";

import { buildGapChecklist, EMPTY_EVIDENCE, GAP_STATUSES, NOT_EVIDENCED, rule72, rule753, rule84, rule852, ruleDrawingRevision, type GapEvidence } from "@/lib/iso/gap-checklist";
import { summariseJobs } from "@/lib/iso/load-iso-evidence";

const status = (e: GapEvidence, clause: string) => buildGapChecklist(e).find((r) => r.clause === clause)!.status;
const ALWAYS = ["4.1", "4.2", "4.3", "5.2", "6.1", "6.2", "7.1.5", "7.3", "9.1.2", "9.2", "9.3", "10.1"];
const FULL: GapEvidence = {
  inspectors: { current: 3, withReason: 3 }, changeHistoryPresent: true,
  drawingRevision: { flagged: 4, finished: 4, finishedMissing: 0, truncated: false },
  suppliers: { total: 5, approved: 4, conditional: 1, blocked: 0, truncated: false },
  traceability: { flagged: 4, finished: 2, finishedMissing: 0, truncated: false },
};

describe("gap checklist", () => {
  it("defaults every clause to Not evidenced by Tolra, and never Met without evidence", () => {
    const rows = buildGapChecklist(EMPTY_EVIDENCE);
    expect(rows.every((r) => r.status === NOT_EVIDENCED)).toBe(true);
    expect(GAP_STATUSES).toEqual(["Met", "Minor", "Major", "Not evidenced by Tolra"]);
  });
  it("clauses with no Tolra records are always Not evidenced, even with full evidence", () => {
    for (const clause of ALWAYS) expect(status(FULL, clause)).toBe(NOT_EVIDENCED);
  });
  it("lists every clause once, in order", () => {
    const clauses = buildGapChecklist(FULL).map((r) => r.clause);
    expect(clauses).toEqual(["4.1", "4.2", "4.3", "5.2", "6.1", "6.2", "7.1.5", "7.2", "7.3", "7.5.3", "8.2", "8.4", "8.5.1", "8.5.2", "9.1.2", "9.2", "9.3", "10.1"]);
  });
  it("7.2 inspectors", () => {
    expect(rule72(null).status).toBe(NOT_EVIDENCED);
    expect(rule72({ current: 0, withReason: 0 }).status).toBe(NOT_EVIDENCED);
    expect(rule72({ current: 2, withReason: 2 }).status).toBe("Met");
    expect(rule72({ current: 2, withReason: 1 }).status).toBe("Minor");
  });
  it("7.5.3 is never Met", () => {
    expect(rule753(null).status).toBe(NOT_EVIDENCED);
    expect(rule753(false).status).toBe(NOT_EVIDENCED);
    expect(rule753(true).status).toBe("Minor");
  });
  it("8.2 and 8.5.1 drawing revision", () => {
    const f = (o: Partial<NonNullable<GapEvidence["drawingRevision"]>>) => ruleDrawingRevision({ flagged: 2, finished: 1, finishedMissing: 0, truncated: false, ...o }).status;
    expect(ruleDrawingRevision(null).status).toBe(NOT_EVIDENCED);
    expect(f({ flagged: 0, finished: 0 })).toBe(NOT_EVIDENCED);
    expect(f({})).toBe("Met");
    expect(f({ finished: 0 })).toBe("Minor");
    expect(f({ truncated: true })).toBe("Minor");
    expect(f({ finishedMissing: 1 })).toBe("Major");
    expect(status(FULL, "8.2")).toBe(status(FULL, "8.5.1"));
  });
  it("8.4 supplier status", () => {
    const f = (o: Partial<NonNullable<GapEvidence["suppliers"]>>) => rule84({ total: 3, approved: 3, conditional: 0, blocked: 0, truncated: false, ...o }).status;
    expect(rule84(null).status).toBe(NOT_EVIDENCED);
    expect(f({ total: 0, approved: 0 })).toBe(NOT_EVIDENCED);
    expect(f({})).toBe("Minor");
    expect(f({ approved: 2, conditional: 1 })).toBe("Met");
    expect(f({ approved: 2, blocked: 1 })).toBe("Met");
    expect(f({ approved: 2, blocked: 1, truncated: true })).toBe("Minor");
  });
  it("8.5.2 traceability", () => {
    const f = (o: Partial<NonNullable<GapEvidence["traceability"]>>) => rule852({ flagged: 3, finished: 1, finishedMissing: 0, truncated: false, ...o }).status;
    expect(rule852(null).status).toBe(NOT_EVIDENCED);
    expect(f({ flagged: 0, finished: 0 })).toBe(NOT_EVIDENCED);
    expect(f({})).toBe("Met");
    expect(f({ finished: 0 })).toBe("Minor");
    expect(f({ truncated: true })).toBe("Minor");
    expect(f({ finishedMissing: 1 })).toBe("Major");
  });
  it("summarises job rows: only inspected jobs can be missing data", () => {
    const rows = [
      { id: "1", inspected_at: "2026-10-01T00:00:00Z", drawing_revision: "B", material_cert_no: "c", heat_cast_no: "h" },
      { id: "2", inspected_at: "2026-10-01T00:00:00Z", drawing_revision: " ", material_cert_no: "c", heat_cast_no: null },
      { id: "3", inspected_at: null, drawing_revision: null, material_cert_no: null, heat_cast_no: null },
    ];
    expect(summariseJobs(rows, (r) => !r.drawing_revision?.trim(), false)).toEqual({ flagged: 3, finished: 2, finishedMissing: 1, truncated: false });
    expect(summariseJobs(rows, (r) => !r.material_cert_no || !r.heat_cast_no, true)).toEqual({ flagged: 3, finished: 2, finishedMissing: 1, truncated: true });
  });
});
