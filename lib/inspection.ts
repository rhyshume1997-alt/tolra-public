import { missingDbObject } from "@/lib/db-features";
import { DRAWINGS_BUCKET, missingTraceability, validateDrawing } from "@/lib/job-worksheet";
import { newClientOpId } from "@/lib/machine-runs";
import { queueOffline } from "@/lib/offline/scope";
import { isNetworkError } from "@/lib/offline/store";
import { type FailedLine, failInspection } from "@/lib/rework";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { databaseHas083 } from "@/lib/inspectors";

export type InspectionResult = "pass" | "fail" | "concession";

export type InspectionRecord = {
  id: string;
  job_id: string;
  result: InspectionResult;
  release_decision: "released" | "held";
  measured_notes: string;
  attachment_path: string | null;
  attachment_name: string | null;
  concession_reason: string | null;
  inspector_name: string;
  inspected_at: string;
  worksheet_version: number;
  /** 081: what it was checked against (written once, with the record). Absent on a record made before 081. */
  acceptance_criteria?: string | null;
  /** 081: false when an admin recorded the pass of a job they finished themselves (internal: never on a delivery note). */
  independent?: boolean | null;
  override_reason?: string | null;
  /** 081: what happens to what failed (8.7): rework, scrap or concession; null on a pass or an older fail. */
  disposition?: Disposition | null;
};

/** What happens to what failed (ISO 9001 8.7, migration 081). A concession needs an admin. */
export type Disposition = "rework" | "scrap" | "concession";
export const DISPOSITION_LABELS: Record<Disposition, string> = { rework: "Rework", scrap: "Scrap and remake", concession: "Concession (accept as it is)" };

export const INSPECTION_LABELS: Record<InspectionResult, string> = { pass: "Passed", fail: "Failed: sent to rework", concession: "Released on concession" };

/**
 * What a delivery note may say about the inspection (081): "Inspected/checked", the inspector's name and the date. Never whether it was
 * independent (that stays on the inspection record and in the audit log), never the criteria or the measurements.
 */
export function deliveryNoteInspectionLine(record: Pick<InspectionRecord, "inspector_name" | "inspected_at" | "result"> | undefined, formatDate: (iso: string) => string): string | null {
  if (!record || record.result === "fail") return null;
  const name = (record.inspector_name ?? "").trim();
  return `Inspected/checked${name && !name.includes("@") ? ` by ${name}` : ""}, ${formatDate(record.inspected_at)}`;
}

/** What the job board says about a job's inspection, from its newest record. */
export function inspectionSummary(latest: Pick<InspectionRecord, "result" | "inspected_at"> | undefined, released: boolean): string {
  if (!latest) return released ? "Inspected (before inspection records)" : "Not inspected";
  if (latest.result === "fail") return INSPECTION_LABELS.fail;
  return released ? INSPECTION_LABELS[latest.result] : "Sign-off withdrawn: the worksheet changed after inspection";
}

/** Newest record per job. */
export function latestByJob(records: InspectionRecord[]): Map<string, InspectionRecord> {
  const latest = new Map<string, InspectionRecord>();
  for (const record of records) {
    const current = latest.get(record.job_id);
    if (!current || record.inspected_at > current.inspected_at) latest.set(record.job_id, record);
  }
  return latest;
}

