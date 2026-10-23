/**
 * Operator sign-off (M4, migration 045). A sign-off belongs to the worksheet revision (jobs.worksheet_version) it signed: the job
 * is signed when a sign-off exists for its CURRENT revision. Signing goes through public.sign_off_job, which snapshots and hashes the
 * worksheet on the server and checks it is the revision and snapshot hash the person signed (job_signoff_revision). Offline (Rhys: "sign
 * and save offline but uploads when back") the signature is kept on the device as an outbox entry (SignOffOp, lib/offline) bound to the
 * signer and that revision, and uploaded under its client key when the connection is back.
 *
 * One signature per revision (Rhys): each revision has exactly one primary sign-off (the operator's), enforced by the database, and
 * may have one co-signature per role (today only "inspector"), from someone other than the primary signer and only after the primary.
 *
 * Customer sign-off (migration 072, Marpet: "customers sign off the job on site"): a third kind of row, "customer", captured by a fitter on
 * their phone while the customer signs on its screen, when the company has "Customer sign-off on jobs" on. It is apart from the internal
 * sign-off above (it never makes a revision signed or stale, and is never a co-signature), is recorded through sign_off_job_customer, and
 * works offline the same way (CustomerSignOffOp).
 */
import { useEffect, useState } from "react";

import { conflictEntries, newPhotoId, pendingEntries, rejectedEntries, type CustomerSignOffOp, type InternalSignOffOp, type SignOffOp } from "@/lib/offline/outbox";
import { offlineScope } from "@/lib/offline/scope";
import { isNetworkError } from "@/lib/offline/store";
import { canonicalJson, sha256Hex, verifySnapshot } from "@/lib/snapshot-hash";
import { supabase } from "@/lib/supabase";

export type SignatureKind = "drawn" | "typed";

/** Co-sign roles (keep in step with the kind CHECK on job_signoffs, migration 045). */
export const SIGNOFF_ROLES = ["inspector"] as const;
export type SignOffRole = (typeof SIGNOFF_ROLES)[number];
/** What an internal sign-off row is: the revision's one primary sign-off, or a co-signature in a role. */
export type SignOffKind = "primary" | SignOffRole;
/** Every kind of row in job_signoffs: the internal ones, and a customer's sign-off (072). */
export type SignOffRowKind = SignOffKind | "customer";

/**
 * The statement shown to the customer above the signature box, and stored with their sign-off (so a later change of wording never
 * rewrites what an earlier customer signed). The one place this wording lives. Deliberately sent by the app and stored as given (the
 * server keeps what was shown, it does not impose its own wording); likewise the revision and hash sent as "shown" are the phone's
 * claim, while the row's own revision, snapshot and hash are the server's (migration 072 header).
 */
export const CUSTOMER_SIGNOFF_STATEMENT = "I confirm the work on this job has been completed to my satisfaction.";

export type JobSignOff = {
  id: string;
  job_id: string;
  worksheet_version: number;
  snapshot: Record<string, unknown>;
  snapshot_sha256: string;
  record_sha256: string;
  initials: string;
  signer_name: string;
  signed_on: string;
  signature_kind: SignatureKind;
  signature_data: string;
  signed_by: string;
  kind: SignOffRowKind;
  created_at: string;
  /** Customer rows only (072; absent or null on every other row, and on a database without 072). */
  signer_position?: string | null;
  signer_company?: string | null;
  statement?: string | null;
  customer_comment?: string | null;
  device_signed_at?: string | null;
  shown_worksheet_version?: number | null;
  shown_snapshot_sha256?: string | null;
};

export type SignOffStatus =
  | { status: "signed"; latest: JobSignOff; cosigns: JobSignOff[] }
  | { status: "stale"; latest: JobSignOff; currentVersion: number }
  | { status: "none" };

/** Every column, so the customer columns come back once 072 is applied and their absence before it is no error. */
const COLUMNS = "*";

/** Newest first: highest revision, then latest signed. */
export function sortSignOffs(rows: JobSignOff[]) {
  return [...rows].sort((a, b) => b.worksheet_version - a.worksheet_version || b.created_at.localeCompare(a.created_at));
}

