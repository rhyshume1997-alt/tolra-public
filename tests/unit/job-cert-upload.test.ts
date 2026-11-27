import { describe, expect, it, vi } from "vitest";
import { CertCleanupError, type CertUploadClient, attachCertWithClient } from "@/lib/job-files";

function makePdf(name = "cert-3.1.pdf") {
  return new File(["%PDF-1.4"], name, { type: "application/pdf" });
}

describe("attachCertWithClient (CR-021)", () => {
  it("uploads and registers the certificate row on success", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const single = vi.fn().mockResolvedValue({
      data: {
        id: "cf-1",
        ref: "HEAT-99",
        file_name: "cert-3.1.pdf",
        storage_path: "org-1/job-1/certs/1700000000000-cert-3.1.pdf",
        created_at: "2026-11-27T00:00:00Z",
      },
      error: null,
    });
    const client: CertUploadClient = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert: () => ({ select: () => ({ single }) }) }),
    };

    const cert = await attachCertWithClient(client, "org-1", "job-1", makePdf(), "HEAT-99", () => 1700000000000);
    expect(cert.id).toBe("cf-1");
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the uploaded storage object when job_files insert fails and delete is confirmed", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const path = "org-1/job-1/certs/1700000000000-cert-3.1.pdf";
    const remove = vi.fn().mockResolvedValue({ data: [{ name: path }], error: null });
    const dbError = { code: "42501", message: "permission denied" };
    const single = vi.fn().mockResolvedValue({ data: null, error: dbError });
    const client: CertUploadClient = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert: () => ({ select: () => ({ single }) }) }),
    };

    await expect(
      attachCertWithClient(client, "org-1", "job-1", makePdf(), "HEAT-99", () => 1700000000000),
    ).rejects.toEqual(dbError);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([path]);
  });

  it("throws CertCleanupError when storage remove silently deletes 0 rows (e.g. Release 159 USING (false) DELETE policy)", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const upload = vi.fn().mockResolvedValue({ error: null });
    const path = "org-1/job-1/certs/1700000000000-cert-3.1.pdf";
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const single = vi.fn().mockResolvedValue({ data: null, error: { code: "23514", message: "constraint" } });
    const client: CertUploadClient = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert: () => ({ select: () => ({ single }) }) }),
    };

    await expect(
      attachCertWithClient(client, "org-1", "job-1", makePdf(), "HEAT-99", () => 1700000000000),
    ).rejects.toThrow(CertCleanupError);

    expect(remove).toHaveBeenCalledWith([path]);
    consoleErr.mockRestore();
  });

  it("throws CertCleanupError when storage remove errors", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ data: null, error: { message: "denied" } });
    const single = vi.fn().mockResolvedValue({ data: null, error: { code: "500", message: "db error" } });
    const client: CertUploadClient = {
      storage: { from: () => ({ upload, remove }) },
      from: () => ({ insert: () => ({ select: () => ({ single }) }) }),
    };

    await expect(
      attachCertWithClient(client, "org-1", "job-1", makePdf(), "HEAT-99", () => 1700000000000),
    ).rejects.toThrow(CertCleanupError);

    consoleErr.mockRestore();
  });
});
