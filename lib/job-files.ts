import { DRAWINGS_BUCKET, validateDrawing } from "@/lib/job-worksheet";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

/** A material certificate in a job's cert pack (migration 034, job_files with kind 'cert'). */
export type CertFile = { id: string; ref: string; file_name: string; storage_path: string; created_at: string };

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

/** Uploads a certificate to the job's certs folder in the job-drawings bucket and adds it to the cert pack. */
export async function attachCert(jobId: string, file: File, ref: string): Promise<CertFile> {
  const problem = validateDrawing(file);
  if (problem) throw new Error(problem);
  const orgId = await getCurrentOrganizationId();
  if (!supabase || !orgId) throw new Error("Storage is not available.");
  const name = file.name.replace(/[^\w.\- ()]/g, "_");
  const path = `${orgId}/${jobId}/certs/${Date.now()}-${name}`;
  const { error } = await supabase.storage.from(DRAWINGS_BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  const label = ref.trim() || name.replace(/\.[^.]*$/, "") || name;
  const { data, error: rowError } = await supabase.from("job_files").insert({
    organization_id: orgId, job_id: jobId, kind: "cert", ref: label.slice(0, 200), file_name: name, storage_bucket: DRAWINGS_BUCKET, storage_path: path,
  }).select("id, ref, file_name, storage_path, created_at").single();
  if (rowError) throw rowError;
  return data as CertFile;
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
