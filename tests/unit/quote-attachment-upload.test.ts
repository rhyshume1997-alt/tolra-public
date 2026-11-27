import { describe, expect, it, vi } from "vitest";
import { type QuoteAttachmentUploader, uploadQuoteAttachment } from "@/lib/quote-attachments";
import { ValidationError } from "@/lib/validation/schemas";

function makeFile(name = "spec.pdf", type = "application/pdf") {
  return new File(["hello"], name, { type });
}

describe("uploadQuoteAttachment (CR-015)", () => {
  it("uploads and registers the attachment cleanly on success", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client: QuoteAttachmentUploader = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert }),
    };

    const res = await uploadQuoteAttachment(client, {
      organizationId: "org-1",
      quoteRef: "QUO-001",
      file: makeFile(),
      uploadedBy: "user-1",
      kind: "customer_po",
    });

    expect(res.path).toBe("org-1/QUO-001/spec.pdf");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: "org-1",
      quote_ref: "QUO-001",
      file_path: "org-1/QUO-001/spec.pdf",
      kind: "customer_po",
    }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the uploaded storage object when quote_attachments insert fails", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const dbError = { code: "42501", message: "permission denied" };
    const insert = vi.fn().mockResolvedValue({ error: dbError });
    const client: QuoteAttachmentUploader = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert }),
    };

    await expect(
      uploadQuoteAttachment(client, {
        organizationId: "org-1",
        quoteRef: "QUO-001",
        file: makeFile("drawing.pdf"),
        uploadedBy: "user-1",
        kind: "file",
      }),
    ).rejects.toEqual(dbError);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["org-1/QUO-001/drawing.pdf"]);
  });

  it("surfaces a clear error if both DB registration and storage cleanup fail", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: { message: "delete refused" } });
    const insert = vi.fn().mockResolvedValue({ error: { code: "23514", message: "bad kind" } });
    const client: QuoteAttachmentUploader = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert }),
    };

    await expect(
      uploadQuoteAttachment(client, {
        organizationId: "org-1",
        quoteRef: "QUO-001",
        file: makeFile("po.pdf"),
        uploadedBy: "user-1",
        kind: "customer_po",
      }),
    ).rejects.toThrow(ValidationError);

    expect(remove).toHaveBeenCalledWith(["org-1/QUO-001/po.pdf"]);
    consoleErr.mockRestore();
  });

  it("retries with a timestamped path when a duplicate object exists, and removes the timestamped path if insert fails", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "The resource already exists" } })
      .mockResolvedValueOnce({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const insert = vi.fn().mockResolvedValue({ error: { code: "23503", message: "fk" } });
    const client: QuoteAttachmentUploader = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert }),
    };

    await expect(
      uploadQuoteAttachment(client, {
        organizationId: "org-1",
        quoteRef: "QUO-001",
        file: makeFile("dup.pdf"),
        uploadedBy: null,
        kind: "file",
        now: () => 1700000000000,
      }),
    ).rejects.toMatchObject({ code: "23503" });

    expect(remove).toHaveBeenCalledWith(["org-1/QUO-001/1700000000000-dup.pdf"]);
  });
});
