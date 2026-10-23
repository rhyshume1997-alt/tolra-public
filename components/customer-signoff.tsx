"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SignatureImage, SignaturePad, type Signature } from "@/components/signature-pad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadCompanyPeople } from "@/lib/company-people";
import { friendlyError } from "@/lib/friendly-error";
import {
  CUSTOMER_SIGNOFF_STATEMENT, type JobSignOff as SignOffRow, type PendingSignOff, type SignOffRevision, customerLine, customerSignOffEnabled, customerSignOffOp, customerSignOffs,
  formatSignedAt, formatSignedOn, getSignOffRevision, listSignOffs, pendingSignOffsFor, signOffJobCustomer,
} from "@/lib/job-signoff";
import type { CustomerSignOffOp } from "@/lib/offline/outbox";
import { loadOfflineSnapshot, queueOfflineWith, saveOfflineSnapshot } from "@/lib/offline/scope";
import { isNetworkError } from "@/lib/offline/store";
import { onSyncComplete, syncNow } from "@/lib/offline/sync";
import type { PeopleMap } from "@/lib/people";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const CUSTOMER_HINTS = new Set(["already_signed", "customer_signoff_off", "client_op_reused", "device_time_out_of_range"]);

/** The database's messages for people (bad input 22023, and the hinted refusals) are shown as they are. */
export function customerSignOffError(error: unknown) {
  const field = (key: string) => (typeof error === "object" && error && key in error ? String((error as Record<string, unknown>)[key] ?? "") : "");
  const message = field("message");
  return message && (field("code") === "22023" || CUSTOMER_HINTS.has(field("hint"))) ? message : friendlyError(error, "Couldn't save the customer's sign-off. Try again.");
}

/** What the device keeps for capturing offline: the setting, the customer sign-offs, and the revision last seen online. */
type CustomerCopy = { enabled: boolean; rows: SignOffRow[]; revision: SignOffRevision | null };

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

/** One recorded customer sign-off: who, the signature, the statement and comment, the phone's and the server's times, who captured it. */
export function CustomerSignOffRecord({ row, people, currentVersion }: { row: SignOffRow; people?: PeopleMap | null; currentVersion?: number | null }) {
  const capturer = people?.[row.signed_by] ?? null;
  const moved = row.shown_worksheet_version != null && row.shown_worksheet_version !== row.worksheet_version;
  return (
    <li className="grid gap-1 rounded border border-slate-300 p-2 text-xs" data-customer-signoff={row.id}>
      <p className="text-sm"><strong>{customerLine(row)}</strong> signed off this job.</p>
      {row.statement ? <p className="italic">&ldquo;{row.statement}&rdquo;</p> : null}
      <div>{row.signature_kind === "drawn" ? <SignatureImage path={row.signature_data} className="h-14 w-44" /> : <span className="font-serif text-lg italic">{row.signature_data}</span>}</div>
      {row.customer_comment ? <p className="whitespace-pre-wrap">Comment: {row.customer_comment}</p> : null}
      <p>Signed {formatSignedAt(row.device_signed_at) || formatSignedOn(row.signed_on)} (phone time); received {formatSignedAt(row.created_at)}.{capturer ? ` Captured by ${capturer}.` : ""}</p>
      <p className="text-slate-600">Revision {row.worksheet_version}{currentVersion != null && currentVersion !== row.worksheet_version ? ` (the worksheet is now revision ${currentVersion})` : ""}{moved ? `; the phone showed revision ${row.shown_worksheet_version} when the customer signed` : ""}.</p>
    </li>
  );
}

/**
 * Customer sign-off (migration 072): the fitter hands their phone to the customer, who prints their name (and optionally their position
 * and company), reads the statement, signs and may add a comment. Shown only when the company has "Customer sign-off on jobs" on (or
 * the job already has one), so companies without it see no change. Admin, office and workshop capture; a viewer sees the records only.
 * Works offline: the signature is kept on this device under its key and uploads once when the connection is back.
 */
