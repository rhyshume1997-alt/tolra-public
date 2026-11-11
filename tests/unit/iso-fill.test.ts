import { describe, expect, it } from "vitest";

import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { DRAFT_HEADER, fillDocument, fillText, PAGE_FOOTER, TO_COMPLETE, tokenValues, type FillContext } from "@/lib/iso/fill";

const company = { name: "Acme", documentName: "Acme Engineering Ltd", addressLines: ["1 High St", "Leeds"], phone: "", email: "", website: "" };
const facts = { inspectors: 2, suppliers: { total: 5, approved: 3, conditional: 1, blocked: 1 }, traceableJobs: 4, openNcrs: 0 };

describe("ISO document list", () => {
  it("has the nine documents, in order", () => {
    expect(ISO_DOCUMENTS.map((d) => d.title)).toEqual([
      "Quality policy", "QMS scope and context", "7.5 Documented information", "8.4 External providers", "8.5 Production",
      "8.7 Nonconforming outputs", "10.2 Corrective action", "Records index", "Internal audit checklist",
    ]);
    expect(new Set(ISO_DOCUMENTS.map((d) => d.filename)).size).toBe(9);
  });
  it("the audit checklist has blank rows only", () => {
    const filled = fillDocument(ISO_DOCUMENTS[8], { company, facts });
    const table = filled.sections.find((s) => s.blankTable)!.blankTable!;
    expect(table.rows.length).toBeGreaterThan(5);
    expect(table.rows.flat().every((c) => c === "")).toBe(true);
  });
});

describe("fill", () => {
  it("brands from the company profile and states Tolra's counts", () => {
    const all = ISO_DOCUMENTS.map((d) => fillDocument(d, { company, facts }));
    expect(all[0].companyName).toBe("Acme Engineering Ltd");
    expect(all[0].addressLines).toEqual(["1 High St", "Leeds"]);
    const flat = (id: string) => all.find((d) => d.id === id)!.sections.flatMap((s) => s.lines).join("\n");
    expect(flat("quality-policy")).toContain("1 High St, Leeds");
    expect(flat("external-providers")).toContain("Conditional: 1");
    expect(flat("production")).toContain("traceable in Tolra: 4");
    expect(flat("nonconforming-outputs")).toContain("0");
    expect(flat("records-index")).toContain("inspectors list: 2");
  });
  it("every document carries the draft header and the footer", () => {
    for (const d of ISO_DOCUMENTS) {
      const f = fillDocument(d, { company, facts });
      expect(f.header).toBe(DRAFT_HEADER);
      expect(f.footer).toBe(PAGE_FOOTER);
    }
    expect(DRAFT_HEADER).toBe("DRAFT: template for company review");
    expect(PAGE_FOOTER).toBe("Template and self-check aid. Needs company review. Not certification evidence.");
  });
  it("missing values print [to complete], never a guess and never a raw token", () => {
    const ctx: FillContext = { company: null, facts: null };
    for (const d of ISO_DOCUMENTS) {
      const text = JSON.stringify(fillDocument(d, ctx));
      expect(text).not.toContain("{{");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("null");
    }
    const v = tokenValues(ctx);
    for (const k of ["company", "address", "inspectors", "suppliersTotal", "traceableJobs", "openNcrs"]) expect(v[k]).toBe(TO_COMPLETE);
    expect(tokenValues({ company, facts }).phone).toBe(TO_COMPLETE);
    expect(fillText("a {{nope}} b", {})).toBe("a [to complete] b");
  });
  it("a partly read set of facts completes only what was read", () => {
    const v = tokenValues({ company, facts: { ...facts, suppliers: null } });
    expect(v.suppliersTotal).toBe(TO_COMPLETE);
    expect(v.inspectors).toBe("2");
  });
});
