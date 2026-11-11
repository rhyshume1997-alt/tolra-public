import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { DRAFT_HEADER, fillDocument, PAGE_FOOTER } from "@/lib/iso/fill";
import { buildGapChecklist, EMPTY_EVIDENCE, type GapEvidence } from "@/lib/iso/gap-checklist";
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
  it("the page and PDF files use none either", () => {
    for (const f of ["components/iso/iso-pack-view.tsx", "components/iso/iso-document-pdf.tsx", "components/iso/gap-checklist-pdf.tsx"]) {
      expect(every(readFileSync(f, "utf8")), f).toEqual([]);
    }
  });
});
