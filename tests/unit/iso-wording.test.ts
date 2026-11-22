import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { DRAFT_HEADER, fillDocument, PAGE_FOOTER } from "@/lib/iso/fill";
import { buildGapChecklist, CSV_NOTE, EMPTY_EVIDENCE, GAP_CSV_COLUMNS, type GapEvidence } from "@/lib/iso/gap-checklist";
import { ISO_OFF_NOTICE } from "@/lib/iso/iso-switch";

const BANNED = ["certified", "compliant", "accredited", "approved by", "iso certified", "certification ready", "readiness"];
const every = (s: string) => BANNED.filter((w) => s.toLowerCase().includes(w));

const rich: GapEvidence = {
  inspectors: { current: 2, withReason: 2 }, changeHistoryPresent: true,
  drawingRevision: { flagged: 2, finished: 2, finishedMissing: 0, truncated: false },
  suppliers: { total: 3, approved: 2, conditional: 1, blocked: 0, truncated: false },
  traceability: { flagged: 2, finished: 1, finishedMissing: 1, truncated: false },
};

describe("ISO wording", () => {
  it("no template string uses a banned word", () => {
    const filled = ISO_DOCUMENTS.map((d) => JSON.stringify(fillDocument(d, { company: null, facts: null })));
    expect(every(JSON.stringify(ISO_DOCUMENTS))).toEqual([]);
    for (const f of filled) expect(every(f)).toEqual([]);
    expect(every([DRAFT_HEADER, PAGE_FOOTER, ISO_OFF_NOTICE].join(" "))).toEqual([]);
  });
  it("no checklist string uses a banned word", () => {
    expect(every(JSON.stringify(buildGapChecklist(EMPTY_EVIDENCE)))).toEqual([]);
    expect(every(JSON.stringify(buildGapChecklist(rich)))).toEqual([]);
  });
  it("every checklist CSV row carries the disclaimer and no banned word", () => {
    for (const evidence of [EMPTY_EVIDENCE, rich]) {
      for (const row of buildGapChecklist(evidence)) {
        const cells = GAP_CSV_COLUMNS.map((c) => String(c.value(row) ?? ""));
        expect(cells[GAP_CSV_COLUMNS.findIndex((c) => c.header === "Note")]).toBe("Needs company review. Not certification evidence.");
        expect(CSV_NOTE).toBe("Needs company review. Not certification evidence.");
        expect(every([...GAP_CSV_COLUMNS.map((c) => c.header), ...cells].join(" "))).toEqual([]);
      }
    }
  });
  it("the records index claims no change history beyond what the audit contract covers", () => {
    const text = JSON.stringify(ISO_DOCUMENTS.find((d) => d.id === "records-index"));
    expect(text).not.toContain("Records Tolra holds");
    expect(text).toContain("Record types Tolra can hold (confirm which your company uses)");
    expect(text).not.toContain("invoices and the change history of each");
  });
  it("the page and PDF files use none either", () => {
    for (const f of ["components/iso/iso-pack-view.tsx", "components/iso/iso-switch-card.tsx", "components/iso/iso-document-pdf.tsx", "components/iso/gap-checklist-pdf.tsx"]) {
      expect(every(readFileSync(f, "utf8")), f).toEqual([]);
    }
  });
});