export function CustomerSignOff({ jobId, jobNo = "", version, dirty = false, demo = false }: { jobId: string; jobNo?: string; version: number | null; dirty?: boolean; demo?: boolean }) {
  const { activeRole, user } = useUser();
  const online = useOnline();
  const canCapture = activeRole === "admin" || activeRole === "office" || activeRole === "workshop";
  const large = activeRole === "workshop";
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<SignOffRow[]>([]);
  const [revision, setRevision] = useState<SignOffRevision | null>(null);
  const [pending, setPending] = useState<PendingSignOff[]>([]);
  const [people, setPeople] = useState<PeopleMap | null>(null);
  const [fromDevice, setFromDevice] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");
  const [company, setCompany] = useState("");
  const [comment, setComment] = useState("");
  const [signature, setSignature] = useState<Signature | null>(null);
  const [padKey, setPadKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const loadDevice = useCallback(async () => {
    setPending((await pendingSignOffsFor(jobId)).filter((item) => item.op.role === "customer"));
  }, [jobId]);

  const load = useCallback(async () => {
    if (demo) return setLoaded(true);
    try {
      const [on, list] = await Promise.all([customerSignOffEnabled(), listSignOffs(jobId)]);
      const mine = customerSignOffs(list);
      // The revision on screen is recorded with the signature; a failure to read it never stops the customer signing.
      const current = on ? await getSignOffRevision(jobId).catch((error) => { if (isNetworkError(error)) throw error; return null; }) : null;
      setEnabled(on);
      setRows(mine);
      setRevision(current);
      setFromDevice(false);
      void saveOfflineSnapshot<CustomerCopy>(`customer-signoff:${jobId}`, { enabled: on, rows: mine, revision: current });
      void saveOfflineSnapshot<boolean>("customer-signoff-setting", on);
      if (mine.length) void loadCompanyPeople(supabase).then((map) => { if (map) setPeople(map); });
    } catch (error) {
      if (isNetworkError(error)) {
        const copy = await loadOfflineSnapshot<CustomerCopy>(`customer-signoff:${jobId}`);
        if (copy) {
          setEnabled(copy.data.enabled);
          setRows(copy.data.rows);
          setRevision(copy.data.revision);
        } else {
          // A job not opened online on this phone yet: the company's setting as last seen (no revision; the server binds it on upload).
          setEnabled((await loadOfflineSnapshot<boolean>("customer-signoff-setting"))?.data === true);
        }
        setFromDevice(true);
      }
    }
    await loadDevice();
    setLoaded(true);
  }, [jobId, demo, loadDevice]);
  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => onSyncComplete(() => { void load(); }), [load]);

  // Companies without the setting (and no record on this job) see nothing at all.
  if (!loaded || (!enabled && !rows.length && !pending.length)) return null;

  const signedThisRevision = version != null && rows.some((row) => row.worksheet_version === version);
  const waiting = pending.some((item) => item.status === "waiting");
  const showForm = enabled && canCapture && !signedThisRevision && !waiting;
  const shownSha = revision && version != null && revision.worksheet_version === version ? revision.snapshot_sha256 : null;
  const blocked = dirty ? "Save the worksheet before the customer signs." : null;
  const ready = !blocked && name.trim() !== "" && !name.includes("@") && Boolean(signature);

  async function keepOnDevice(op: CustomerSignOffOp) {
    await queueOfflineWith(op, {});
    toast.success("Customer's signature kept on this device: pending upload. It uploads when you're back online.");
  }

  async function submit() {
    if (!ready || !signature) return;
    if (!user?.id) return void toast.error("Sign in again to capture the customer's signature.");
    setBusy(true);
    // The phone's time now, and one key for this signature: an upload later, or a retry, is a replay of the same record.
    const op = customerSignOffOp({ jobId, jobNo, signerName: name, position, company, comment, kind: signature.kind, data: signature.data, shownVersion: version, shownSha256: shownSha }, user.id);
    try {
      if (!online || fromDevice) {
        await keepOnDevice(op);
      } else {
        try {
          await signOffJobCustomer(op);
          toast.success("Customer's sign-off saved");
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          await keepOnDevice(op);
        }
      }
      setName("");
      setPosition("");
      setCompany("");
      setComment("");
      setSignature(null);
      setPadKey((key) => key + 1);
      await load();
      if (online) void syncNow();
    } catch (error) {
      toast.error(customerSignOffError(error));
    } finally {
      setBusy(false);
    }
  }

  const target = large ? "min-h-12 text-base" : "min-h-11";
  return (
    <div className="border border-black" data-customer-signoff-section>
      <p className="bg-[#b5dca0] px-2 py-1 text-center text-[11px] font-bold uppercase">Customer sign off</p>
      <section aria-label="Customer sign-off" className="grid gap-3 border-t border-black p-2">
        {rows.length ? (
          <ul className="grid gap-2" aria-label="Customer sign-offs">
            {rows.map((row) => <CustomerSignOffRecord key={row.id} row={row} people={people} currentVersion={version} />)}
          </ul>
        ) : <p className="text-sm" data-customer-signoff-status="none">Not signed off by the customer yet.</p>}

        {pending.length ? (
          <ul className="grid gap-1 text-xs" aria-label="Customer signatures on this device">
            {pending.map((item) => (
              <li key={item.id} className={`flex flex-wrap items-center gap-2 rounded border p-1 ${item.status === "waiting" ? "border-amber-300 bg-amber-50" : "border-red-300 bg-red-50"}`} data-customer-signoff-pending={item.status}>
                {item.op.signatureKind === "drawn" ? <SignatureImage path={item.op.signatureData} className="h-8 w-24" /> : <span className="font-serif italic">{item.op.signatureData}</span>}
                <span>{item.op.signerName}{item.op.role === "customer" ? `, ${formatSignedAt(item.op.customer.deviceSignedAt)}` : ""}</span>
                {item.status === "waiting"
                  ? <strong className="text-amber-900">Pending upload</strong>
                  : <strong className="text-red-800">Not uploaded: {item.reason ?? "refused"} See the offline notice above to retry or dismiss it.</strong>}
              </li>
            ))}
          </ul>
        ) : null}

        {showForm ? (
          <div className="grid gap-2" data-customer-signoff-form>
            <p className="text-xs text-slate-600">Hand the phone to the customer to complete.</p>
            <label className="grid gap-1 text-xs font-bold uppercase">Customer name (capitals)
              <Input aria-label="Customer name" value={name} maxLength={200} autoComplete="off" className={target} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-bold uppercase">Position (optional)
                <Input aria-label="Customer position" value={position} maxLength={120} autoComplete="off" className={target} onChange={(event) => setPosition(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs font-bold uppercase">Company (optional)
                <Input aria-label="Customer company" value={company} maxLength={200} autoComplete="off" className={target} onChange={(event) => setCompany(event.target.value)} />
              </label>
            </div>
            <p className="rounded border border-slate-400 bg-slate-50 p-2 text-sm font-medium" data-customer-signoff-statement>{CUSTOMER_SIGNOFF_STATEMENT}</p>
            <SignaturePad key={padKey} onChange={setSignature} typedDefault={name} large={large} disabled={busy} />
            <label className="grid gap-1 text-xs font-bold uppercase">Comment (optional)
              <textarea aria-label="Customer comment" value={comment} maxLength={1000} rows={2} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm normal-case" onChange={(event) => setComment(event.target.value)} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" className={target} disabled={!ready || busy} onClick={submit}>{busy ? "Saving..." : "Save customer sign-off"}</Button>
              {!blocked && (!online || fromDevice) ? <span className="text-xs text-amber-900" role="status" data-customer-signoff-offline>Offline: the signature is kept on this phone and uploads when you&apos;re back online.</span> : null}
              {blocked ? <span className="text-xs text-slate-600" role="status">{blocked}</span> : null}
            </div>
            <p className="text-xs text-slate-600">Photos of the finished work go in this job&apos;s Photos.</p>
          </div>
        ) : null}
        {enabled && !canCapture && !rows.length ? <p className="text-xs text-slate-600">Admin, office or workshop capture the customer&apos;s sign-off.</p> : null}
      </section>
    </div>
  );
}
