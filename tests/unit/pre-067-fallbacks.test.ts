/**
 * The app goes out before migration 067 is applied. These are the fallbacks that keep everything that existed before working and
 * hide (or explain) what 067 adds, until the database has it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ result: { error: null } as { error: { code?: string; message?: string } | null } | Error, calls: 0, tables: [] as string[] }));
const files = vi.hoisted(() => ({ notes: [{ id: "dn-1", dn_number: "DN-1" }], error: { code: "PGRST205", message: "Could not find the table 'public.document_attachments' in the schema cache" } as { code: string; message: string } | null }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "order", "limit"]) self[name] = () => self;
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      probe.tables.push(table);
      if (table === "document_attachments" && probe.calls >= 0 && files.error === null) {
        probe.calls += 1;
        return Promise.resolve(probe.result).then(resolve, reject);
      }
      if (table === "delivery_notes") return Promise.resolve({ data: files.notes, error: null }).then(resolve, reject);
      if (table === "document_attachments") return Promise.resolve({ data: null, error: files.error }).then(resolve, reject);
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    };
    return self;
  };
  return { supabase: { from: (table: string) => chain(table) } };
});

import { DRAFT_EDIT_NEEDS_UPDATE } from "@/components/draft-invoice-editor";
import { MISSING_DB_OBJECT_CODES, databaseHas067, featurePresent, missingDbObject, resetDatabaseFeatureCache } from "@/lib/db-features";
import { attachmentsUnavailable, listInvoiceDeliveryNoteAttachments } from "@/lib/document-attachments";
import { type QuoteAttachmentReader, listQuoteAttachments } from "@/lib/quote-attachments";

describe("what counts as 'the database doesn't have this yet'", () => {
  it("each missing function, table or column code", () => {
    for (const code of ["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"]) expect({ code, missing: missingDbObject({ code, message: "x" }) }).toEqual({ code, missing: true });
    expect(MISSING_DB_OBJECT_CODES.size).toBe(6);
  });

  it("the same said only in the message (a proxy that drops the code)", () => {
    expect(missingDbObject({ message: "Could not find the function public.replace_draft_invoice(p_header, p_invoice) in the schema cache" })).toBe(true);
    expect(missingDbObject({ message: 'column quote_attachments.kind does not exist' })).toBe(true);
  });

  it("real refusals and failures are not mistaken for it", () => {
    for (const error of [{ code: "42501", message: "new row violates row-level security policy for table \"document_attachments\"" }, { code: "PT409", message: "changed" }, { code: "22023", message: "bad" }, { message: "Failed to fetch" }])
      expect(missingDbObject(error)).toBe(false);
    expect(missingDbObject(null)).toBe(false);
  });

  it("the attachments panel says 'not available yet' only for a missing table or bucket, not for a refusal", () => {
    expect(attachmentsUnavailable({ code: "42703", message: "column does not exist" })).toBe(true);
    expect(attachmentsUnavailable({ message: "Bucket not found" })).toBe(true);
    expect(attachmentsUnavailable({ code: "42501", message: "new row violates row-level security policy for table \"document_attachments\"" })).toBe(false);
  });

  it("Edit Draft saved before 067 says plainly that nothing changed", () => {
    expect(DRAFT_EDIT_NEEDS_UPDATE).toMatch(/database update/);
    expect(DRAFT_EDIT_NEEDS_UPDATE).toMatch(/Nothing was changed/);
  });
});

describe("the 067 probe (Edit Draft and Attach to invoice show only once it is applied)", () => {
  beforeEach(() => {
    resetDatabaseFeatureCache();
    probe.calls = 0;
    files.error = null;
  });

  it("a probe answer: present, not yet, or unknown", () => {
    expect(featurePresent({ error: null })).toBe(true);
    expect(featurePresent({ error: { code: "PGRST205", message: "no table" } })).toBe(false);
    expect(featurePresent({ error: { code: "", message: "Failed to fetch" } })).toBeNull();
  });

  it("not applied: false, asked once", async () => {
    probe.result = { error: { code: "PGRST205", message: "Could not find the table 'public.document_attachments' in the schema cache" } };
    expect(await databaseHas067()).toBe(false);
    expect(await databaseHas067()).toBe(false);
    expect(probe.calls).toBe(1);
  });

  it("applied: true", async () => {
    probe.result = { error: null };
    expect(await databaseHas067()).toBe(true);
  });

  it("offline is no answer: the feature isn't hidden for it, and the next call asks again", async () => {
    probe.result = { error: { message: "Failed to fetch" } };
    expect(await databaseHas067()).toBe(true);
    probe.result = { error: { code: "PGRST205", message: "no table" } };
    expect(await databaseHas067()).toBe(false);
    expect(probe.calls).toBe(2);
  });
});

describe("existing screens before 067", () => {
  it("the invoice view lists no delivery-note files (and no error) when the files table doesn't exist", async () => {
    files.error = { code: "PGRST205", message: "Could not find the table 'public.document_attachments' in the schema cache" };
    expect(await listInvoiceDeliveryNoteAttachments("inv-1")).toEqual([]);
  });

  it("…but a real failure there is still reported", async () => {
    files.error = { code: "42501", message: "permission denied" };
    await expect(listInvoiceDeliveryNoteAttachments("inv-1")).rejects.toMatchObject({ code: "42501" });
  });

  function reader(responses: Array<{ data: unknown; error: { code?: string; message?: string } | null }>) {
    const asked: string[] = [];
    const client: QuoteAttachmentReader = {
      from: () => ({ select: (columns: string) => ({ eq: () => ({ order: () => { asked.push(columns); return Promise.resolve(responses.shift()!); } }) }) }),
    };
    return { client, asked };
  }
  const ROW = { id: "a1", file_path: "org/Q-1/a.pdf", file_name: "a.pdf", size_bytes: 10, created_at: "2026-10-18T10:00:00Z" };

  it("a quote's files are still listed when quote_attachments.kind doesn't exist yet, and 'Upload customer PO' stays hidden", async () => {
    for (const code of ["42703", "PGRST204"]) {
      const { client, asked } = reader([{ data: null, error: { code, message: "column quote_attachments.kind does not exist" } }, { data: [ROW], error: null }]);
      expect(await listQuoteAttachments(client, "Q-1")).toEqual({ files: [ROW], customerPoSupported: false });
      expect(asked).toEqual(["id, file_path, file_name, size_bytes, created_at, kind", "id, file_path, file_name, size_bytes, created_at"]);
    }
  });

  it("with 067: one read, kind included, customer PO upload offered", async () => {
    const { client, asked } = reader([{ data: [{ ...ROW, kind: "customer_po" }], error: null }]);
    expect(await listQuoteAttachments(client, "Q-1")).toEqual({ files: [{ ...ROW, kind: "customer_po" }], customerPoSupported: true });
    expect(asked).toHaveLength(1);
  });

  it("any other failure is reported, not retried as 'before 067'", async () => {
    const { client, asked } = reader([{ data: null, error: { code: "42501", message: "permission denied" } }]);
    await expect(listQuoteAttachments(client, "Q-1")).rejects.toMatchObject({ code: "42501" });
    expect(asked).toHaveLength(1);
  });
});
