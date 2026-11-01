import { fmtDateTime } from "@/lib/dates";
import { DEMO_MODE } from "@/lib/demo";
import { quoteNumberForJob } from "@/lib/numbering";
import { loadOfflineSnapshot, queueOffline, reportOffline, saveOfflineSnapshot } from "@/lib/offline/scope";
import { isNetworkError, stripJobMoney } from "@/lib/offline/store";
import { supabase } from "@/lib/supabase";

export const DRAWINGS_BUCKET = "job-drawings";

export const DEMO_MACHINES = ["Haas VF-2", "Mazak Quick Turn", "DMG Mori NLX 2500", "Doosan DNM 4500", "Bridgeport Series 1", "Colchester Mascot 1600"];

export const CHECKLIST_ITEMS = [
  { key: "sizes_checked", label: "Sizes Checked" },
  { key: "threads_check", label: "Threads Check" },
  { key: "parts_deburred", label: "Parts Deburred" },
  { key: "parts_marked", label: "Parts Marked" },
  { key: "parts_clean", label: "Parts Clean" },
  { key: "parts_counted", label: "Parts Counted" },
] as const;

export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]["key"];
export type Checklist = Partial<Record<ChecklistKey, boolean>>;

export type JobWorksheet = {
  job_no: string;
  customer: string;
  description: string;
  customer_po: string;
  date_received: string;
  date_required: string;
  quote_ref: string;
  dimension_report_no: string;
  material_cert_no: string;
  heat_cast_no: string;
  job_time_quoted_hr: string;
  job_time_taken_hr: string;
  drawing_no: string;
  quantity_required: string;
  material_required: string;
  material_ordered: boolean;
  material_ordered_at: string;
  material_ordered_notes: string;
  material_supplier: string;
  machine_1: string;
  program_1: string;
  machine_2: string;
  program_2: string;
  machine_3: string;
  program_3: string;
  setup_time_hr: string;
  run_time_hr: string;
  improvement_comments: string;
  overrun_reasons: string;
  checklist: Checklist;
  checked_by: string;
  signed_off_by: string;
  signed_off_at: string;
};

export type WorksheetJobInfo = {
  id: string;
  job_no: string;
  customer: string;
  description: string;
  due_date?: string;
  drawings?: string[];
  /** Optional prefill used by demo data and as a fallback when the job row has no value yet. */
  customer_po?: string;
  date_received?: string;
  date_required?: string;
  quote_ref?: string;
  quantity_required?: number | string;
  drawing_no?: string;
};

/**
 * A drawing on the job. `id` is its job_files row (migration 034; none for a file uploaded before that), `bucket` where the file
 * lives (a drawing carried from the quote is a reference to the quote's file), `revision` its latest revision label and
 * `earlier` the labels of the revisions it replaced.
 */
export type DrawingFile = { name: string; path?: string; id?: string; bucket?: string; revision?: string | null; earlier?: string[] };

const TEXT_FIELDS = [
  "customer_po", "date_received", "date_required", "quote_ref", "dimension_report_no", "material_cert_no", "heat_cast_no", "drawing_no",
  "material_required", "material_ordered_at", "material_ordered_notes", "material_supplier", "machine_1", "program_1", "machine_2", "program_2",
  "machine_3", "program_3", "improvement_comments", "overrun_reasons", "checked_by", "signed_off_by", "signed_off_at",
] as const;
const NUMBER_FIELDS = ["job_time_quoted_hr", "job_time_taken_hr", "quantity_required", "setup_time_hr", "run_time_hr"] as const;

/**
 * What a printed sign-off box may say (audit R5). Only a sign-off with its time is a sign-off: a name left in the box
 * after the sign-off was cleared (the checklist changed) prints as "not signed off", never as signed.
 */