const isPrimary = (row: JobSignOff) => (row.kind ?? "primary") === "primary";
export const isCustomerSignOff = (row: Pick<JobSignOff, "kind">) => row.kind === "customer";
/** The internal sign-off rows (primary and co-signatures): a customer's sign-off is never one of them. */
export const internalSignOffs = (rows: JobSignOff[]) => rows.filter((row) => !isCustomerSignOff(row));
/** The job's customer sign-offs, newest first (any revision: the customer signs the job, not the worksheet revision). */
export const customerSignOffs = (rows: JobSignOff[]) => [...rows].filter(isCustomerSignOff).sort((a, b) => b.created_at.localeCompare(a.created_at));

/**
 * Signed (the current revision has its primary sign-off; `latest` is that primary and `cosigns` its co-signatures in role order),
 * stale (an earlier revision was signed; edited since) or none. A co-signature alone never makes a revision signed.
 */
export function signOffStatus(all: JobSignOff[], currentVersion: number | null | undefined): SignOffStatus {
  const rows = internalSignOffs(all);
  const sorted = sortSignOffs(rows).filter(isPrimary);
  if (!sorted.length || currentVersion == null) return { status: "none" };
  const current = sorted.find((row) => row.worksheet_version === currentVersion);
  if (current) {
    const cosigns = rows.filter((row) => row.worksheet_version === currentVersion && !isPrimary(row))
      .sort((a, b) => SIGNOFF_ROLES.indexOf(a.kind as SignOffRole) - SIGNOFF_ROLES.indexOf(b.kind as SignOffRole) || a.created_at.localeCompare(b.created_at));
    return { status: "signed", latest: current, cosigns };
  }
  return { status: "stale", latest: sorted[0], currentVersion };
}

/** The co-sign roles still open on a signed revision (none when it isn't signed). */
export function openCosignRoles(status: SignOffStatus): SignOffRole[] {
  if (status.status !== "signed") return [];
  return SIGNOFF_ROLES.filter((role) => !status.cosigns.some((row) => row.kind === role));
}

/** "inspector" -> "Inspector"; "primary" -> "Signed off"; "customer" -> "Customer". */
export const kindLabel = (kind: SignOffRowKind) => (kind === "primary" ? "Signed off" : kind.charAt(0).toUpperCase() + kind.slice(1));

/** Internal sign-offs grouped by revision, newest revision first. */
export function signOffsByRevision(rows: JobSignOff[]): { version: number; rows: JobSignOff[] }[] {
  const groups = new Map<number, JobSignOff[]>();
  for (const row of sortSignOffs(internalSignOffs(rows))) groups.set(row.worksheet_version, [...(groups.get(row.worksheet_version) ?? []), row]);
  return [...groups.entries()].map(([version, list]) => ({ version, rows: list }));
}

export const hashPrefix = (sha: string) => sha.slice(0, 12);

/** "Rita Hale" -> "RH"; letters only, at most 4. */
export function initialsFrom(name: string | null | undefined) {
  return (name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[\s-]+/).map((part) => part.replace(/[^A-Za-z]/g, "").charAt(0)).join("").toUpperCase().slice(0, 4);
}

export const validInitials = (value: string) => /^[A-Z]{1,4}$/.test(value.trim().toUpperCase());

