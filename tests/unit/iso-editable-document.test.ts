// Pure rules for the editable ISO documents (lib/iso/editable-document.ts): body shape, limits, gaps, locked, which version prints, effective text.
import { describe, expect, it } from "vitest";

import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import {
  bodyFromFilled, countGaps, countGapsInText, editorStart, effectiveDocument, isLocked, isoErrorText, latestApproved, latestSaved, nextGapRange, parseBody, printChoiceLabel,
  sameBody, splitGaps, validateApproverName, validateBody, validateChangeNote, versionsOf, whichVersionPrints, type IsoVersion, type IsoVersionMeta,
} from "@/lib/iso/editable-document";
import { DRAFT_HEADER, fillDocument, PAGE_FOOTER } from "@/lib/iso/fill";

const company = { name: "Acme Ltd", documentName: "Acme Ltd", addressLines: ["1 High St"], phone: "", email: "", website: "" };
const generated = (id: string) => fillDocument(ISO_DOCUMENTS.find((d) => d.id === id)!, { company, facts: null });

const meta = (version: number, status: "draft" | "approved", doc = "quality-policy"): IsoVersionMeta => ({
  id: `id-${doc}-${version}`, doc_id: doc, version, status, change_note: null, restored_from: null, created_by: "u1", created_by_name: "Sam", created_at: "2026-11-26T10:00:00Z",
  approved_by_name: status === "approved" ? "Pat" : null, approved_at: status === "approved" ? "2026-11-26T12:00:00Z" : null,
});
const full = (m: IsoVersionMeta, text = "Our policy."): IsoVersion => ({ ...m, body: { sections: [{ heading: "Policy statement", text }] } });

describe("starting text", () => {
  it("is today's filled draft with the company name and visible gaps", () => {
    const body = bodyFromFilled(generated("quality-policy"));
    expect(body.sections[0].text).toContain("Acme Ltd");
    expect(countGaps(body)).toBeGreaterThan(0);
    expect(editorStart([], body)).toMatchObject({ from: "generated", baseVersion: 0 });
  });
  it("starts from the latest saved version, even when it is approved", () => {
    const body = { sections: [{ heading: "h", text: "t" }] };
    const start = editorStart([full(meta(2, "approved")), full(meta(1, "draft"))], body);
    expect(start).toMatchObject({ from: "saved", baseVersion: 2 });
    expect(isLocked(start.fromVersion!)).toBe(true);
  });
});

describe("limits mirror the database function", () => {
  const ok = { sections: [{ heading: "h", text: "t" }] };
  it("accepts a normal body", () => expect(validateBody(ok)).toBeNull());
  it("refuses no sections, too many, a long heading, a long text", () => {
    expect(validateBody({ sections: [] })).not.toBeNull();
    expect(validateBody({ sections: Array.from({ length: 31 }, () => ({ heading: "h", text: "" })) })).not.toBeNull();
    expect(validateBody({ sections: [{ heading: "", text: "" }] })).not.toBeNull();
    expect(validateBody({ sections: [{ heading: "h".repeat(201), text: "" }] })).not.toBeNull();
    expect(validateBody({ sections: [{ heading: "h", text: "x".repeat(20001) }] })).not.toBeNull();
    expect(validateBody({ sections: [{ heading: "h", text: "x".repeat(20000) }] })).toBeNull();
  });
  it("note and approver name", () => {
    expect(validateChangeNote("n".repeat(501))).not.toBeNull();
    expect(validateChangeNote("n".repeat(500))).toBeNull();
    expect(validateApproverName("   ")).not.toBeNull();
    expect(validateApproverName("Pat Lee")).toBeNull();
    expect(validateApproverName("p".repeat(201))).not.toBeNull();
  });
  it("parseBody reads only the expected shape", () => {
    expect(parseBody(ok)).toEqual(ok);
    expect(parseBody(null)).toBeNull();
    expect(parseBody({ sections: [{ heading: 1, text: "x" }] })).toBeNull();
    expect(parseBody({ sections: [] })).toBeNull();
  });
  it("sameBody tells an edit from none", () => {
    expect(sameBody(ok, { sections: [{ heading: "h", text: "t" }] })).toBe(true);
    expect(sameBody(ok, { sections: [{ heading: "h", text: "t2" }] })).toBe(false);
  });
});

