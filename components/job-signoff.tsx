"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SignatureImage, SignaturePad, type Signature } from "@/components/signature-pad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import {
  type JobSignOff as SignOffRow, type LegacySignOff, type PendingSignOff, type SignOffKind, type SignOffRevision, expectedSnapshotSha, formatSignedOn, getSignOffRevision, hashPrefix, initialsFrom, kindLabel,
  legacySignOffText, listSignOffs, openCosignRoles, pendingSignOffsFor, signOffJob, signOffOp, signOffStatus, signOffsByRevision, todayInLondon, validInitials,
} from "@/lib/job-signoff";
import { newPhotoId, pendingEntries } from "@/lib/offline/outbox";
import { loadOfflineSnapshot, offlineScope, queueOfflineWith, saveOfflineSnapshot } from "@/lib/offline/scope";
import { isNetworkError } from "@/lib/offline/store";
import { onSyncComplete, syncNow } from "@/lib/offline/sync";
import { useUser } from "@/lib/use-user";

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

const SIGNOFF_HINTS = new Set(["already_signed", "needs_primary", "same_signer", "not_inspector", "stale_revision", "client_op_reused"]);

/**
 * Messages the database writes for people (bad input, an unfinished job, and a stale revision: "The worksheet changed since you
 * opened it: reload and check before signing", SQLSTATE 22023 as record_job_inspection reports one; and the one-signature rules,
 * marked by their hint: already_signed 23505, needs_primary / same_signer 22023, not_inspector 42501) are shown as they are.
 */
export function signOffError(error: unknown) {
  const field = (key: string) => (typeof error === "object" && error && key in error ? String((error as Record<string, unknown>)[key] ?? "") : "");
  const message = field("message");
  return message && (field("code") === "22023" || SIGNOFF_HINTS.has(field("hint"))) ? message : friendlyError(error, "Couldn't sign off. Try again.");
}

/** What this panel keeps on the device for signing offline: the history and the revision (version + snapshot hash) last seen online. */
type SignOffCopy = { rows: SignOffRow[]; revision: SignOffRevision | null };

/**
 * Operator sign-off (M4): initials, name, date and a drawn or typed signature, against the worksheet's current revision. The
 * server snapshots and hashes the worksheet and checks it is the revision signed. Admin, office and workshop sign; a viewer sees the
 * history only. Offline the signature is kept on this device ("Pending upload") and uploaded when the connection is back; it stays
 * bound to the person who signed and the revision they saw. `legacy` is the old typed box (signed_off_by / signed_off_at): shown as an
 * earlier typed record until a hashed sign-off exists.
 */
