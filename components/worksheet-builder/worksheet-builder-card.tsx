"use client";

/**
 * Module K (worksheet builder): Settings > Worksheet builder (admins). An admin designs the company's own job worksheet from the fixed
 * palette of safe blocks (lib/worksheet-builder/blocks), with show or hide, reorder, renamed labels and a live preview on sample data.
 * Starts from Basic, from the JNR sheet or from blank. OFF by default (lib/worksheet-builder/switch: a marker in hidden_nav).
 *
 * Inputs: the company's builder state, switches and company profile (logo and brand colour are pulled automatically). Outputs: saves of
 * company_profile.worksheetBuilder and the hidden_nav switch only. Nothing here writes to any job.
 * Must not change: that locked blocks (requirements.ts) can be reordered and renamed but never hidden or deleted, and that Basic and JNR sheet
 * are not editable here (they stay exactly as they are, and stay the defaults).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, FileText, Plus, Trash2 } from "lucide-react";

import { WorksheetSheet } from "@/components/worksheet-builder/custom-worksheet-sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auditEvent } from "@/lib/audit";
import { useCompanyProfile } from "@/lib/company";
import { friendlyError } from "@/lib/friendly-error";
import { getOrgSettingsSnapshot, saveOrgSettings, useOrgSettings } from "@/lib/org-settings";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useUser } from "@/lib/use-user";
import { BLOCK_FIELDS, BLOCK_KINDS, MAX_CHECKLIST_ITEMS, MAX_FREE_TEXT, MAX_LABEL, MAX_LAYOUT_NAME, PALETTE, type BlockKind, type WorksheetBlock } from "@/lib/worksheet-builder/blocks";
import { type LayoutBase, type WorksheetLayout, addBlock, archiveLayout, liveLayouts, moveBlock, newLayout, randomId, removeBlock, updateBlock, upsertLayout } from "@/lib/worksheet-builder/layouts";
import { type CompanyRequirements, isLockedBlock, lockedBlockProblems } from "@/lib/worksheet-builder/requirements";
import { SAMPLE_DRAWINGS, SAMPLE_WORKSHEET } from "@/lib/worksheet-builder/sample";
import { EMPTY_CUSTOM_VALUES } from "@/lib/worksheet-builder/custom-values";
import { type BuilderConfig, announceBuilderChanged, loadWorksheetBuilderStrict, updateWorksheetBuilderState } from "@/lib/worksheet-builder/store";
import { applyHiddenNavChange, worksheetBuilderEnabled, worksheetBuilderSwitchChange } from "@/lib/worksheet-builder/switch";

const input = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const START_OPTIONS: { value: LayoutBase; label: string }[] = [{ value: "basic", label: "Basic" }, { value: "jnr", label: "JNR sheet" }, { value: "blank", label: "Blank" }];

function Preview({ layout, requirements }: { layout: WorksheetLayout; requirements: CompanyRequirements }) {
  const { profile: company } = useCompanyProfile();
  return (
    <div className="overflow-auto rounded-lg border bg-slate-100 p-2" data-testid="worksheet-preview">
      <p className="pb-1 text-xs text-slate-500">Live preview on sample data{company ? "" : " (company details not set up yet)"}. Your logo and brand colour are used automatically.</p>
      <div style={{ zoom: 0.55 }}>
        <WorksheetSheet layout={layout} data={{ worksheet: SAMPLE_WORKSHEET, jobNo: SAMPLE_WORKSHEET.job_no, drawings: SAMPLE_DRAWINGS, customerPos: [], traceable: true, custom: EMPTY_CUSTOM_VALUES, inspection: null }} env={{ company, signOff: null, customerOn: requirements.customerSignOff, requirements }} />
      </div>
    </div>
  );
}

function BlockRow({ block, index, count, locked, onChange, onMove, onRemove }: { block: WorksheetBlock; index: number; count: number; locked: boolean; onChange: (patch: Partial<WorksheetBlock>) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void }) {
  const fields = BLOCK_FIELDS[block.kind] ?? [];
  const items = block.items ?? [];
  return (
    <li className="space-y-2 rounded-lg border p-2" data-testid={`block-${block.id}`} data-locked={locked ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${PALETTE[block.kind].title} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="size-4" /></Button>
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${PALETTE[block.kind].title} down`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="size-4" /></Button>
        </div>
        <span className="min-w-0 flex-1 font-medium text-slate-800">{PALETTE[block.kind].title}{locked ? <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs font-normal text-slate-700">Required</span> : null}</span>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={block.visible} disabled={locked} aria-label={`Show ${PALETTE[block.kind].title}`} onChange={(event) => onChange({ visible: event.target.checked })} /> Show
        </label>
        <Button type="button" variant="outline" size="icon" aria-label={`Remove ${PALETTE[block.kind].title}`} disabled={locked} onClick={onRemove}><Trash2 className="size-4" /></Button>
      </div>
      <label className="block text-xs text-slate-600">{block.kind === "header" ? "Sheet title" : "Label"}
        <input className={input} maxLength={MAX_LABEL} value={block.label} aria-label={`${PALETTE[block.kind].title} label`} onChange={(event) => onChange({ label: event.target.value })} />
      </label>
      {fields.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.key} className="block text-xs text-slate-600">{field.label}
              <input className={input} maxLength={MAX_LABEL} placeholder={field.label} value={block.fieldLabels?.[field.key] ?? ""} aria-label={`${PALETTE[block.kind].title}: label for ${field.label}`}
                onChange={(event) => onChange({ fieldLabels: { ...block.fieldLabels, [field.key]: event.target.value } })} />
            </label>
          ))}
        </div>
      ) : null}
      {block.kind === "freeText" ? (
        <label className="block text-xs text-slate-600">Text
          <textarea className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm" maxLength={MAX_FREE_TEXT} value={block.text ?? ""} aria-label="Free text" onChange={(event) => onChange({ text: event.target.value })} />
        </label>
      ) : null}
      {block.kind === "materialTrace" ? (
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={block.traceableOnly === true} onChange={(event) => onChange({ traceableOnly: event.target.checked })} /> Print only on traceable jobs (a traceable job always prints the numbers)</label>
      ) : null}
      {block.kind === "checklist" ? (
        <div className="space-y-1">
          <p className="text-xs text-slate-600">Checklist items. The first six standard items follow the job&apos;s own checklist; items you add are ticked per job on the worksheet.</p>
          {items.map((item, itemIndex) => (
            <div key={item.key} className="flex gap-2">
              <input className={input} maxLength={MAX_LABEL} value={item.label} aria-label={`Checklist item ${itemIndex + 1}`} onChange={(event) => onChange({ items: items.map((it) => (it.key === item.key ? { ...it, label: event.target.value } : it)) })} />
              <Button type="button" variant="outline" size="icon" aria-label={`Remove checklist item ${itemIndex + 1}`} onClick={() => onChange({ items: items.filter((it) => it.key !== item.key) })}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={items.length >= MAX_CHECKLIST_ITEMS} onClick={() => onChange({ items: [...items, { key: `c-${randomId().slice(0, 8)}`, label: "New item" }] })}><Plus className="size-4" /> Add checklist item</Button>
        </div>
      ) : null}
      {block.kind === "customTick" || block.kind === "customText" ? <p className="text-xs text-slate-500">Filled in per job on the job worksheet; never changes existing jobs.</p> : null}
    </li>
  );
}

function Editor({ initial, requirements, isNew, saving, onSave, onCancel }: { initial: WorksheetLayout; requirements: CompanyRequirements; isNew: boolean; saving: boolean; onSave: (layout: WorksheetLayout) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [add, setAdd] = useState<BlockKind>("freeText");
  const problems = [...(draft.name.trim() ? [] : ["Give the layout a name."]), ...lockedBlockProblems(draft, requirements)];
  const addable = BLOCK_KINDS.filter((kind) => PALETTE[kind].repeatable || !draft.blocks.some((block) => block.kind === kind && block.visible));
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="worksheet-editor">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block min-w-60 flex-1 text-xs text-slate-600">Layout name (shown in the Print layout list)
          <input className={input} maxLength={MAX_LAYOUT_NAME} value={draft.name} aria-label="Layout name" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" className="bg-[#1E3472] text-white" disabled={saving || problems.length > 0} onClick={() => onSave(draft)}>{isNew ? "Save layout" : "Save changes"}</Button>
        </div>
      </div>
      {problems.length ? <ul className="list-disc pl-5 text-xs text-red-700">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <ul className="space-y-2">
            {draft.blocks.map((block, index) => (
              <BlockRow key={block.id} block={block} index={index} count={draft.blocks.length} locked={isLockedBlock(block, requirements)}
                onChange={(patch) => setDraft((current) => updateBlock(current, block.id, patch))} onMove={(direction) => setDraft((current) => moveBlock(current, block.id, direction))} onRemove={() => setDraft((current) => removeBlock(current, block.id))} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label="Block to add" value={addable.includes(add) ? add : addable[0]} onChange={(event) => setAdd(event.target.value as BlockKind)}>
              {addable.map((kind) => <option key={kind} value={kind}>{PALETTE[kind].title}</option>)}
            </select>
            <Button type="button" variant="outline" onClick={() => setDraft((current) => addBlock(current, addable.includes(add) ? add : addable[0]))}><Plus className="size-4" /> Add block</Button>
          </div>
          <p className="text-xs text-slate-500">Blocks marked Required cannot be hidden or removed. They can be moved and renamed.</p>
        </div>
        <Preview layout={draft} requirements={requirements} />
      </div>
    </div>
  );
}

export function WorksheetBuilderCard() {
  const settings = useOrgSettings();
  const { activeRole } = useUser();
  const [config, setConfig] = useState<BuilderConfig | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ layout: WorksheetLayout; isNew: boolean } | null>(null);
  const [startName, setStartName] = useState("");
  const [startFrom, setStartFrom] = useState<LayoutBase>("basic");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const enabled = worksheetBuilderEnabled(settings.hiddenNav);

  const load = useCallback(() => {
    setLoadFailed(false);
    loadWorksheetBuilderStrict().then(setConfig, () => setLoadFailed(true));
  }, []);
  useEffect(() => { if (activeRole === "admin") load(); }, [activeRole, load]);
  if (activeRole !== "admin") return null;

  async function toggle(on: boolean) {
    setSaving(true);
    try {
      const before = getOrgSettingsSnapshot().hiddenNav;
      const result = await saveOrgSettings({ hiddenNav: applyHiddenNavChange(before, worksheetBuilderSwitchChange(on)) });
      if (result.dropped) return;
      if (result.denied) return void toast.error(result.message ?? "You can't change the worksheet builder.");
      if (result.localOnly) toast.message("Worksheet builder setting saved in this browser only (Supabase unavailable).");
      else toast.success(on ? "Worksheet builder is on" : "Worksheet builder is off");
      announceBuilderChanged();
      if (!result.localOnly) void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", oldData: { worksheetBuilder: !on }, newData: { worksheetBuilder: on }, metadata: { section: "worksheet_builder" } });
    } catch {
      toast.error("Couldn't save the worksheet builder setting.");
    } finally {
      setSaving(false);
    }
  }

  async function change(label: string, mutate: Parameters<typeof updateWorksheetBuilderState>[1], audit: Record<string, unknown>) {
    setSaving(true);
    try {
      const state = await updateWorksheetBuilderState(await getCurrentOrganizationId(), mutate);
      setConfig((current) => (current ? { ...current, state } : current));
      announceBuilderChanged();
      void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", oldData: null, newData: audit, metadata: { section: "worksheet_builder" } });
      toast.success(label);
      return true;
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the worksheet layout."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  const layouts = config ? liveLayouts(config.state) : [];
  const requirements = config?.requirements ?? { customerSignOff: true };

  return (
    <Card data-testid="worksheet-builder-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="size-5 text-brand-accent" /> Worksheet builder</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">Design your own job worksheet from a fixed set of blocks: show or hide, reorder and rename them. Your layout is listed next to Basic and JNR sheet in Print layout. Basic and JNR sheet are not changed and stay the defaults. It is off until you switch it on.</p>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span className="font-medium text-slate-800">Use my own worksheet layouts</span>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Use my own worksheet layouts" disabled={saving} onClick={() => void toggle(!enabled)} className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-none transition disabled:cursor-not-allowed disabled:opacity-60 ${enabled ? "bg-brand" : "bg-slate-300"}`}>
            <span className={`inline-block size-5 rounded-none bg-white shadow transition ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        {!enabled ? null : loadFailed ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-red-800"><span>Couldn&apos;t load your worksheet layouts.</span><Button variant="outline" onClick={load}>Retry</Button></div>
        ) : !config ? <p className="text-slate-500">Loading…</p> : editing ? (
          <Editor key={editing.layout.id} initial={editing.layout} requirements={requirements} isNew={editing.isNew} saving={saving}
            onCancel={() => setEditing(null)}
            onSave={async (layout) => { if (await change(editing.isNew ? "Worksheet layout saved" : "Worksheet layout updated", (state) => upsertLayout(state, layout), { worksheetLayout: layout.id, name: layout.name })) setEditing(null); }} />
        ) : (
          <>
            {layouts.length ? (
              <ul className="space-y-2" data-testid="worksheet-layout-list">
                {layouts.map((layout) => (
                  <li key={layout.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                    <span className="font-medium text-slate-800">{layout.name} <span className="text-xs font-normal text-slate-500">(started from {layout.base === "jnr" ? "JNR sheet" : layout.base === "basic" ? "Basic" : "blank"}{config.state.activeId === layout.id ? "; your company's layout" : ""})</span></span>
                    <span className="flex gap-2">
                      <Button type="button" variant="outline" disabled={saving} onClick={() => setEditing({ layout, isNew: false })}>Edit</Button>
                      {confirmDelete === layout.id ? (
                        <Button type="button" variant="outline" disabled={saving} onClick={async () => { await change("Worksheet layout deleted", (state) => archiveLayout(state, layout.id), { worksheetLayoutDeleted: layout.id }); setConfirmDelete(null); }}>Confirm delete</Button>
                      ) : <Button type="button" variant="outline" disabled={saving} onClick={() => setConfirmDelete(layout.id)}>Delete</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-slate-500">No layouts yet. Start one below.</p>}
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <label className="block min-w-48 flex-1 text-xs text-slate-600">New layout name
                <input className={input} maxLength={MAX_LAYOUT_NAME} value={startName} aria-label="New layout name" placeholder="e.g. Workshop sheet" onChange={(event) => setStartName(event.target.value)} />
              </label>
              <label className="block text-xs text-slate-600">Start from
                <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label="Start from" value={startFrom} onChange={(event) => setStartFrom(event.target.value as LayoutBase)}>
                  {START_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <Button type="button" variant="outline" disabled={layouts.length >= 10} onClick={() => { setEditing({ layout: newLayout(startFrom, startName), isNew: true }); setStartName(""); }}><Plus className="size-4" /> New layout</Button>
            </div>
            <p className="text-xs text-slate-500">To print one of your layouts by default, pick it in Print layout above. Deleting a layout keeps worksheets already signed off printing as they were signed.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