describe("gaps", () => {
  it("counts, splits and finds the next gap (wrapping)", () => {
    expect(countGapsInText("a [to complete] b [to complete]")).toBe(2);
    expect(splitGaps("x [to complete] y")).toEqual([{ text: "x ", gap: false }, { text: "[to complete]", gap: true }, { text: " y", gap: false }]);
    expect(splitGaps("none")).toEqual([{ text: "none", gap: false }]);
    expect(nextGapRange("aa [to complete] bb [to complete]", 0)).toEqual({ start: 3, end: 16 });
    expect(nextGapRange("aa [to complete] bb [to complete]", 16)).toEqual({ start: 20, end: 33 });
    expect(nextGapRange("aa [to complete]", 16)).toEqual({ start: 3, end: 16 });
    expect(nextGapRange("filled in", 0)).toBeNull();
  });
});

describe("which version prints", () => {
  it("none saved: today's generated draft", () => expect(whichVersionPrints([]).kind).toBe("generated"));
  it("drafts only: the latest saved draft", () => {
    const c = whichVersionPrints([meta(1, "draft"), meta(3, "draft"), meta(2, "draft")]);
    expect(c.kind).toBe("draft");
    expect(c.version?.version).toBe(3);
  });
  it("an approved version beats a newer draft; the latest approved wins", () => {
    const c = whichVersionPrints([meta(4, "draft"), meta(2, "approved"), meta(3, "approved"), meta(1, "approved")]);
    expect(c.kind).toBe("approved");
    expect(c.version?.version).toBe(3);
    expect(latestApproved([meta(1, "draft")])).toBeNull();
    expect(latestSaved([meta(1, "draft"), meta(5, "approved")])?.version).toBe(5);
  });
  it("labels", () => {
    expect(printChoiceLabel(whichVersionPrints([]))).toBe("Generated draft, not saved");
    expect(printChoiceLabel(whichVersionPrints([meta(2, "approved")]))).toBe("Approved, version 2");
  });
  it("versionsOf is per document and newest first", () => {
    const all = [meta(1, "draft"), meta(2, "draft"), meta(1, "draft", "production")];
    expect(versionsOf(all, "quality-policy").map((v) => v.version)).toEqual([2, 1]);
  });
});

describe("effective document for the PDF", () => {
  it("no saved version: today's generated draft, unchanged", () => {
    const g = generated("quality-policy");
    expect(effectiveDocument(g, null)).toBe(g);
  });
  it("a saved draft keeps the DRAFT header and the existing footer", () => {
    const g = generated("quality-policy");
    const d = effectiveDocument(g, { kind: "draft", version: full(meta(1, "draft"), "Line one\nLine two") });
    expect(d.header).toBe(DRAFT_HEADER);
    expect(d.footer).toBe(PAGE_FOOTER);
    expect(d.sections[0].lines).toEqual(["Line one", "Line two"]);
    expect(d.companyName).toBe("Acme Ltd");
  });
  it("an approved version says who and when, and still carries the footer", () => {
    const g = generated("quality-policy");
    const d = effectiveDocument(g, { kind: "approved", version: full(meta(2, "approved")) });
    expect(d.header).toBe("APPROVED version 2: approved by Pat on 2026-11-26");
    expect(d.footer).toBe(PAGE_FOOTER);
  });
  it("keeps the blank table of a section by heading", () => {
    const g = generated("internal-audit-checklist");
    const tableHeading = g.sections.find((s) => s.blankTable)!.heading;
    const v = { ...full(meta(1, "draft", "internal-audit-checklist")), body: { sections: [{ heading: tableHeading, text: "x" }] } };
    expect(effectiveDocument(g, { kind: "draft", version: v }).sections[0].blankTable).toBeDefined();
  });
});

describe("refusal wording", () => {
  it("maps codes and hints to plain words, never the raw message", () => {
    expect(isoErrorText({ code: "40001", hint: "stale_version" }, "save")).toMatch(/newer version/);
    expect(isoErrorText({ code: "55000", hint: "already_approved" }, "approve")).toMatch(/already approved/);
    expect(isoErrorText({ code: "42501" }, "save")).toMatch(/admin/);
    expect(isoErrorText({ code: "XX000" }, "approve")).toBe("Couldn't approve. Nothing was changed. Try again.");
  });
});
