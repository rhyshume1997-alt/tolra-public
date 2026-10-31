"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BATCH_CHUNK, type BatchDocType, type BatchMode, type ItemResult, defaultFrom, startsBeforeConnection } from "@/lib/integrations/xero/batch";

type PreviewItem = { docType: BatchDocType; id: string; ref: string | null; customer: string; date: string; total: number | null; state: string };
type Preview = {
  connected: boolean;
  truncated: boolean;
  counts: { sent: number; sending: number; needsCheck: number; failed: number; waiting: number; notQueued: number; skipped: number; imported: number; selected: number };
  items: PreviewItem[];
};
type ChunkAnswer = {
  results: ItemResult[];
  stopped: null | { reason: string; pauseSeconds?: number; unmapped?: string[] };
  remaining: Array<{ docType: BatchDocType; id: string }>;
};

const OUTCOME: Record<ItemResult["outcome"], string> = {
  sent: "Sent", failed: "Failed", needs_check: "Check in Xero", waiting: "Waiting", left: "Left alone", not_attempted: "Not attempted",
};
const STOP_WORDS: Record<string, string> = {
  not_connected: "Xero is not connected.", needs_reconnect: "Xero needs connecting again.", disconnected: "Xero is disconnected.",
  unmapped: "Some accounts or VAT rates are not mapped yet.", no_token: "Xero sign-in is not available: connect again.", time: "Paused to keep each step short.",
};
const money = (n: number | null) => (n === null ? "" : n.toLocaleString("en-GB", { style: "currency", currency: "GBP" }));
const label = (i: { docType: BatchDocType; ref: string | null }) => `${i.docType === "credit_note" ? "Credit note" : "Invoice"} ${i.ref ?? "(no number)"}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Admin > Integrations: send a date range of issued invoices and credit notes to Xero in small batches, and download the accountant's
 * summary. Preview first (the count and the list); the page then sends the list a few documents at a time, so one slow call never holds
 * the rest. What is sent is decided again on the server for each document: one already sent is never sent again; "Resend failed only"
 * queues failed ones again (the server reads Xero back first). Pauses when Xero asks it to slow down, then carries on.
 */
export function XeroBatchCard() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultFrom(null, today));
  const [to, setTo] = useState(today);
  const [mode, setMode] = useState<BatchMode>("unsent");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stop = useRef(false);
  const [connectedOn, setConnectedOn] = useState<string | null>(null);
  const [includeBefore, setIncludeBefore] = useState(false);

  // The default From is the day Xero was connected: earlier documents may already be in Xero, so they need the tick box below.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/xero/batch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "info" }) });
        const info = (await res.json().catch(() => ({}))) as { connectedOn?: string | null };
        if (alive && res.ok && info.connectedOn) { setConnectedOn(info.connectedOn); setFrom(defaultFrom(info.connectedOn, new Date().toISOString().slice(0, 10))); }
      } catch { /* the card still works without the default */ }
    })();
    return () => { alive = false; };
  }, []);
  const needsTick = startsBeforeConnection(from, connectedOn) && !includeBefore;

  async function call(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await fetch("/api/integrations/xero/batch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, include_before_connection: includeBefore }) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      toast.error(typeof json.error === "string" ? json.error : "That didn't work. Try again.");
      return null;
    }
    return json;
  }

  async function runPreview(nextMode: BatchMode = mode) {
    setBusy("preview");
    setNote(null);
    setResults({});
    try {
      const body = await call({ action: "preview", from, to, mode: nextMode });
      setPreview((body as Preview | null) ?? null);
    } finally {
      setBusy(null);
    }
  }

  async function sendAll() {
    if (!preview?.items.length) return;
    stop.current = false;
    setBusy("send");
    setNote(null);
    let queue = preview.items.map((i) => ({ docType: i.docType, id: i.id }));
    let guard = 0;
    try {
      while (queue.length && !stop.current && guard < 2000) {
        guard += 1;
        const chunk = queue.slice(0, BATCH_CHUNK);
        const body = (await call({ action: "send", mode, items: chunk.map((c) => ({ doc_type: c.docType, doc_id: c.id })) })) as ChunkAnswer | null;
        if (!body) break;
        setResults((prev) => ({ ...prev, ...Object.fromEntries(body.results.map((r) => [`${r.docType}:${r.docId}`, r])) }));
        const notReached = new Set(body.remaining.map((r) => `${r.docType}:${r.id}`));
        queue = [...body.remaining, ...queue.slice(chunk.length).filter((q) => !notReached.has(`${q.docType}:${q.id}`))];
        if (body.stopped?.reason === "rate_limited") {
          let left = body.stopped.pauseSeconds ?? 60;
          while (left > 0 && !stop.current) {
            setNote(`Xero asked us to slow down. Carrying on in ${left} s.`);
            await sleep(1000);
            left -= 1;
          }
          setNote(null);
        } else if (body.stopped && body.stopped.reason !== "time") {
          setNote(STOP_WORDS[body.stopped.reason] ?? "Stopped. Preview again to see what is left.");
          break;
        }
      }
      if (stop.current) setNote("Stopped. Nothing is sent twice: preview again to see what is left.");
    } finally {
      setBusy(null);
    }
  }

  const done = Object.values(results);
  const count = (o: ItemResult["outcome"]) => done.filter((r) => r.outcome === o).length;
  const summaryUrl = (format: "csv" | "xlsx") => `/api/integrations/xero/summary?${new URLSearchParams({ from, to, format })}`;

  return (
    <Card data-testid="xero-batch-card">
      <CardHeader>
        <CardTitle>Send a date range to Xero</CardTitle>
        <CardDescription>
          For catching up the accountant: issued invoices and credit notes between two dates (both days included) that have not been sent. A document
          already sent is never sent again. Imported records, drafts and voided documents are not included.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="text-sm font-medium text-slate-700">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-11" data-testid="batch-from" /></label>
          <label className="text-sm font-medium text-slate-700">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-11" data-testid="batch-to" /></label>
          <Button type="button" variant="outline" className="min-h-11" disabled={busy !== null || needsTick} onClick={() => void runPreview()}>Preview</Button>
        </div>
        {connectedOn ? (
          <label className="flex items-start gap-2 text-sm" data-testid="batch-include-before">
            <input type="checkbox" className="mt-1" checked={includeBefore} disabled={busy !== null} onChange={(e) => { setIncludeBefore(e.target.checked); setPreview(null); }} />
            <span>Include documents issued before Xero was connected ({connectedOn}). They may already be in Xero: check first.</span>
          </label>
        ) : null}
        {needsTick ? <p className="text-sm text-amber-700" data-testid="batch-before-warning">That starts before Xero was connected. Tick the box above to include those documents, or choose {connectedOn} or later.</p> : null}
        <fieldset className="flex flex-wrap gap-4 text-sm" disabled={busy !== null}>
          <label className="flex items-center gap-2"><input type="radio" name="batch-mode" checked={mode === "unsent"} onChange={() => { setMode("unsent"); setPreview(null); }} />Send what has not been sent</label>
          <label className="flex items-center gap-2"><input type="radio" name="batch-mode" checked={mode === "failed_only"} onChange={() => { setMode("failed_only"); setPreview(null); }} />Resend failed only</label>
        </fieldset>

        {preview ? (
          <div className="space-y-3" data-testid="batch-preview">
            {!preview.connected ? <p className="text-sm text-amber-700">Connect this company to Xero first. Nothing can be sent until then.</p> : null}
            <p className="text-sm">
              <strong>{preview.counts.selected}</strong> {preview.counts.selected === 1 ? "document" : "documents"} would be {mode === "unsent" ? "sent" : "sent again"}.
              {" "}Already sent: {preview.counts.sent}. Failed: {preview.counts.failed}. To check in Xero: {preview.counts.needsCheck}. Being sent: {preview.counts.sending}.
              {preview.counts.imported ? ` Imported (not sent): ${preview.counts.imported}.` : ""}
            </p>
            {preview.truncated ? <p className="text-sm text-amber-700">Only the first {preview.items.length} are listed. Send them, then preview again for the rest, or choose a shorter range.</p> : null}
            {preview.items.length ? (
              <div className="max-h-72 overflow-auto rounded border border-slate-200">
                <table role="table" className="w-full text-sm" data-testid="batch-list">
                  <thead role="rowgroup" className="bg-slate-50 text-left text-xs text-slate-600 max-md:hidden"><tr role="row"><th role="columnheader" className="p-2">Document</th><th role="columnheader" className="p-2">Customer</th><th role="columnheader" className="p-2">Date</th><th role="columnheader" className="p-2 text-right">Total</th><th role="columnheader" className="p-2">Result</th></tr></thead>
                  <tbody role="rowgroup">
                    {preview.items.map((i) => {
                      const r = results[`${i.docType}:${i.id}`];
                      return (
                        <tr role="row" key={`${i.docType}:${i.id}`} className="border-t border-slate-100 max-md:grid max-md:grid-cols-2 max-md:p-2" data-testid="batch-row" data-outcome={r?.outcome ?? ""}>
                          <td role="cell" className="p-2 font-medium max-md:col-span-2">{label(i)}</td><td role="cell" data-label="Customer" className="p-2">{i.customer}</td><td role="cell" data-label="Date" className="p-2">{i.date}</td>
                          <td role="cell" data-label="Total" className="p-2 text-right max-md:text-left">{money(i.total)}</td>
                          <td role="cell" data-label="Result" className="p-2">{r ? <><strong>{OUTCOME[r.outcome]}</strong>{r.detail ? <span className="block text-xs text-slate-600">{r.detail}</span> : null}</> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy !== null || !preview.connected || preview.items.length === 0} onClick={() => void sendAll()} data-testid="batch-send">
                {busy === "send" ? "Sending…" : mode === "unsent" ? `Send ${preview.items.length}` : `Resend ${preview.items.length} failed`}
              </Button>
              {busy === "send" ? <Button type="button" variant="outline" className="min-h-11" onClick={() => { stop.current = true; }}>Stop</Button> : null}
              {note ? <span className="text-sm text-slate-600" role="status">{note}</span> : null}
            </div>
            {done.filter((r) => !preview.items.some((i) => i.id === r.docId)).map((r) => (
              <p key={`${r.docType}:${r.docId}`} className="text-sm text-amber-700" data-testid="batch-extra">{OUTCOME[r.outcome]}: {r.detail}</p>
            ))}
            {done.length ? (
              <p className="text-sm" data-testid="batch-report">Sent {count("sent")}, failed {count("failed")}, to check in Xero {count("needs_check")}, waiting {count("waiting")}, left alone {count("left")}.</p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <a className="text-sm font-medium text-brand underline" href={summaryUrl("csv")} download data-testid="batch-summary-csv">Download summary (CSV)</a>
          <a className="text-sm font-medium text-brand underline" href={summaryUrl("xlsx")} download>Excel</a>
          <span className="text-xs text-slate-500">Every invoice and credit note in the range with its Xero number, when it was sent, its status and any error, for the accountant.</span>
        </div>
      </CardContent>
    </Card>
  );
}
