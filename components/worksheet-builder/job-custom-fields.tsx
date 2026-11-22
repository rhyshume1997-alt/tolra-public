"use client";

/**
 * Module K (worksheet builder): the per-job entry of a company's custom worksheet fields (custom tick boxes, custom text fields and extra
 * checklist items of the company's own layout), shown on the job worksheet.
 *
 * Inputs: the job row already loaded by the worksheet (worksheet_custom), the worksheet version, and whether the person can edit it.
 * Outputs: a save of jobs.worksheet_custom only (lib/worksheet-builder/custom-values). Renders nothing unless the builder is on and the
 * company's layout has custom fields, so a company that does not use the builder sees no change. Read-only once the job's current revision
 * is signed off (the database refuses the change too, release 170).
 * Must not change: it writes no other column; the worksheet's own Save, checklist, version and sign-off are untouched.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/friendly-error";
import { CHECKLIST_ITEMS } from "@/lib/job-worksheet";
import { listSignOffs, signOffStatus } from "@/lib/job-signoff";
import { MAX_CUSTOM_TEXT, type CustomValues, CustomValuesUnavailableError, canEditCustomValues, parseCustomValues, saveCustomValues } from "@/lib/worksheet-builder/custom-values";
import { type WorksheetLayout, liveLayouts } from "@/lib/worksheet-builder/layouts";
import { useWorksheetBuilder } from "@/lib/worksheet-builder/store";

export type CustomField = { kind: "tick" | "text"; key: string; label: string };

const STANDARD_KEYS: ReadonlySet<string> = new Set(CHECKLIST_ITEMS.map((item) => item.key));

/** The fields of a layout that are filled in per job: visible custom ticks and texts, and checklist items that are not the six standard ones. */
export function customFieldsOf(layout: WorksheetLayout | undefined): CustomField[] {
  if (!layout) return [];
  const fields: CustomField[] = [];
  for (const block of layout.blocks) {
    if (!block.visible) continue;
    if (block.kind === "customTick") fields.push({ kind: "tick", key: block.id, label: block.label || "Tick" });
    if (block.kind === "customText") fields.push({ kind: "text", key: block.id, label: block.label || "Field" });
    if (block.kind === "checklist") for (const item of block.items ?? []) if (!STANDARD_KEYS.has(item.key)) fields.push({ kind: "tick", key: item.key, label: item.label });
  }
  return fields;
}

export function JobCustomFields({ jobId, row, version, canEditWorksheet, demo }: { jobId: string; row: Record<string, unknown> | undefined; version: number | null; canEditWorksheet: boolean; demo: boolean }) {
  const builder = useWorksheetBuilder();
  const layout = builder?.enabled ? liveLayouts(builder.state).find((l) => l.id === builder.state.activeId) : undefined;
  const fields = useMemo(() => customFieldsOf(layout), [layout]);
  const stored = useMemo(() => parseCustomValues(row?.worksheet_custom), [row]);
  const [values, setValues] = useState<CustomValues>(stored);
  const [saved, setSaved] = useState<CustomValues>(stored);
  const [signed, setSigned] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValues(stored); setSaved(stored); }, [stored]);
  useEffect(() => {
    if (demo || !fields.length) return;
    let active = true;
    listSignOffs(jobId).then((rows) => { if (active) setSigned(signOffStatus(rows, version).status === "signed"); }, () => { if (active) setSigned(true); });
    return () => { active = false; };
  }, [jobId, version, demo, fields.length]);
  if (!fields.length) return null;

  const editable = !demo && signed === false && canEditCustomValues({ canEditWorksheet, signedOff: false });
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  async function save() {
    setSaving(true);
    try {
      await saveCustomValues(jobId, values);
      setSaved(values);
      toast.success("Custom fields saved");
    } catch (err) {
      toast.error(err instanceof CustomValuesUnavailableError ? err.message : friendlyError(err, "Couldn't save the custom fields."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 border border-black p-2 text-[12px]" data-testid="job-custom-fields">
      <p className="text-[11px] font-bold uppercase">{layout?.name ?? "Custom"} fields</p>
      {signed === true ? <p className="text-[11px] text-slate-600">This worksheet is signed off, so these fields can no longer be changed.</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => field.kind === "tick" ? (
          <label key={field.key} className="flex items-center gap-2"><input type="checkbox" className="size-4" disabled={!editable} checked={values.ticks[field.key] === true} onChange={(event) => setValues((current) => ({ ...current, ticks: { ...current.ticks, [field.key]: event.target.checked } }))} />{field.label}</label>
        ) : (
          <label key={field.key} className="flex items-center gap-2"><span className="shrink-0">{field.label}:</span>
            <input className="h-8 min-w-0 flex-1 border-b border-black bg-transparent px-1" maxLength={MAX_CUSTOM_TEXT} readOnly={!editable} value={values.texts[field.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, texts: { ...current.texts, [field.key]: event.target.value } }))} />
          </label>
        ))}
      </div>
      {editable ? <div className="flex justify-end"><Button type="button" variant="outline" size="sm" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving..." : "Save custom fields"}</Button></div> : null}
    </div>
  );
}
