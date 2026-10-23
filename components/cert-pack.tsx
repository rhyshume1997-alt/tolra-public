"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { auditEvent } from "@/lib/audit";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { type CertFile, attachCert, loadCertPack, removeCert } from "@/lib/job-files";
import { drawingUrl } from "@/lib/job-worksheet";

/** The job's material certificates (its cert pack), listed on the delivery note screen. The delivery note itself is unchanged. */
export function CertPack({ jobNo, canRemove }: { jobNo: string; canRemove: boolean }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [certs, setCerts] = useState<CertFile[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  /** The certificate waiting for "are you sure?" before it is removed from the pack. */
  const [removing, setRemoving] = useState<CertFile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const pack = await loadCertPack(jobNo);
      setJobId(pack.jobId);
      setCerts(pack.certs);
      setState("ready");
    } catch (error) {
      console.error(error);
      setState("error");
    }
  }, [jobNo]);
  useEffect(() => { void load(); }, [load]);

  async function onFile(files: FileList | null) {
    const file = files?.[0];
    if (!file || !jobId) return;
    setBusy(true);
    try {
      const added = await attachCert(jobId, file, ref);
      setCerts((current) => [...current, added]);
      setRef("");
      void auditEvent({ action: "UPLOAD_ATTACHMENT", entityTable: "jobs", entityId: jobId, metadata: { file: added.file_name, kind: "cert" } });
      toast.success(`${added.file_name} added to the cert pack`);
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't add the certificate."));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function open(cert: CertFile) {
    try {
      window.open(await drawingUrl(cert.storage_path, cert.file_name), "_blank", "noopener");
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't open the certificate."));
    }
  }

  async function remove(cert: CertFile) {
    setRemoving(null);
    setBusy(true);
    try {
      await removeCert(cert.id);
      setCerts((current) => current.filter((item) => item.id !== cert.id));
      toast.success(`${cert.file_name} removed from the cert pack`);
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't remove the certificate."));
    } finally {
      setBusy(false);
    }
  }

  if (!jobNo.trim()) return <p className="text-xs text-slate-500">Cert pack: link this delivery note to a job to list its material certificates.</p>;
  return (
    <section aria-label="Cert pack" className="space-y-2 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Cert pack: {jobNo}</h3>
      {state === "loading" ? <p className="text-xs text-slate-500">Loading…</p> : null}
      {state === "error" ? <p role="alert" className="text-xs text-red-700">Couldn&apos;t load the cert pack. <button type="button" className="underline" onClick={() => void load()}>Retry</button></p> : null}
      {state === "ready" && !jobId ? <p className="text-xs text-slate-500">No job {jobNo} was found, so there is no cert pack to show.</p> : null}
      {state === "ready" && jobId ? (
        <>
          {certs.length ? (
            <ul className="divide-y rounded-lg border text-xs" aria-label="Certificates">
              {certs.map((cert) => (
                <li key={cert.id} className="flex flex-wrap items-center gap-2 p-2">
                  <span className="font-medium">{cert.ref}</span>
                  <span className="truncate text-slate-500">{cert.file_name}, added {fmtDate(cert.created_at)}</span>
                  <span className="ml-auto flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void open(cert)}><Download className="size-4" /> Open</Button>
                    {canRemove ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(cert)}>Remove</Button> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-slate-500">No certificates attached to this job yet.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Certificate number or heat number" className="h-8 max-w-56 text-xs" maxLength={200} placeholder="Cert or heat number (optional)" value={ref} onChange={(event) => setRef(event.target.value)} />
            <input ref={fileRef} type="file" aria-label="Certificate file" className="hidden" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => void onFile(event.target.files)} />
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Attach certificate</Button>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${removing?.file_name ?? "this certificate"} from the cert pack?`}
        description={`It will no longer be listed for job ${jobNo}. The delivery note itself is unchanged.`}
        confirmLabel="Remove certificate"
        cancelLabel="Keep certificate"
        destructive
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </section>
  );
}
