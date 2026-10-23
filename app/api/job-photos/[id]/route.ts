import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { isErrorResponse, jsonError, requireProfile } from "@/lib/server/auth";
import { storageTransient } from "@/lib/server/storage-transient";

/**
 * A job photo's bytes (migration 040). The private job-photos bucket can't be read through Storage by the
 * browser roles (no signed links, no listing, no copy), so the picture comes through here:
 *   1. the person's own session reads the job_files row (row-level security: same company, admin/office/workshop only,
 *      uploaded, not removed); a viewer, another company or a removed photo gets 404 and nothing else;
 *   2. the service role fetches exactly the object that row names (its path is re-derived from the row, never taken from
 *      the request), and the bytes are served only if they are the reserved JPEG: the right size and a JPEG signature.
 * Nothing is cached in a shared cache, and the response is never sniffed as anything but an image.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = "job-photos";
const MAX_BYTES = 2 * 1024 * 1024;

type Row = { id: string; organization_id: string; job_id: string; storage_path: string; upload_state: string | null; deleted_at: string | null; byte_size: number | null };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return jsonError("Not found", 404);
  const auth = await requireProfile(["admin", "office", "workshop"]);
  if (isErrorResponse(auth)) return auth;

  const { data: row, error } = await auth.supabase
    .from("job_files")
    .select("id, organization_id, job_id, storage_path, upload_state, deleted_at, byte_size")
    .eq("id", id)
    .eq("kind", "photo")
    .maybeSingle<Row>();
  if (error) return jsonError("Service unavailable", 503, { headers: { "Retry-After": "2", "Cache-Control": "no-store" } });
  if (!row || row.upload_state !== "uploaded" || row.deleted_at !== null || row.organization_id !== auth.profile.organization_id) return jsonError("Not found", 404);
  const expectedPath = `${row.organization_id}/${row.job_id}/photos/${row.id}.jpg`;
  if (row.storage_path !== expectedPath || typeof row.byte_size !== "number" || row.byte_size < 1 || row.byte_size > MAX_BYTES) return jsonError("Not found", 404);

  const admin = createSupabaseAdminClient();
  if (!admin) return jsonError("Service unavailable", 503);
  const { data: file, error: downloadError } = await admin.storage.from(BUCKET).download(expectedPath);
  // The row says the photo is there: a Storage error that isn't "no such object" is a passing fault, answered 503 (the page tries
  // again) rather than 404, which reads as "this photo doesn't exist".
  if (downloadError) return storageTransient(downloadError) ? jsonError("Service unavailable", 503, { headers: { "Retry-After": "2", "Cache-Control": "no-store" } }) : jsonError("Not found", 404);
  if (!file) return jsonError("Not found", 404);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length !== row.byte_size || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return jsonError("Not found", 404);

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `inline; filename="photo-${row.id}.jpg"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
