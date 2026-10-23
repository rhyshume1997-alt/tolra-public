import { describe, expect, it } from "vitest";

import { attachmentPath, attachmentProblem, attachmentsUnavailable, formatBytes, safeFileName } from "@/lib/document-attachments";

const ORG = "11111111-1111-1111-1111-111111111111";
const DN = "22222222-2222-2222-2222-222222222222";

describe("document attachments (067)", () => {
  it("stores each file in its parent's folder, as the database CHECK requires, under a unique name", () => {
    expect(attachmentPath(ORG, { kind: "delivery_note", id: DN }, "Load photo.jpg", 1700000000000)).toBe(`${ORG}/delivery-notes/${DN}/1700000000000-Load photo.jpg`);
    expect(attachmentPath(ORG, { kind: "purchase_order", id: DN }, "ack.pdf", 1)).toBe(`${ORG}/purchase-orders/${DN}/1-ack.pdf`);
  });

  it("a file name can't name another folder or carry odd characters", () => {
    expect(safeFileName("../../other/evil.pdf")).toBe("evil.pdf");
    expect(safeFileName("C:\\photos\\IMG 1.jpg")).toBe("IMG 1.jpg");
    expect(safeFileName("a/b?c*.pdf")).toBe("b_c_.pdf");
    expect(safeFileName("...")).toBe("file");
    expect(safeFileName("x".repeat(300))).toHaveLength(200);
  });

  it("only the bucket's types, not empty, 20 MB at most", () => {
    expect(attachmentProblem({ name: "a.pdf", type: "application/pdf", size: 10 })).toBeNull();
    expect(attachmentProblem({ name: "a.jpg", type: "image/jpeg", size: 20 * 1024 * 1024 })).toBeNull();
    expect(attachmentProblem({ name: "a.heic", type: "image/heic", size: 10 })).toMatch(/only PDF/);
    expect(attachmentProblem({ name: "a.pdf", type: "application/pdf", size: 0 })).toMatch(/empty/);
    expect(attachmentProblem({ name: "a.pdf", type: "application/pdf", size: 20 * 1024 * 1024 + 1 })).toMatch(/20 MB/);
  });

  it("recognises a database without 067", () => {
    expect(attachmentsUnavailable({ code: "42P01", message: "relation does not exist" })).toBe(true);
    expect(attachmentsUnavailable({ code: "PGRST205", message: "Could not find the table 'public.document_attachments'" })).toBe(true);
    expect(attachmentsUnavailable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(attachmentsUnavailable(null)).toBe(false);
  });

  it("sizes", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(500)).toBe("1 KB");
    expect(formatBytes(3 * 1048576)).toBe("3.0 MB");
  });
});
