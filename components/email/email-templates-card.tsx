"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BODY_MAX, DEFAULT_TEMPLATES, SAMPLE_VARS, SUBJECT_MAX, TEMPLATE_KEYS, type TemplateKey, type TemplateText, renderTemplate, unknownPlaceholders,
} from "@/lib/email/templates/defaults";
import {
  TEMPLATES_NOT_APPLIED_MESSAGE, type TemplateOverrides, loadTemplateOverrides, resetTemplateOverride, saveTemplateOverride, templateProblem,
} from "@/lib/email/templates/store";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useUser } from "@/lib/use-user";

type Drafts = Partial<Record<TemplateKey, TemplateText>>;
/** A copy of `record` without `key`. */
function without<T>(record: Partial<Record<TemplateKey, T>>, key: TemplateKey): Partial<Record<TemplateKey, T>> {
  const next = { ...record };
  delete next[key];
  return next;
}

type LoadState = { status: "loading" } | { status: "ready" } | { status: "not_applied" } | { status: "error"; message: string };

/** What the editor shows for `key`: the unsaved draft, else the company's saved text, else the default. */
export function editorText(key: TemplateKey, drafts: Drafts, overrides: TemplateOverrides): TemplateText {
  return drafts[key] ?? overrides[key] ?? { subject: DEFAULT_TEMPLATES[key].subject, body: DEFAULT_TEMPLATES[key].body };
}

/**
 * One template: subject and body editors, and the live preview with example values, rendered by the same renderTemplate the senders
 * use. Read-only (no inputs to change, no buttons) when `canEdit` is false.
 */