export async function loadInspections(jobId?: string): Promise<InspectionRecord[]> {
  if (!supabase) return [];
  let query = supabase.from("job_inspections").select("*").order("inspected_at", { ascending: false }).limit(jobId ? 50 : 2000);
  if (jobId) query = query.eq("job_id", jobId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as InspectionRecord[];
}

/** Uploads the optional photo or file to the job's inspection folder in the job-drawings bucket; returns its path. */
export async function uploadInspectionFile(jobId: string, file: File): Promise<{ path: string; name: string }> {
  const problem = validateDrawing(file);
  if (problem) throw new Error(problem);
  const orgId = await getCurrentOrganizationId();
  if (!supabase || !orgId) throw new Error("Storage is not available.");
  const name = file.name.replace(/[^\w.\- ()]/g, "_");
  const path = `${orgId}/${jobId}/inspection/${Date.now()}-${name}`;
  const { error } = await supabase.storage.from(DRAWINGS_BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  return { path, name };
}

/** The rework details a failed inspection records (migration 037): why, how many (of which order line and batch), and what the workshop should do. */
export type FailureDetails = { reason: string; quantity: number | null; instructions: string; lines?: FailedLine[] | null; batch?: string | null };

export type RecordedInspection = {
  inspection_id: string; result: InspectionResult; release_decision: "released" | "held"; inspected_at: string; rework_id?: string;
  /** 081: false when an admin recorded the pass of their own work (with a reason). */
  independent?: boolean | null;
  /** Kept on this device while offline: "Sync pending", nothing is released until the server records it. */
  queued?: boolean;
};

/** What the inspector needs to know before recording: the job's version now, what it requires, and whether they may (034; 083's list). */
export type InspectionContext = {
  version: number; certsRequired: boolean; checklistRequired: boolean; certCount: number; canInspect: boolean;
  /** 081: the signed-in person finished the job (or the rework awaiting this inspection), so their pass isn't independent. */
  finishedByMe: boolean;
  /** The signed-in person's id (an offline inspection is bound to it). */
  me: string | null;
  /** 082: what a pass on this traceable job still needs (Material Cert #, Heat / Cast #); empty when not traceable or before 082. */
  traceabilityMissing?: string[];
};

/** Before 083 an admin always may record an inspection; from 083 only the people on the authorised inspectors list (admins included). */
export function mayRecordInspection(isAdmin: boolean, has083: boolean, onList: boolean): boolean {
  return (isAdmin && !has083) || onList;
}

/** The Job Board's Inspected action is offered unless the person is known not to be an inspector (null: not known yet or offline, so offered; the dialog and the database still decide). */
export function inspectedActionOffered(canInspect: boolean | null): boolean {
  return canInspect !== false;
}

/**
 * May the signed-in person record an inspection? The same rule and the same reads as the inspection dialog (loadInspectionContext).
 * false only when it is known: no member row (the read succeeded with none) or can_inspect off. A read that fails (offline, network,
 * server) throws, so the caller treats it as not known (the board keeps Inspected offered; the dialog and the database still decide).
 */
export async function loadCanInspect(isAdmin: boolean, me?: string | null): Promise<boolean> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const has083 = isAdmin ? await databaseHas083() : true; // only an admin's answer depends on 083 (a non-admin always needs the list)
  if (mayRecordInspection(isAdmin, has083, false)) return true;
  let userId = me;
  if (userId === undefined) {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error; // not known (offline or a failed read), never "not an inspector"
    userId = data.user?.id ?? null;
  }
  if (!userId) return false;
  const { data: member, error } = await supabase.from("organization_members").select("can_inspect").eq("user_id", userId).eq("organization_id", await getCurrentOrganizationId() ?? "").maybeSingle();
  if (error) throw error; // not known, as above
  return mayRecordInspection(isAdmin, has083, Boolean(member?.can_inspect));
}

export async function loadInspectionContext(jobId: string, isAdmin: boolean): Promise<InspectionContext> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: job, error } = await supabase.from("jobs").select("worksheet_version, certs_required, checklist_required").eq("id", jobId).single();
  if (error) throw error;
  const { count } = await supabase.from("job_files").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("kind", "cert");
  const { data: userData } = await supabase.auth.getUser();
  const me = userData.user?.id ?? null;
  const canInspect = await loadCanInspect(isAdmin, me);
  // Who finished it (035's finished_by), and who finished a rework this inspection decides (037, awaiting re-inspection).
  let finishedByMe = false;
  if (me) {
    const { data: finished } = await supabase.from("jobs").select("finished_by").eq("id", jobId).maybeSingle();
    const { data: reworks } = await supabase.from("job_rework").select("finished_by").eq("job_id", jobId).eq("status", "finished");
    finishedByMe = finished?.finished_by === me || (reworks ?? []).some((row) => row.finished_by === me);
  }
  // 082: a traceable job's cert no. and heat/cast no. Before 082 the column is missing and nothing is said (the server decides anyway).
  const { data: trace } = await supabase.from("jobs").select("traceable, material_cert_no, heat_cast_no").eq("id", jobId).maybeSingle();
  const traceabilityMissing = trace && (trace as { traceable?: unknown }).traceable === true
    ? missingTraceability({ material_cert_no: String((trace as { material_cert_no?: unknown }).material_cert_no ?? ""), heat_cast_no: String((trace as { heat_cast_no?: unknown }).heat_cast_no ?? "") })
    : [];
  return { version: Number(job.worksheet_version), certsRequired: Boolean(job.certs_required), checklistRequired: Boolean(job.checklist_required), certCount: count ?? 0, canInspect, finishedByMe, me, traceabilityMissing };
}

