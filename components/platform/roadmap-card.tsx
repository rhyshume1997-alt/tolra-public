"use client";

// Platform owner Roadmap list (module F). Inputs: GET /api/platform/roadmap. Outputs: POSTs to the same route (save, move up/down); the route and
// database do every check. Must not change: nothing is ever deleted; the order is the database's order after each change; no company data is shown
// beyond company names in the target picker.

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ROADMAP_DESCRIPTION_MAX, ROADMAP_FEW_MAX, ROADMAP_STATUS_LABEL, ROADMAP_STATUSES, ROADMAP_TARGET_LABEL, ROADMAP_TARGETS, ROADMAP_TITLE_MAX,
  type RoadmapItem, type RoadmapStatus, type RoadmapTarget,
} from "@/lib/platform/roadmap";

type Company = { organizationId: string; name: string };
type Draft = { id: string | null; title: string; description: string; status: RoadmapStatus; targetKind: RoadmapTarget; targetOrgIds: string[] };
const EMPTY: Draft = { id: null, title: "", description: "", status: "idea", targetKind: "all", targetOrgIds: [] };
const day = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "medium" }).format(new Date(value));

export function RoadmapCard() {
  const [items, setItems] = useState<RoadmapItem[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/platform/roadmap", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { items?: RoadmapItem[]; companies?: Company[]; error?: string; code?: string } | null;
      if (response.status === 403 && body?.code === "mfa_required") return window.location.assign("/mfa");
      if (!response.ok || !body?.items) return setMessage({ ok: false, text: body?.error || "Couldn't load the roadmap." });
      setItems(body.items);
      setCompanies(body.companies ?? []);
    } catch {
      setMessage({ ok: false, text: "Can't reach the server. Check your connection and try again." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(payload: unknown, done: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/platform/roadmap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (response.status === 403 && body?.code === "mfa_required") return window.location.assign("/mfa");
      if (!response.ok) return setMessage({ ok: false, text: body?.error || "Couldn't save the roadmap. Nothing was changed." });
      setMessage({ ok: true, text: done });
      setDraft(null);
      await load();
    } catch {
      setMessage({ ok: false, text: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string) => companies.find((c) => c.organizationId === id)?.name ?? "A company";
  const targetText = (item: RoadmapItem) => (item.targetKind === "all" ? ROADMAP_TARGET_LABEL.all : `${ROADMAP_TARGET_LABEL[item.targetKind]}: ${item.targetOrgIds.map(nameOf).join(", ")}`);
  const kindOk = draft && (draft.targetKind === "all" ? draft.targetOrgIds.length === 0 : draft.targetKind === "one" ? draft.targetOrgIds.length === 1 : draft.targetOrgIds.length >= 2 && draft.targetOrgIds.length <= ROADMAP_FEW_MAX);
  const ready = !!draft && draft.title.trim().length > 0 && !!kindOk;

  function toggleCompany(id: string) {
    setDraft((d) => {
      if (!d) return d;
      if (d.targetKind === "one") return { ...d, targetOrgIds: d.targetOrgIds[0] === id ? [] : [id] };
      return { ...d, targetOrgIds: d.targetOrgIds.includes(id) ? d.targetOrgIds.filter((x) => x !== id) : [...d.targetOrgIds, id] };
    });
  }

  return (
    <Card className="mt-4" data-testid="roadmap">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Roadmap</CardTitle>
        <Button className="min-h-11" disabled={busy || !!draft} onClick={() => { setDraft(EMPTY); setMessage(null); }}>Add an item</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-slate-600">Upcoming improvements, in the order you want them. Only platform owners see this. Nothing here changes any company.</p>
        {message ? <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-green-700" : "text-sm text-red-700"}>{message.text}</p> : null}

        {draft ? (
          <form className="grid gap-3 rounded-lg border border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); if (ready) void send({ action: "save", ...draft }, "Saved."); }}>
            <label className="grid gap-1 text-sm">Title
              <Input aria-label="Title" value={draft.title} maxLength={ROADMAP_TITLE_MAX} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="h-11" autoComplete="off" />
            </label>
            <label className="grid gap-1 text-sm">Short description
              <Textarea aria-label="Description" value={draft.description} maxLength={ROADMAP_DESCRIPTION_MAX} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <label className="grid gap-1 text-sm">Status
              <select aria-label="Status" className="h-11 rounded-md border px-2" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as RoadmapStatus })}>
                {ROADMAP_STATUSES.map((s) => <option key={s} value={s}>{ROADMAP_STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">Target
              <select aria-label="Target" className="h-11 rounded-md border px-2" value={draft.targetKind} onChange={(e) => setDraft({ ...draft, targetKind: e.target.value as RoadmapTarget, targetOrgIds: [] })}>
                {ROADMAP_TARGETS.map((t) => <option key={t} value={t}>{ROADMAP_TARGET_LABEL[t]}</option>)}
              </select>
            </label>
            {draft.targetKind !== "all" ? (
              <fieldset className="grid gap-1 text-sm">
                <legend className="mb-1">{draft.targetKind === "one" ? "Choose one company" : `Choose 2 to ${ROADMAP_FEW_MAX} companies`}</legend>
                {companies.map((c) => (
                  <label key={c.organizationId} className="flex min-h-9 items-center gap-2">
                    <input type={draft.targetKind === "one" ? "radio" : "checkbox"} name="target" checked={draft.targetOrgIds.includes(c.organizationId)} onChange={() => toggleCompany(c.organizationId)} />
                    {c.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={!ready || busy} className="min-h-11">{busy ? "Saving..." : "Save"}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)} className="min-h-11">Cancel</Button>
            </div>
          </form>
        ) : null}

        {items === null && !message ? <p className="text-sm text-slate-500">Loading...</p> : null}
        {items?.length === 0 ? <p className="text-sm text-slate-500">No items yet.</p> : null}
        <ol className="grid gap-2" data-testid="roadmap-list">
          {(items ?? []).map((item, index) => (
            <li key={item.id} className="rounded-lg border border-slate-200 p-3" data-item={item.title}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 font-semibold text-slate-950">{item.title}</p>
                <Badge variant="outline">{ROADMAP_STATUS_LABEL[item.status]}</Badge>
                <Button variant="outline" size="sm" aria-label={`Move ${item.title} up`} disabled={busy || index === 0} onClick={() => void send({ action: "move", id: item.id, direction: "up" }, "Moved up.")}>Up</Button>
                <Button variant="outline" size="sm" aria-label={`Move ${item.title} down`} disabled={busy || index === (items?.length ?? 0) - 1} onClick={() => void send({ action: "move", id: item.id, direction: "down" }, "Moved down.")}>Down</Button>
                <Button variant="outline" size="sm" aria-label={`Edit ${item.title}`} disabled={busy || !!draft} onClick={() => { setDraft({ id: item.id, title: item.title, description: item.description, status: item.status, targetKind: item.targetKind, targetOrgIds: item.targetOrgIds }); setMessage(null); }}>Edit</Button>
              </div>
              {item.description ? <p className="mt-1 text-sm text-slate-600">{item.description}</p> : null}
              <p className="mt-1 text-xs text-slate-500">{targetText(item)}. Added {day(item.createdAt)}{item.shippedAt ? `. Shipped ${day(item.shippedAt)}` : ""}.</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