export function signOffState(ws: Pick<JobWorksheet, "signed_off_by" | "signed_off_at">): { status: "signed"; name: string; at: string } | { status: "unsigned"; name: string } | { status: "blank" } {
  const name = ws.signed_off_by.trim();
  if (ws.signed_off_at) return { status: "signed", name, at: fmtDateTime(ws.signed_off_at) };
  return name ? { status: "unsigned", name } : { status: "blank" };
}

export function emptyWorksheet(info?: Partial<WorksheetJobInfo>): JobWorksheet {
  return {
    job_no: info?.job_no || "", customer: info?.customer || "", description: info?.description || "",
    customer_po: info?.customer_po || "", date_received: info?.date_received || "", date_required: info?.date_required || "",
    // Jobs carry their quote's number (J-0123 <-> QUO-0123), so the quote number can be worked out when it was not stored.
    quote_ref: info?.quote_ref || quoteNumberForJob(info?.job_no) || "", dimension_report_no: "", material_cert_no: "", heat_cast_no: "",
    job_time_quoted_hr: "", job_time_taken_hr: "", drawing_no: info?.drawing_no || "",
    quantity_required: info?.quantity_required == null ? "" : String(info.quantity_required), material_required: "", material_ordered: false,
    material_ordered_at: "", material_ordered_notes: "", material_supplier: "", machine_1: "", program_1: "", machine_2: "", program_2: "",
    machine_3: "", program_3: "", setup_time_hr: "", run_time_hr: "", improvement_comments: "", overrun_reasons: "", checklist: {},
    checked_by: "", signed_off_by: "", signed_off_at: "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function worksheetFromRow(row: Record<string, any>, info?: Partial<WorksheetJobInfo>): JobWorksheet {
  const ws = emptyWorksheet({
    job_no: row.job_no || row.reference || info?.job_no,
    customer: row.customer || row.customer_name || info?.customer || (row.is_internal ? "Internal" : undefined),
    description: row.description ?? info?.description,
  });
  const prefill = emptyWorksheet(info);
  for (const key of TEXT_FIELDS) ws[key] = row[key] == null ? prefill[key] : String(row[key]);
  for (const key of NUMBER_FIELDS) ws[key] = row[key] == null ? prefill[key] : String(row[key]);
  // An internal job (migration 042) never came from a quote: no quote number is guessed from its J number.
  if (!ws.quote_ref && !row.is_internal) ws.quote_ref = quoteNumberForJob(ws.job_no) || "";
  ws.date_required = ws.date_required || (/^\d{4}-\d{2}-\d{2}/.test(String(row.due_date || "")) ? String(row.due_date).slice(0, 10) : "");
  ws.material_ordered = Boolean(row.material_ordered);
  ws.checklist = row.checklist && typeof row.checklist === "object" ? row.checklist : {};
  return ws;
}

/** Columns written back to the jobs table (job_no and customer are not edited here). */
export function worksheetToPatch(ws: JobWorksheet) {
  const patch: Record<string, unknown> = { description: ws.description, material_ordered: ws.material_ordered, checklist: ws.checklist };
  for (const key of TEXT_FIELDS) patch[key] = ws[key].trim() === "" ? null : ws[key];
  for (const key of NUMBER_FIELDS) patch[key] = ws[key].trim() === "" || Number.isNaN(Number(ws[key])) ? null : Number(ws[key]);
  return patch;
}

export function isOverrun(ws: Pick<JobWorksheet, "job_time_quoted_hr" | "job_time_taken_hr">) {
  const quoted = parseFloat(ws.job_time_quoted_hr);
  const taken = parseFloat(ws.job_time_taken_hr);
  return Number.isFinite(quoted) && Number.isFinite(taken) && taken > quoted;
}

export type LoadWorksheetResult =
  | { worksheet: JobWorksheet; demo: boolean; version: number | null; row?: Record<string, unknown>; error?: undefined; offline?: boolean; syncedAt?: string }
  | { error: string; worksheet?: undefined; demo?: undefined };

/**
 * Never returns a blank worksheet for a real job: saving a blank sheet would
 * wipe the stored data. A load failure comes back as { error } instead.
 */
export async function loadWorksheet(info: WorksheetJobInfo): Promise<LoadWorksheetResult> {
  if (!supabase) return { worksheet: emptyWorksheet(info), demo: true, version: null };
  const { data, error } = await supabase.from("jobs").select("*").eq("id", info.id).single();
  if (error || !data) {
    console.error(error);
    // Can't reach the server: use this device's copy from the last successful load (lib/offline), if any.
    if (isNetworkError(error)) {
      const copy = await loadOfflineSnapshot<Record<string, unknown>>(`job:${info.id}`);
      if (copy) {
        reportOffline(true, copy.syncedAt);
        return { worksheet: worksheetFromRow(copy.data, info), demo: false, version: Number(copy.data.worksheet_version ?? 0), row: copy.data, offline: true, syncedAt: copy.syncedAt };
      }
    }
    return { error: "Couldn't load this worksheet. Retry." };
  }
  void saveOfflineSnapshot(`job:${info.id}`, stripJobMoney(data));
  return { worksheet: worksheetFromRow(data, info), demo: false, version: Number(data.worksheet_version ?? 0), row: data };
}

/**
 * Offline save: the worksheet goes into the outbox with the version it was based on, and this device's copy shows
 * it straight away. It is sent when the connection is back; if someone else saved in between, both are kept.
 */
async function queueWorksheetOffline(id: string, ws: JobWorksheet, version: number) {
  const queued = await queueOffline({ kind: "worksheet", jobId: id, jobNo: ws.job_no, worksheet: ws as unknown as Record<string, unknown>, baseVersion: version });
  if (!queued) return false;
  const copy = await loadOfflineSnapshot<Record<string, unknown>>(`job:${id}`);
  if (copy) void saveOfflineSnapshot(`job:${id}`, { ...copy.data, ...worksheetToPatch(ws) });
  reportOffline(true, copy?.syncedAt);
  return true;
}

/** Someone else saved this worksheet after it was loaded here (audit D7). The local edits are kept by the caller. */
export class WorksheetConflictError extends Error {
  constructor() {
    super("Someone else saved this worksheet after you opened it. Your changes are still here: copy anything you need, then reload to see theirs.");
    this.name = "WorksheetConflictError";
  }
}

/** The job no longer exists here, or this person can no longer edit it (audit A12). */
export class WorksheetMissingError extends Error {
  constructor() {
    super("This job can't be saved: it no longer exists or you no longer have access to it. Your changes are still here.");
    this.name = "WorksheetMissingError";
  }
}

/**
 * Saves only if the worksheet is still at the version that was loaded, and only reports success when exactly one
 * row was written; returns the saved row and its new version. Zero rows is a conflict (row still there, newer
 * version) or missing/denied, never "saved".
 */
export async function saveWorksheet(id: string, ws: JobWorksheet, version: number | null, { queueWhenOffline = true } = {}) {
  if (!supabase) {
    if (DEMO_MODE) return { demo: true as const, version: null, row: null };
    throw new Error("Supabase is not configured.");
  }
  if (version === null) throw new WorksheetMissingError();
  const { data, error } = await supabase.from("jobs").update(worksheetToPatch(ws)).eq("id", id).eq("worksheet_version", version).select("*");
  if (error) {
    if (queueWhenOffline && isNetworkError(error) && (await queueWorksheetOffline(id, ws, version))) return { demo: false as const, version, row: null, queued: true as const };
    throw error;
  }
  if (data?.length === 1) return { demo: false as const, version: Number(data[0].worksheet_version ?? version + 1), row: data[0] as Record<string, unknown> };
  const { data: current } = await supabase.from("jobs").select("id, worksheet_version").eq("id", id).maybeSingle();
  // Still there at a newer version: someone else saved. Same version but nothing written: not allowed to edit it.
  if (current && Number(current.worksheet_version) !== version) throw new WorksheetConflictError();
  throw new WorksheetMissingError();
}

export async function loadMachineNames(): Promise<string[]> {
  try {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data, error } = await supabase.from("machines").select("*");
    if (error) throw error;
    const names = (data || []).map((row) => String(row.name || row.machine_name || row.machine || "")).filter(Boolean);
    return names.length || !DEMO_MODE ? names : DEMO_MACHINES;
  } catch {
    return DEMO_MODE ? DEMO_MACHINES : [];
  }
}