export type InspectionArgs = {
  jobId: string; jobNo?: string; result: InspectionResult; notes: string; concessionReason: string; file?: File | null; expectedVersion: number; failure?: FailureDetails;
  /** 081: what it was checked against (required). */
  criteria?: string;
  /** 081: an admin recording the pass of their own work says why (10+ characters). */
  overrideReason?: string;
  /** 081: what happens to what failed. */
  disposition?: Disposition;
  /** The signed-in person: an inspection kept offline is bound to them. */
  me?: string | null;
};

/** inspect_job's arguments (migration 081) for an inspection. */
export function inspectArgs(args: InspectionArgs, uploaded: { path: string; name: string } | null, clientOpId: string | null) {
  const failure = args.result === "fail" && args.failure
    ? { reason: args.failure.reason, instructions: args.failure.instructions, quantity: args.failure.lines?.length ? null : args.failure.quantity, lines: args.failure.lines?.length ? args.failure.lines : null, batch: args.failure.batch?.trim() || null }
    : null;
  return {
    p_job: args.jobId, p_result: args.result, p_criteria: (args.criteria ?? "").trim(), p_measured: args.notes, p_expected_version: args.expectedVersion,
    p_attachment_path: uploaded?.path ?? null, p_attachment_name: uploaded?.name ?? null,
    p_concession_reason: args.result === "concession" || args.disposition === "concession" ? args.concessionReason : null,
    p_override_reason: args.overrideReason?.trim() || null, p_disposition: args.result === "fail" ? args.disposition ?? "rework" : null, p_failure: failure, p_client_op_id: clientOpId,
  };
}

/**
 * Records an inspection (081: inspect_job, with the acceptance criteria, the disposition of a failure and an admin's reason for
 * inspecting their own work). Offline, without a file, it is kept on this device ("Sync pending", queued: true) and sent with its key
 * when the connection is back; nothing is released meanwhile. A database without 081 takes it the older way (034/037).
 */
export async function recordInspection(args: InspectionArgs): Promise<RecordedInspection> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const clientOpId = newClientOpId();
  const uploaded = args.file ? await uploadInspectionFile(args.jobId, args.file) : null;
  const sent = await supabase.rpc("inspect_job", inspectArgs(args, uploaded, clientOpId));
  if (!sent.error) return sent.data as RecordedInspection;
  if (isNetworkError(sent.error) && !uploaded && args.me) {
    const p = inspectArgs(args, null, clientOpId);
    const queued = await queueOffline({
      kind: "inspect", v: 1, jobRef: args.jobId, jobNo: args.jobNo ?? "", clientOpId, capturedBy: args.me, capturedAt: new Date().toISOString(),
      result: args.result, criteria: p.p_criteria, measured: args.notes, expectedVersion: args.expectedVersion, concessionReason: p.p_concession_reason,
      overrideReason: p.p_override_reason, disposition: p.p_disposition as Disposition | null, failure: p.p_failure,
    });
    if (queued) return { inspection_id: clientOpId, result: args.result, release_decision: "held", inspected_at: new Date().toISOString(), queued: true };
  }
  if (!missingDbObject(sent.error)) throw sent.error;
  // A database without 081: the older calls.
  if (args.result === "fail" && args.failure) {
    const done = await failInspection({ jobId: args.jobId, notes: args.notes, reason: args.failure.reason, quantity: args.failure.quantity, instructions: args.failure.instructions, attachment: uploaded, lines: args.failure.lines, batch: args.failure.batch });
    return { inspection_id: done.inspection_id, result: done.result, release_decision: done.release_decision, inspected_at: done.inspected_at, rework_id: done.rework_id };
  }
  const { data, error } = await supabase.rpc("record_job_inspection", {
    p_job: args.jobId, p_result: args.result, p_notes: args.notes, p_attachment_path: uploaded?.path ?? null,
    p_attachment_name: uploaded?.name ?? null, p_concession_reason: args.result === "concession" ? args.concessionReason : null,
    p_expected_version: args.expectedVersion,
  });
  if (error) throw error;
  return data as RecordedInspection;
}
