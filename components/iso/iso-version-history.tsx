"use client";

/**
 * BOUNDARY (module 9, ISO templates). Inputs: the saved versions of ONE document (metadata, newest first), the table lookup, and callbacks. Output: the history list
 * (version, status, who, when, note), a read-only view of one version, "Restore as new version" and "Approve". Must not change: it never edits or deletes a version;
 * restore and approve only call the callbacks (the page saves a NEW version or approves a draft through lib/iso/iso-document-versions.ts); an approved version is shown locked.
 */
import { useState } from "react";

import { IsoBodyReadOnly } from "@/components/iso/iso-section-fields";
import { Button, Callout, EmptyState, FailedState, List, ListRow, LoadingState, Panel, StatusBadge } from "@/components/ui/premium";
import { fmtDateTime } from "@/lib/dates";
import { isLocked, type IsoVersion, type IsoVersionMeta } from "@/lib/iso/editable-document";
import { loadIsoVersion } from "@/lib/iso/iso-document-versions";

function describe(v: IsoVersionMeta): string {
  const parts = [`Saved by ${v.created_by_name} on ${fmtDateTime(v.created_at)}`];
  if (v.restored_from) parts.push(`restored from version ${v.restored_from}`);
  if (v.change_note) parts.push(`Note: ${v.change_note}`);
  if (v.status === "approved") parts.push(`Approved by ${v.approved_by_name ?? "unknown"} on ${v.approved_at ? fmtDateTime(v.approved_at) : "unknown date"}`);
  return parts.join(". ");
}

export function IsoVersionHistory({ docTitle, versions, tables, busy, onRestore, onApprove }: {
  docTitle: string;
  versions: IsoVersionMeta[];
  tables: (heading: string) => boolean;
  busy: boolean;
  onRestore: (version: IsoVersion) => void;
  onApprove: (version: IsoVersionMeta) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [state, setState] = useState<{ status: "idle" | "loading" | "failed" | "ready"; version?: IsoVersion }>({ status: "idle" });

  async function view(v: IsoVersionMeta) {
    setOpen(v.version);
    setState({ status: "loading" });
    const result = await loadIsoVersion(v.doc_id, v.version);
    setState(result.ok ? { status: "ready", version: result.version } : { status: "failed" });
  }

  if (!versions.length) return <EmptyState compact headingLevel={3} title="No saved versions yet" detail={`Nothing has been saved for ${docTitle}. Save the first version from the Edit tab.`} />;
  const meta = versions.find((v) => v.version === open) ?? null;
  return (
    <div className="space-y-4" data-testid="iso-history">
      {meta ? (
        <Panel title={`Version ${meta.version}`} headingLevel={3} actions={<Button size="lg" variant="secondary" onClick={() => { setOpen(null); setState({ status: "idle" }); }}>Close</Button>}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{describe(meta)}</p>
            {isLocked(meta) ? <Callout tone="info" lead="Locked">This version is approved and cannot be edited. Restoring it saves a new version.</Callout> : null}
            {state.status === "loading" ? <LoadingState label="Loading this version" rows={3} /> : null}
            {state.status === "failed" ? <FailedState headingLevel={4} title="Couldn't load this version" detail="Nothing was changed." onRetry={() => void view(meta)} retryLabel="Try again" /> : null}
            {state.status === "ready" && state.version ? (
              <>
                <IsoBodyReadOnly body={state.version.body} hasTable={tables} />
                <div className="flex flex-wrap gap-3">
                  <Button size="lg" variant="primary" disabled={busy} onClick={() => onRestore(state.version!)}>Restore as new version</Button>
                  {meta.status === "draft" ? <Button size="lg" variant="secondary" disabled={busy} onClick={() => onApprove(meta)}>Approve this version</Button> : null}
                </div>
              </>
            ) : null}
          </div>
        </Panel>
      ) : null}
      <List label={`Saved versions of ${docTitle}`}>
        {versions.map((v) => (
          <ListRow key={v.id} data-testid={`iso-version-${v.version}`}
            title={<span className="flex flex-wrap items-center gap-2">{`Version ${v.version}`}<StatusBadge tone={v.status === "approved" ? "ok" : "neutral"}>{v.status === "approved" ? "Approved" : "Draft"}</StatusBadge></span>}
            meta={describe(v)}
            trailing={<Button size="lg" variant="secondary" aria-label={`View version ${v.version}`} aria-pressed={open === v.version} onClick={() => void view(v)}>View</Button>} />
        ))}
      </List>
    </div>
  );
}