async function loadOrganizationId(): Promise<string | null> {
  if (!supabase) return null;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  // The company of this sign-in session, as the database sees it (not the profile's copy).
  const { data } = await supabase.rpc("current_user_organization_id");
  return typeof data === "string" ? data : null;
}

/**
 * The job's drawings: the rows in job_files (current revision of each, the labels of the ones it replaced) plus any file in the
 * job's own folder that has no row yet (uploaded before migration 034). Returns null when Storage is not reachable (caller
 * falls back to the demo list).
 */
export async function listDrawings(jobId: string): Promise<DrawingFile[] | null> {
  try {
    const orgId = await loadOrganizationId();
    if (!supabase || !orgId) return null;
    const folder = `${orgId}/${jobId}`;
    const [{ data: rows, error: rowsError }, { data, error }] = await Promise.all([
      supabase.from("job_files").select("id, ref, revision, file_name, storage_bucket, storage_path, superseded_at, created_at").eq("job_id", jobId).eq("kind", "drawing").order("created_at").order("id"),
      supabase.storage.from(DRAWINGS_BUCKET).list(folder),
    ]);
    if (error) throw error;
    const registered = new Set<string>();
    const current: DrawingFile[] = [];
    const earlier = new Map<string, string[]>();
    for (const row of rowsError ? [] : rows ?? []) {
      registered.add(`${row.storage_bucket}/${row.storage_path}`);
      if (row.superseded_at) {
        earlier.set(row.ref, [...(earlier.get(row.ref) ?? []), row.revision || "no label"]);
      } else {
        current.push({ id: row.id, name: row.file_name, path: row.storage_path, bucket: row.storage_bucket, revision: row.revision, earlier: [] });
      }
    }
    for (const drawing of current) drawing.earlier = earlier.get((rows ?? []).find((row) => row.id === drawing.id)?.ref ?? "") ?? [];
    // Folders (inspection photos, certs) come back as entries without an id; only files are drawings.
    const loose = (data || [])
      .filter((file) => file.id && file.name !== ".emptyFolderPlaceholder" && !registered.has(`${DRAWINGS_BUCKET}/${folder}/${file.name}`))
      .map((file): DrawingFile => ({ name: file.name.replace(/^\d{13}-/, ""), path: `${folder}/${file.name}`, bucket: DRAWINGS_BUCKET }));
    return [...current, ...loose];
  } catch {
    return null;
  }
}

