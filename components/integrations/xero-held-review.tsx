"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { postJson, safeMessage } from "@/lib/integrations/ai-setup";
import { sendWithCode } from "@/lib/mfa-step-up";

export type HeldSend = { id: string; doc_type: string; doc_ref: string | null; action: string; status: string; queued_at: string };

export const HELD_REVIEW_INTRO = "These documents were waiting before transfers were turned on for this connection. Turning transfers on, reconnecting or retrying never sends them: tick each one you have checked is not already in Xero and approve it. Approved documents go when transfers are on.";

/**
 * Held for review (release 149): the company's Xero documents queued before transfers were switched on for this connection. Reads
 * GET /api/integrations/xero/held; approving POSTs the ticked ids with a fresh authenticator code (the route answers mfa_recent_required, the
 * code dialog opens, the same request is sent once more). Nothing is approved without a tick; nothing is sent from here.
 */
export function XeroHeldReview({ requestCode, refreshKey }: { requestCode: () => Promise<boolean>; refreshKey?: unknown }) {
  const [held, setHeld] = useState<HeldSend[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/xero/held", { credentials: "same-origin", cache: "no-store" });
      const body = res.ok ? ((await res.json().catch(() => null)) as { held?: unknown } | null) : null;
      if (body && Array.isArray(body.held)) { setHeld(body.held as HeldSend[]); setReadFailed(false); } else { setHeld(null); setReadFailed(true); }
    } catch { setHeld(null); setReadFailed(true); }
    setTicked(new Set());
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const toggle = (id: string) => setTicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const approve = async () => {
    if (ticked.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await sendWithCode(() => postJson("/api/integrations/xero/held", { sends: [...ticked] }), requestCode);
      if (outcome.result === "cancelled") setMessage("Cancelled. Nothing was approved.");
      else if (outcome.result === "failed") setMessage(safeMessage(outcome.answer.body, "Nothing was approved. Try again."));
      else setMessage("Approved. They are sent when transfers are on.");
      await load();
    } finally { setBusy(false); }
  };

  if (readFailed) return <p data-testid="xero-held-error" className="text-sm text-amber-800">Couldn&apos;t read the documents held for review. Nothing held is sent.</p>;
  if (!held || held.length === 0) return message ? <p data-testid="xero-held-message" className="text-sm text-slate-700">{message}</p> : null;
  return (
    <section data-testid="xero-held-review" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <h3 className="font-semibold">Held for review ({held.length})</h3>
      <p className="mt-1">{HELD_REVIEW_INTRO}</p>
      <ul className="mt-2 space-y-1">
        {held.map((h) => (
          <li key={h.id}>
            <label className="flex items-center gap-2">
              <input type="checkbox" data-testid={`xero-held-${h.id}`} checked={ticked.has(h.id)} onChange={() => toggle(h.id)} disabled={busy} />
              <span>{h.doc_ref ?? "(no number)"} · {h.doc_type === "credit_note" ? "credit note" : "invoice"}{h.action === "void" ? " (void)" : ""} · {h.status.replace("_", " ")} · queued {h.queued_at.slice(0, 10)}</span>
            </label>
          </li>
        ))}
      </ul>
      <Button className="mt-2" data-testid="xero-held-approve" disabled={busy || ticked.size === 0} onClick={() => void approve()}>
        Approve {ticked.size || ""} selected
      </Button>
      {message ? <p data-testid="xero-held-message" className="mt-2">{message}</p> : null}
    </section>
  );
}
