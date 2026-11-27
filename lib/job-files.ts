/**
 * Inputs: job ID/number, certificate file, reference label, and Supabase client/storage context.
 * Outputs: registered cert pack rows and compensating storage cleanup when job_files registration fails.
 * Boundary: Module 2 (Workshop & Jobs) only; does not modify storage bucket policies or other modules.
 */
import { DRAWINGS_BUCKET, validateDrawing } from "@/lib/job-worksheet";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

/** A material certificate in a job's cert pack (migration 034, job_files with kind 'cert'). */
export type CertFile = { id: string; ref: string; file_name: string; storage_path: string; created_at: string };

/** Raised when registering an uploaded certificate in job_files failed and compensating storage removal could not confirm deletion. */
export class CertCleanupError extends Error {
  readonly cleanupFailed = true as const;
  readonly storagePath: string;
  constructor(storagePath: string) {
    super("The certificate could not be registered, and the uploaded file could not be removed from storage automatically. Ask an admin to check job-drawings storage.");
    this.name = "CertCleanupError";
    this.storagePath = storagePath;
  }
}

export type CertUploadClient = {
  storage: {
    from(bucket: string): {
      upload(path: string, file: File, options?: { contentType?: string }): Promise<{ error: { message?: string } | null }>;
      remove(paths: string[]): Promise<{ data: unknown[] | null; error: { message?: string } | null }>;
    };
  };
  from(table: "job_files"): {
    insert(row: Record<string, unknown>): {
      select(columns: string): {
        single(): PromiseLike<{ data: unknown; error: { code?: string; message?: string; hint?: string } | null }>;
      };
    };
  };
};

/** The job with this number and its certificates; jobId is null when no such job is visible. */
export async function loadCertPack(jobNo: string): Promise<{ jobId: string | null; certs: CertFile[] }> {
  if (!supabase || !jobNo.trim()) return { jobId: null, certs: [] };
  const { data: job, error } = await supabase.from("jobs").select("id").eq("job_no", jobNo.trim()).maybeSingle();
  if (error) throw error;
  if (!job) return { jobId: null, certs: [] };
  const { data, error: certError } = await supabase.from("job_files").select("id, ref, file_name, storage_path, created_at").eq("job_id", job.id).eq("kind", "cert").order("created_at").order("id");
  if (certError) throw certError;
  return { jobId: job.id as string, certs: (data ?? []) as CertFile[] };
}

/**
 * Uploads a certificate to the job's certs folder and registers its job_files row.
 * If database registration fails or returns no row, attempts compensating storage removal and verifies
 * at least one object was removed (catching silent 0-row RLS DELETE refusals such as Release 159).
 */
export async function attachCertWithClient(
  client: CertUploadClient,
  orgId: string,
  jobId: string,
  file: File,
  ref: string,
  now: () => number = Date.now,
): Promise<CertFile> {
  const problem = validateDrawing(file);
  if (problem) throw new Error(problem);
  const name = file.name.replace(/[^\w.\- ()]/g, "_");
  const path = `${orgId}/${jobId}/certs/${now()}-${name}`;
  const bucket = client.storage.from(DRAWINGS_BUCKET);
  const { error } = await bucket.upload(path, file, { contentType: file.type });
  if (error) throw error;
  const label = ref.trim() || name.replace(/\.[^.]*$/, "") || name;
  const { data, error: rowError } = await client.from("job_files").insert({
    organization_id: orgId, job_id: jobId, kind: "cert", ref: label.slice(0, 200), file_name: name, storage_bucket: DRAWINGS_BUCKET, storage_path: path,
  }).select("id, ref, file_name, storage_path, created_at").single();
  if (rowError || !data) {
    let cleanupConfirmed = false;
    try {
      const removed = await bucket.remove([path]);
      cleanupConfirmed = !removed.error && Array.isArray(removed.data) && removed.data.length > 0;
    } catch {
      cleanupConfirmed = false;
    }
    if (!cleanupConfirmed) {
      if (typeof console !== "undefined") {
        console.error("[job-files] failed to remove unregistered cert upload after job_files insert error", path);
      }
      throw new CertCleanupError(path);
    }
    throw rowError ?? new Error("Certificate registration returned no record.");
  }
  return data as CertFile;
}

/** Uploads a certificate to the job's certs folder in the job-drawings bucket and adds it to the cert pack. */
export async function attachCert(jobId: string, file: File, ref: string): Promise<CertFile> {
  const problem = validateDrawing(file);
  if (problem) throw new Error(problem);
  const orgId = await getCurrentOrganizationId();
  if (!supabase || !orgId) throw new Error("Storage is not available.");
  return attachCertWithClient(supabase as unknown as CertUploadClient, orgId, jobId, file, ref);
}

/** Takes a certificate out of the pack (the file stays in storage). Admin and office. */
export async function removeCert(id: string): Promise<void> {
  if (!supabase) throw new Error("Storage is not available.");
  const { data, error } = await supabase.from("job_files").delete().eq("id", id).select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("That certificate couldn't be removed: only admin and office staff can do that.");
}

/** The customer's purchase order on a job (migration 067, job_files kind 'customer_po'): a reference to the quote's file. */
export type CustomerPoFile = { id: string; file_name: string; storage_bucket: string; storage_path: string; created_at: string };

/** The job's customer-PO files, oldest first. Empty before 067 (the kind doesn't exist yet, so nothing matches). */
export async function listCustomerPos(jobId: string): Promise<CustomerPoFile[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("job_files").select("id, file_name, storage_bucket, storage_path, created_at").eq("job_id", jobId).eq("kind", "customer_po").order("created_at").order("id");
  if (error) throw error;
  return (data ?? []) as CustomerPoFile[];
}