export function EmailTemplateEditor({ templateKey, value, custom, dirty, canEdit, busy, onChange, onSave, onReset }: {
  templateKey: TemplateKey; value: TemplateText; custom: boolean; dirty: boolean; canEdit: boolean; busy: boolean;
  onChange: (next: TemplateText) => void; onSave: () => void; onReset: () => void;
}) {
  const definition = DEFAULT_TEMPLATES[templateKey];
  const preview = renderTemplate(templateKey, SAMPLE_VARS, value);
  const unknown = unknownPlaceholders(`${value.subject}\n${value.body}`);
  const id = `email-template-${templateKey}`;
  return (
    <section className="rounded-lg border p-4" aria-labelledby={`${id}-title`} data-testid={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold text-slate-950">{definition.label}</h3>
        <span className="text-xs text-slate-500">{custom ? "Your own text" : "Default text"}{dirty ? " (unsaved changes)" : ""}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{definition.usedFor}</p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-2">
          <label htmlFor={`${id}-subject`} className="text-xs font-semibold text-slate-700">Subject</label>
          <Input id={`${id}-subject`} value={value.subject} maxLength={SUBJECT_MAX} readOnly={!canEdit} onChange={(event) => onChange({ ...value, subject: event.target.value.replace(/[\r\n]+/g, " ") })} />
          <label htmlFor={`${id}-body`} className="text-xs font-semibold text-slate-700">Text</label>
          <Textarea id={`${id}-body`} className="min-h-48" value={value.body} maxLength={BODY_MAX} readOnly={!canEdit} onChange={(event) => onChange({ ...value, body: event.target.value })} />
          <p className="text-xs text-slate-500">Placeholders: {definition.placeholders.map((name) => `{{${name}}}`).join(" ")}</p>
          {unknown.length ? <p role="alert" className="text-xs text-amber-700">Not a placeholder this e-mail fills in, so it will show as typed: {unknown.map((name) => `{{${name}}}`).join(" ")}</p> : null}
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button className="bg-brand text-brand-ink" disabled={busy || !dirty} onClick={onSave}>{busy ? "Saving..." : "Save"}</Button>
              <Button variant="outline" disabled={busy || (!custom && !dirty)} onClick={onReset}>Reset to default</Button>
            </div>
          ) : null}
        </div>
        <div className="grid content-start gap-2" aria-live="polite">
          <p className="text-xs font-semibold text-slate-700">Preview (example details)</p>
          <div className="rounded-md border bg-slate-50 p-3 text-sm">
            <p className="font-semibold text-slate-950" data-testid={`${id}-preview-subject`}>{preview.subject}</p>
            <p className="mt-2 whitespace-pre-wrap break-words text-slate-700" data-testid={`${id}-preview-body`}>{preview.text}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Settings > Email templates: one editor per e-mail the app sends. A company's saved text replaces the default for everyone in the
 * company; Reset to default removes it. Office and admin save (the database checks it, migration 106); others see it read-only.
 * Before database update 106 is applied the card says so and every e-mail keeps its default text.
 */
export function EmailTemplatesCard() {
  const { activeRole } = useUser();
  const canEdit = activeRole === "admin" || activeRole === "office";
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [overrides, setOverrides] = useState<TemplateOverrides>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busyKey, setBusyKey] = useState<TemplateKey | null>(null);

  useEffect(() => {
    let live = true;
    void loadTemplateOverrides(supabase).then((result) => {
      if (!live) return;
      if (result.status === "ok") {
        setOverrides(result.overrides);
        setState({ status: "ready" });
      } else setState(result.status === "not_applied" ? { status: "not_applied" } : { status: "error", message: result.message });
    });
    return () => { live = false; };
  }, []);

  async function save(key: TemplateKey) {
    const text = editorText(key, drafts, overrides);
    const problem = templateProblem(text);
    if (problem) return void toast.error(problem);
    setBusyKey(key);
    try {
      const organizationId = await getCurrentOrganizationId();
      const result = await saveTemplateOverride(supabase, organizationId, key, text);
      if (!result.ok) {
        if (result.notApplied) setState({ status: "not_applied" });
        return void toast.error(result.message);
      }
      setOverrides((current) => ({ ...current, [key]: { subject: text.subject.trim(), body: text.body.trim(), updatedAt: new Date().toISOString() } }));
      setDrafts((current) => without(current, key));
      toast.success(`${DEFAULT_TEMPLATES[key].label} template saved`);
    } catch {
      toast.error("Couldn't save the template. Sign in again and retry.");
    } finally {
      setBusyKey(null);
    }
  }

  async function reset(key: TemplateKey) {
    if (!overrides[key]) {
      setDrafts((current) => without(current, key));
      return;
    }
    setBusyKey(key);
    try {
      const organizationId = await getCurrentOrganizationId();
      const result = await resetTemplateOverride(supabase, organizationId, key);
      if (!result.ok) {
        if (result.notApplied) setState({ status: "not_applied" });
        return void toast.error(result.message);
      }
      setOverrides((current) => without(current, key));
      setDrafts((current) => without(current, key));
      toast.success(`${DEFAULT_TEMPLATES[key].label} template reset to default`);
    } catch {
      toast.error("Couldn't reset the template. Sign in again and retry.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="size-5 text-brand-accent" /> Email templates</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-slate-600">The text of each e-mail the app prepares. Words in double curly brackets, like {"{{document_number}}"}, are filled in for each e-mail. The preview shows example details as you type.</p>
        <EmailTemplatesBody state={state} canEdit={canEdit} overrides={overrides} drafts={drafts} busyKey={busyKey}
          onChange={(key, next) => setDrafts((current) => ({ ...current, [key]: next }))} onSave={(key) => void save(key)} onReset={(key) => void reset(key)} />
      </CardContent>
    </Card>
  );
}

/** The card's body for each load state (split out so it can be rendered in a test without a browser). */
export function EmailTemplatesBody({ state, canEdit, overrides, drafts, busyKey, onChange, onSave, onReset }: {
  state: LoadState; canEdit: boolean; overrides: TemplateOverrides; drafts: Drafts; busyKey: TemplateKey | null;
  onChange: (key: TemplateKey, next: TemplateText) => void; onSave: (key: TemplateKey) => void; onReset: (key: TemplateKey) => void;
}) {
  if (state.status === "loading") return <p className="text-slate-500" role="status">Loading templates...</p>;
  if (state.status === "not_applied") return <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800" role="status">{TEMPLATES_NOT_APPLIED_MESSAGE} Until then every e-mail uses its default text.</p>;
  if (state.status === "error") return <p className="text-red-700" role="alert">{state.message}</p>;
  return (
    <div className="space-y-4">
      {canEdit ? null : <p className="text-xs text-slate-500">Only office and admin users can change these.</p>}
      {TEMPLATE_KEYS.map((key) => {
        const value = editorText(key, drafts, overrides);
        const saved = overrides[key] ?? { subject: DEFAULT_TEMPLATES[key].subject, body: DEFAULT_TEMPLATES[key].body };
        return (
          <EmailTemplateEditor key={key} templateKey={key} value={value} custom={Boolean(overrides[key])} canEdit={canEdit} busy={busyKey === key}
            dirty={value.subject !== saved.subject || value.body !== saved.body}
            onChange={(next) => onChange(key, next)} onSave={() => onSave(key)} onReset={() => onReset(key)} />
        );
      })}
    </div>
  );
}