export function JobSignOff({ jobId, jobNo = "", version, dirty = false, demo = false, legacy = null, onSigned }: { jobId: string; jobNo?: string; version: number | null; dirty?: boolean; demo?: boolean; legacy?: LegacySignOff | null; onSigned?: () => void }) {
  const { activeRole, profile, user } = useUser();
  const online = useOnline();
  const canSign = activeRole === "admin" || activeRole === "office" || activeRole === "workshop";
  const large = activeRole === "workshop";
  const [rows, setRows] = useState<SignOffRow[]>([]);
  const [revision, setRevision] = useState<SignOffRevision | null>(null);
  const [pending, setPending] = useState<PendingSignOff[]>([]);
  const [worksheetWaiting, setWorksheetWaiting] = useState(false);
  const [fromDevice, setFromDevice] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [initials, setInitials] = useState("");
  const [name, setName] = useState("");
  const [signedOn, setSignedOn] = useState(todayInLondon());
  const [signature, setSignature] = useState<Signature | null>(null);
  const [padKey, setPadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const fullName = (profile as { full_name?: string | null } | null)?.full_name ?? "";
  useEffect(() => {
    setName((current) => current || (fullName.includes("@") ? "" : fullName));
    setInitials((current) => current || initialsFrom(fullName.includes("@") ? "" : fullName));
  }, [fullName]);

  const loadDevice = useCallback(async () => {
    // A customer's signature waiting on the device belongs to the customer sign-off (072), not this panel.
    setPending((await pendingSignOffsFor(jobId)).filter((item) => item.op.role !== "customer"));
    const scope = offlineScope();
    setWorksheetWaiting(scope ? (await pendingEntries(scope)).some((entry) => entry.op.kind === "worksheet" && entry.op.jobId === jobId) : false);
  }, [jobId]);

  const load = useCallback(async () => {
    if (demo) return setLoaded(true);
    try {
      const [list, current] = await Promise.all([listSignOffs(jobId), getSignOffRevision(jobId)]);
      setRows(list);
      setRevision(current);
      setFromDevice(false);
      void saveOfflineSnapshot<SignOffCopy>(`signoff:${jobId}`, { rows: list, revision: current });
    } catch (error) {
      // Offline: this device's copy from the last load (history, and the revision signed against). Signing still works offline.
      if (isNetworkError(error)) {
        const copy = await loadOfflineSnapshot<SignOffCopy>(`signoff:${jobId}`);
        if (copy) {
          setRows(copy.data.rows);
          setRevision(copy.data.revision);
          setFromDevice(true);
        }
      }
    }
    await loadDevice();
    setLoaded(true);
  }, [jobId, demo, loadDevice]);
  // Again when the revision on screen changes (a save makes a new one) and after every sync pass (a queued signature uploaded).
  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => onSyncComplete(() => { void load(); }), [load]);

  const state = signOffStatus(rows, version);
  // One primary sign-off per revision; once it exists, the form becomes the co-signature (the first open role, today the inspector).
  const cosignRole = openCosignRoles(state)[0] ?? null;
  const ownPrimary = state.status === "signed" && Boolean(user?.id) && state.latest.signed_by === user?.id;
  const role: SignOffKind = state.status === "signed" && cosignRole ? cosignRole : "primary";
  // A signature of this revision and role already waiting on the device: not captured twice.
  const waitingHere = pending.some((item) => item.status === "waiting" && item.op.expectedVersion === version && item.op.role === role);
  const showForm = canSign && !waitingHere && (state.status !== "signed" || (cosignRole !== null && !ownPrimary));
  const legacyText = loaded ? legacySignOffText(state, legacy) : null;
  const expectedSha = expectedSnapshotSha(state, revision, version, role);
  const blocked = dirty ? "Save the worksheet before signing off."
    : version == null ? "Loading the worksheet..."
    : worksheetWaiting ? "This worksheet has changes waiting to upload: sign once they have synced."
    : !expectedSha ? (online && !fromDevice ? "Loading the revision..." : "Open this job online once on this revision before signing it offline.")
    : null;
  const ready = !blocked && validInitials(initials) && name.trim() !== "" && !name.includes("@") && /^\d{4}-\d{2}-\d{2}$/.test(signedOn) && Boolean(signature);

  /** Keeps the signature on this device (bound to the signer and the revision); it uploads when the connection is back. */
  async function keepOnDevice(input: Parameters<typeof signOffJob>[0]) {
    if (!user?.id) throw new Error("Sign in again to keep this signature on the device.");
    await queueOfflineWith(signOffOp(input, user.id), {});
    toast.success("Signed on this device: pending upload. It uploads when you're back online.");
  }

  async function submit() {
    if (!ready || version == null || !signature || !expectedSha) return;
    setBusy(true);
    const input = { jobId, jobNo, expectedVersion: version, expectedSha256: expectedSha, initials, signerName: name, signedOn, kind: signature.kind, data: signature.data, role, clientOpId: newPhotoId() };
    try {
      if (!online || fromDevice) {
        await keepOnDevice(input);
      } else {
        try {
          await signOffJob(input);
          toast.success(role !== "primary" ? `Added the ${role} co-signature to revision ${version}` : `Signed off revision ${version}`);
        } catch (error) {
          // The connection dropped (the answer may be lost): kept on the device under the same key, so the upload can't make a second record.
          if (!isNetworkError(error)) throw error;
          await keepOnDevice(input);
        }
      }
      setSignature(null);
      setPadKey((key) => key + 1);
      await load();
      onSigned?.();
      if (online) void syncNow();
    } catch (error) {
      toast.error(signOffError(error));
    } finally {
      setBusy(false);
    }
  }

  const target = large ? "min-h-12" : "min-h-11";
  return (
    <section aria-label="Operator sign-off" className="grid gap-3 p-2" data-signoff-section>
      <p className="text-sm" data-signoff-status={loaded ? (legacyText ? "legacy" : state.status) : "loading"}>
        {state.status === "signed" ? (
          <>Signed off on revision {state.latest.worksheet_version} by <strong>{state.latest.initials}</strong> ({state.latest.signer_name}) on {formatSignedOn(state.latest.signed_on)}. <span className="font-mono text-xs">sha256 {hashPrefix(state.latest.snapshot_sha256)}</span>
            {state.cosigns.map((row) => (
              <span key={row.id} className="block" data-signoff-cosign={row.kind}>{kindLabel(row.kind)} co-signed by <strong>{row.initials}</strong> ({row.signer_name}) on {formatSignedOn(row.signed_on)}.</span>
            ))}</>
        ) : state.status === "stale" ? (
          <strong className="text-amber-800">Signed off on revision {state.latest.worksheet_version} by {state.latest.initials} on {formatSignedOn(state.latest.signed_on)}; edited since (now revision {state.currentVersion}): sign again.</strong>
        ) : legacyText ? (
          <span className="text-slate-700">{legacyText}</span>
        ) : loaded ? "Not signed off" : " "}
      </p>

      {canSign && ownPrimary && cosignRole ? <p className="text-xs text-slate-600" data-signoff-cosign-own>You signed this revision; the {cosignRole} co-signature is added by someone else.</p> : null}
      {showForm ? (
        <div className="grid gap-2" data-signoff-form={state.status === "signed" ? cosignRole : "primary"}>
          {state.status === "signed" && cosignRole ? <p className="text-xs font-bold uppercase">Add co-signature ({cosignRole})</p> : null}
          <div className="grid gap-2 sm:grid-cols-[6rem_1fr_11rem]">
            <label className="grid gap-1 text-xs font-bold uppercase">Initials
              <Input aria-label="Initials" value={initials} maxLength={4} className={target} onChange={(event) => setInitials(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
            </label>
            <label className="grid gap-1 text-xs font-bold uppercase">Name
              <Input aria-label="Signer name" value={name} maxLength={200} className={target} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="grid gap-1 text-xs font-bold uppercase">Date
              <Input aria-label="Sign-off date" type="date" value={signedOn} max={todayInLondon()} className={target} onChange={(event) => setSignedOn(event.target.value)} />
            </label>
          </div>
          <SignaturePad key={padKey} onChange={setSignature} typedDefault={name} large={large} disabled={busy} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" className={target} disabled={!ready || busy} onClick={submit}>{busy ? "Signing..." : state.status === "signed" && cosignRole ? `Add co-signature (${cosignRole})` : "Sign off"}</Button>
            {!blocked && (!online || fromDevice) ? <span className="text-xs text-amber-900" role="status" data-signoff-offline>Offline: the signature is kept on this device and uploads when you&apos;re back online.</span> : null}
            {blocked ? <span className="text-xs text-slate-600" role="status">{blocked}</span> : null}
          </div>
        </div>
      ) : null}

      {pending.length ? (
        <ul className="grid gap-1 text-xs" aria-label="Signatures on this device">
          {pending.map((item) => (
            <li key={item.id} className={`flex flex-wrap items-center gap-2 rounded-none border p-1 ${item.status === "waiting" ? "border-amber-300 bg-amber-50" : "border-red-300 bg-red-50"}`} data-signoff-pending={item.status}>
              {item.op.signatureKind === "drawn" ? <SignatureImage path={item.op.signatureData} className="h-8 w-24" /> : <span className="font-serif italic">{item.op.signatureData}</span>}
              <span>{item.op.role !== "primary" ? `${kindLabel(item.op.role)} co-signature: ` : ""}{item.op.initials} ({item.op.signerName}), {formatSignedOn(item.op.signedOn)}, revision {item.op.expectedVersion}</span>
              {item.status === "waiting"
                ? <strong className="text-amber-900">Pending upload</strong>
                : <strong className="text-red-800">Not uploaded: {item.reason ?? "refused"} See the offline notice above to retry or dismiss it.</strong>}
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length ? (
        <div className="grid gap-1" aria-label="Sign-off history">
          <p className="text-xs font-bold uppercase">Sign-off history</p>
          <ul className="grid gap-1 text-xs">
            {signOffsByRevision(rows).map((group) => (
              <li key={group.version} data-signoff-revision={group.version}>
                <span className="font-bold">Revision {group.version}{group.version === version ? " (current)" : ""}:</span>
                <ul className="ml-3 grid gap-1">
                  {group.rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-2">
                      {row.signature_kind === "drawn" ? <SignatureImage path={row.signature_data} className="h-8 w-24" /> : <span className="font-serif italic">{row.signature_data}</span>}
                      <span>{row.kind && row.kind !== "primary" ? `${kindLabel(row.kind)} co-signature: ` : ""}{row.initials} ({row.signer_name}), {formatSignedOn(row.signed_on)}</span>
                      <span className="font-mono" title={row.snapshot_sha256}>sha256 {hashPrefix(row.snapshot_sha256)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