export const MAX_DRAWING_BYTES = 20 * 1024 * 1024;
const DRAWING_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];

/** Client-side check before upload (the bucket enforces the same limits in migration 006). Returns an error message or null. */
export function validateDrawing(file: File): string | null {
  if (!DRAWING_TYPES.includes(file.type)) return `${file.name}: only PDF, PNG, JPEG or WebP files are allowed.`;
  if (file.size > MAX_DRAWING_BYTES) return `${file.name}: files must be 20MB or smaller.`;
  return null;
}

export async function uploadDrawing(jobId: string, file: File): Promise<DrawingFile> {
  const problem = validateDrawing(file);
  if (problem) throw new Error(problem);
  const orgId = await loadOrganizationId();
  if (!supabase || !orgId) throw new Error("Storage is not available.");
  const name = file.name.replace(/[^\w.\- ()]/g, "_");
  // Timestamp prefix keeps every upload unique, so nothing is ever overwritten.
  const path = `${orgId}/${jobId}/${Date.now()}-${name}`;
  const { error } = await supabase.storage.from(DRAWINGS_BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  const { data, error: rowError } = await supabase.from("job_files").insert({
    organization_id: orgId, job_id: jobId, kind: "drawing", ref: name.replace(/\.[^.]*$/, "") || name, file_name: name, storage_bucket: DRAWINGS_BUCKET, storage_path: path,
  }).select("id").single();
  if (rowError) throw rowError;
  return { id: data.id, name, path, bucket: DRAWINGS_BUCKET, revision: null, earlier: [] };
}

/** The job's worksheet version now. A drawing revision raises it (migration 034), so the open worksheet takes the new one. */
export async function currentWorksheetVersion(jobId: string): Promise<number | null> {
  if (!supabase) return null;
  const { data } = await supabase.from("jobs").select("worksheet_version").eq("id", jobId).maybeSingle();
  return data ? Number(data.worksheet_version) : null;
}

/**
 * What the job's inspection requires before a pass (migration 034): its certificates attached, its checklist ticked; and (082) whether
 * it is traceable (its material cert no. and heat/cast no. before a pass). Admin and office.
 */
export async function setInspectionRequirements(jobId: string, patch: { certs_required?: boolean; checklist_required?: boolean; traceable?: boolean }): Promise<void> {
  if (!supabase) throw new Error("Storage is not available.");
  const { data, error } = await supabase.from("jobs").update(patch).eq("id", jobId).select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("That couldn't be saved: only admin and office staff change what an inspection requires.");
}

/** The traceability numbers a pass on a traceable job needs (082) that the worksheet doesn't have yet, as people name them. */
export function missingTraceability(ws: Pick<JobWorksheet, "material_cert_no" | "heat_cast_no">): string[] {
  return [!ws.material_cert_no?.trim() ? "Material Cert #" : "", !ws.heat_cast_no?.trim() ? "Heat / Cast #" : ""].filter(Boolean);
}

/** Sets a drawing's first revision label (an admin approves it). A label already set is never changed: the next revision is a new file. */
export async function setDrawingRevision(id: string, revision: string): Promise<void> {
  if (!supabase) throw new Error("Storage is not available.");
  const label = revision.trim();
  if (!label) throw new Error("Give the revision.");
  if (label.length > 20) throw new Error("A revision is at most 20 characters.");
  const { data, error } = await supabase.from("job_files").update({ revision: label }).eq("id", id).select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("That drawing couldn't be updated: it has been replaced, or you can't change it.");
}

/** Uploads a newer revision of a drawing and makes it the current one (bump_drawing_revision); the old file stays listed as replaced. */
export async function uploadNewRevision(drawing: DrawingFile, jobId: string, file: File, revision: string): Promise<DrawingFile> {
  if (!drawing.id) throw new Error("This drawing has no revision record yet. Open the worksheet again and retry.");
  if (!revision.trim()) throw new Error("Give the new revision first.");
  const problem = validateDrawing(file);
  if (problem) throw new Error(problem);
  const orgId = await loadOrganizationId();
  if (!supabase || !orgId) throw new Error("Storage is not available.");
  const name = file.name.replace(/[^\w.\- ()]/g, "_");
  const path = `${orgId}/${jobId}/${Date.now()}-${name}`;
  const { error } = await supabase.storage.from(DRAWINGS_BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  const { data, error: rpcError } = await supabase.rpc("bump_drawing_revision", { p_file: drawing.id, p_revision: revision.trim(), p_file_name: name, p_storage_path: path });
  if (rpcError) throw rpcError;
  return { id: data as string, name, path, bucket: DRAWINGS_BUCKET, revision: revision.trim(), earlier: [...(drawing.earlier ?? []), drawing.revision || "no label"] };
}

/** Signed link that downloads the file (not rendered inline) under its original name. */
export async function drawingUrl(path: string, name: string, bucket: string = DRAWINGS_BUCKET): Promise<string> {
  if (!supabase) throw new Error("Storage is not available.");
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 300, { download: name });
  if (error || !data) throw error ?? new Error("Could not create download link.");
  return data.signedUrl;
}