/** "17 Oct 2026, 14:03" in the UK. */
export function formatSignedAt(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "Jane Smith, Site Manager, Acme Ltd" (the parts given). */
export const customerLine = (row: { signer_name: string; signer_position?: string | null; signer_company?: string | null }) =>
  [row.signer_name, row.signer_position, row.signer_company].filter((part) => part && part.trim()).join(", ");

/** A customer's initials, as sign_off_job_customer (072) takes them from the printed name: initialsFrom, or "C" when it has no A-Z letter. */
export const customerInitials = (name: string) => initialsFrom(name) || "C";

/** Today's date in the UK (YYYY-MM-DD), the default sign-off date. */
export function todayInLondon(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 2026-10-13 -> 13 Oct 2026. */
export function formatSignedOn(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * A stored time as the hash takes it (UTC, milliseconds). 072 only stores a finite phone time inside its window, so this never meets an
 * unparseable one from the server; if it did, the raw text is hashed (the check then fails visibly instead of throwing).
 */
const isoTime = (value: string | null | undefined) => {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toISOString();
};

type HashedFields = Pick<JobSignOff, "snapshot_sha256" | "initials" | "signer_name" | "signed_on" | "signature_kind" | "signature_data" | "worksheet_version" | "job_id" | "kind">
  & Partial<Pick<JobSignOff, "signed_by" | "signer_position" | "signer_company" | "statement" | "customer_comment" | "device_signed_at" | "shown_worksheet_version" | "shown_snapshot_sha256">>;

/**
 * The record hash: the snapshot hash plus the signature fields (keep in step with sign_off_job in migration 045); a customer row adds its
 * own fields and the capturer (keep in step with sign_off_job_customer in migration 072; the phone's time as UTC with milliseconds).
 */
export async function recordSha256(row: HashedFields) {
  const base = {
    snapshot_sha256: row.snapshot_sha256, initials: row.initials, signer_name: row.signer_name, signed_on: row.signed_on,
    signature_kind: row.signature_kind, signature_data: row.signature_data, worksheet_version: String(row.worksheet_version), job_id: row.job_id,
    kind: row.kind,
  };
  if (row.kind !== "customer") return sha256Hex(canonicalJson(base));
  return sha256Hex(canonicalJson({
    ...base, signer_position: row.signer_position ?? null, signer_company: row.signer_company ?? null, statement: row.statement ?? null,
    customer_comment: row.customer_comment ?? null, device_signed_at: isoTime(row.device_signed_at),
    shown_worksheet_version: row.shown_worksheet_version == null ? null : String(row.shown_worksheet_version), shown_snapshot_sha256: row.shown_snapshot_sha256 ?? null,
    captured_by: row.signed_by ?? null,
  }));
}

/** Both hashes recomputed in the browser match what the server stored. */
export async function verifySignOff(row: JobSignOff) {
  return (await verifySnapshot(row.snapshot, row.snapshot_sha256)) && (await recordSha256(row)) === row.record_sha256;
}

export async function listSignOffs(jobId: string): Promise<JobSignOff[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("job_signoffs").select(COLUMNS).eq("job_id", jobId);
  if (error) throw error;
  return sortSignOffs((data ?? []) as JobSignOff[]);
}

/** The revision a sign-off is bound to: the job's current worksheet_version and the server's snapshot hash of it (job_signoff_revision). */
export type SignOffRevision = { job_id: string; worksheet_version: number; snapshot_sha256: string };

export async function getSignOffRevision(jobId: string): Promise<SignOffRevision> {
  if (!supabase) throw new Error("Sign-off needs a connection to the server.");
  const { data, error } = await supabase.rpc("job_signoff_revision", { p_job_id: jobId });
  if (error) throw error;
  return data as SignOffRevision;
}

/**
 * The snapshot hash a new signature must carry: a primary signs the revision the server described (only when it is the version on
 * screen); a co-signature signs exactly what the primary signed. Null when the screen's revision isn't known (reload, or open the job
 * online once on this revision before signing offline).
 */
export function expectedSnapshotSha(status: SignOffStatus, revision: SignOffRevision | null, version: number | null | undefined, role: SignOffKind) {
  if (version == null) return null;
  if (role !== "primary") return status.status === "signed" && status.latest.worksheet_version === version ? status.latest.snapshot_sha256 : null;
  return revision && revision.worksheet_version === version ? revision.snapshot_sha256 : null;
}

export type SignOffInput = {
  jobId: string; jobNo: string; expectedVersion: number; expectedSha256: string; initials: string; signerName: string; signedOn: string; kind: SignatureKind; data: string;
  role?: SignOffKind; clientOpId?: string;
};
export type SignOffResult = { id: string; worksheet_version: number; kind: SignOffRowKind; snapshot_sha256: string; record_sha256: string; replayed?: boolean };

/** The device-queue entry for a signature: bound to who captured it and the revision they saw. */
export function signOffOp(input: SignOffInput, capturedBy: string, now = new Date()): InternalSignOffOp {
  return {
    kind: "signoff", clientOpId: input.clientOpId ?? newPhotoId(), jobId: input.jobId, jobNo: input.jobNo, expectedVersion: input.expectedVersion, expectedSha256: input.expectedSha256,
    initials: input.initials.trim().toUpperCase(), signerName: input.signerName.trim(), signedOn: input.signedOn, signatureKind: input.kind,
    signatureData: input.kind === "typed" ? input.data.trim() : input.data, role: input.role ?? "primary", capturedBy, capturedAt: now.toISOString(),
  };
}

/**
 * A customer's sign-off as the fitter captures it (072). `shownVersion` / `shownSha256`: the revision on screen when the customer signed
 * (null when the device has none). `signedAt`: the phone's clock at that moment (recorded as the device time; the server adds its own).
 */
export type CustomerSignOffInput = {
  jobId: string; jobNo: string; signerName: string; position?: string | null; company?: string | null; comment?: string | null; statement?: string;
  kind: SignatureKind; data: string; shownVersion: number | null; shownSha256: string | null; signedAt?: Date; clientOpId?: string;
};

const optional = (value: string | null | undefined) => (value ?? "").trim() || null;

/** The device-queue entry for a customer's sign-off: bound to the fitter who captured it, with the phone's time. */
export function customerSignOffOp(input: CustomerSignOffInput, capturedBy: string, now = new Date()): CustomerSignOffOp {
  const signedAt = input.signedAt ?? now;
  const name = input.signerName.trim();
  const shown = input.shownSha256 && input.shownVersion != null;
  return {
    kind: "signoff", role: "customer", clientOpId: input.clientOpId ?? newPhotoId(), jobId: input.jobId, jobNo: input.jobNo,
    expectedVersion: shown ? input.shownVersion : null, expectedSha256: shown ? input.shownSha256 : null,
    initials: customerInitials(name), signerName: name, signedOn: todayInLondon(signedAt), signatureKind: input.kind,
    signatureData: input.kind === "typed" ? input.data.trim() : input.data, capturedBy, capturedAt: now.toISOString(),
    customer: { position: optional(input.position), company: optional(input.company), statement: input.statement ?? CUSTOMER_SIGNOFF_STATEMENT, comment: optional(input.comment), deviceSignedAt: signedAt.toISOString() },
  };
}

/** Records a customer's sign-off now (online), under the op's key: the same call the offline queue makes, so a retry is a replay. */
export async function signOffJobCustomer(op: CustomerSignOffOp): Promise<SignOffResult> {
  if (!supabase) throw new Error("Sign-off needs a connection to the server.");
  const { data, error } = await supabase.rpc("sign_off_job_customer", {
    p_job_id: op.jobId, p_signer_name: op.signerName, p_signer_position: op.customer.position, p_signer_company: op.customer.company, p_statement: op.customer.statement,
    p_comment: op.customer.comment, p_signature_kind: op.signatureKind, p_signature_data: op.signatureData, p_device_signed_at: op.customer.deviceSignedAt,
    p_client_op_id: op.clientOpId, p_shown_version: op.expectedVersion, p_shown_snapshot_sha256: op.expectedSha256,
  });
  if (error) throw error;
  return data;
}

/** Whether the signed-in person's company has "Customer sign-off on jobs" on (072). False before 072 or when it can't be read; a lost connection throws. */
export async function customerSignOffEnabled(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.from("organization_settings").select("customer_signoff_enabled").maybeSingle();
  if (error) {
    if (isNetworkError(error)) throw error;
    return false;
  }
  return (data as { customer_signoff_enabled?: boolean } | null)?.customer_signoff_enabled === true;
}

export async function signOffJob(input: SignOffInput): Promise<SignOffResult> {
  if (!supabase) throw new Error("Sign-off needs a connection to the server.");
  const { data, error } = await supabase.rpc("sign_off_job", {
    p_job_id: input.jobId, p_expected_version: input.expectedVersion, p_expected_snapshot_sha256: input.expectedSha256, p_initials: input.initials.trim().toUpperCase(),
    p_signer_name: input.signerName.trim(), p_signed_on: input.signedOn, p_signature_kind: input.kind, p_signature_data: input.data, p_kind: input.role ?? "primary",
    p_client_op_id: input.clientOpId ?? null,
  });
  if (error) throw error;
  return data;
}

/** A signature of this job still on the device: waiting to upload, or held (refused or in conflict) with the reason. */
export type PendingSignOff = { id: string; op: SignOffOp; status: "waiting" | "failed"; reason?: string };

/** This job's signatures on the device, for the signed-in person's scope only (another person's are never listed or sent). */
export async function pendingSignOffsFor(jobId: string): Promise<PendingSignOff[]> {
  const scope = offlineScope();
  if (!scope) return [];
  const [waiting, conflicts, rejected] = await Promise.all([pendingEntries(scope), conflictEntries(scope), rejectedEntries(scope)]);
  const mine = (op: { kind: string; jobId?: string }): op is SignOffOp => op.kind === "signoff" && op.jobId === jobId;
  return [
    ...waiting.flatMap((entry) => (mine(entry.op) ? [{ id: entry.id, op: entry.op, status: "waiting" as const }] : [])),
    ...[...conflicts, ...rejected].flatMap((entry) => (mine(entry.op) ? [{ id: entry.id, op: entry.op, status: "failed" as const, reason: entry.reason }] : [])),
  ];
}

/** The internal sign-off of the job's current revision, plus its customer sign-offs (072; newest first, empty when none). */
export type PrintedSignOff = SignOffStatus & { customer?: JobSignOff[] };

/** The old typed sign-off box (jobs.signed_off_by / signed_off_at, before migration 045): a name and a time, with no signature or hash. */
export type LegacySignOff = { name: string; at: string };

/**
 * What an old typed record says when no hashed sign-off exists for the job: it is an existing record, so it is shown, but clearly as
 * what it is. Null when there is a hashed sign-off (signed or stale), which replaces it.
 */
export function legacySignOffText(status: SignOffStatus, legacy: LegacySignOff | null | undefined) {
  if (status.status !== "none" || !legacy || !legacy.name.trim() || !legacy.at) return null;
  return `Signed off (earlier typed record): ${legacy.name.trim()}, ${legacy.at}, no signature or hash`;
}

/**
 * The current sign-off of each job, by job number, for the print views (they receive worksheets, not job ids). `null` while
 * loading. A job missing from the map is printed as not signed off.
 */
export function usePrintedSignOffs(jobNos: string[]): Map<string, PrintedSignOff> | null {
  const key = [...new Set(jobNos.filter(Boolean))].sort().join("\u0000");
  const [result, setResult] = useState<{ key: string; map: Map<string, PrintedSignOff> } | null>(null);
  useEffect(() => {
    let active = true;
    const numbers = key ? key.split("\u0000") : [];
    (async () => {
      const map = new Map<string, PrintedSignOff>();
      try {
        if (numbers.length && supabase) {
          const { data: jobs } = await supabase.from("jobs").select("id, job_no, worksheet_version").in("job_no", numbers);
          const ids = (jobs ?? []).map((job) => job.id as string);
          const { data: rows } = ids.length ? await supabase.from("job_signoffs").select(COLUMNS).in("job_id", ids) : { data: [] };
          for (const job of jobs ?? []) {
            const own = ((rows ?? []) as JobSignOff[]).filter((row) => row.job_id === job.id);
            map.set(job.job_no as string, { ...signOffStatus(own, job.worksheet_version as number), customer: customerSignOffs(own) });
          }
        }
      } catch {
        // Printed as not signed off: the sheet never claims a sign-off it couldn't read.
      }
      if (active) setResult({ key, map });
    })();
    return () => { active = false; };
  }, [key]);
  return result?.key === key ? result.map : null;
}

/** The company's "Customer sign-off on jobs" setting for print views: null while loading, false when off or unreadable (072). */
export function useCustomerSignOffSetting(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    customerSignOffEnabled().then((value) => { if (active) setOn(value); }, () => { if (active) setOn(false); });
    return () => { active = false; };
  }, []);
  return on;
}
