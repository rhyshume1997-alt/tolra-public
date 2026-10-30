"use client";

import { useEffect, useState } from "react";

import { useAiFeatures } from "@/components/ai-features";
import { Button } from "@/components/ui/button";
import type { FinanceCheckKind, Suggestion } from "@/lib/ai/finance-check/check";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type State = { status: "loading" } | { status: "ready"; suggestions: Suggestion[] } | { status: "unavailable" } | { status: "company_off" };

/**
 * "Check before issue" (Tolra AI agent 1, SUGGEST ONLY). Shown inside the Issue dialogs only when the server has the finance check
 * switched on. It runs once when it appears, lists what it found with Accept and Dismiss per item, and never touches the Issue button:
 * it has no handle on it, so Issue never waits for it, and a failed check just says so. Accept only records the decision; the person
 * corrects the document themselves. Text is rendered as plain text (React escaping), never HTML.
 */
export function AiFinanceCheckPanel({ kind, id }: { kind: FinanceCheckKind; id: string | null | undefined }) {
  const { financeCheck } = useAiFeatures();
  const enabled = financeCheck && Boolean(id && UUID.test(id));
  if (!enabled) return null;
  return <FinanceCheckBody kind={kind} id={id as string} />;
}

function FinanceCheckBody({ kind, id }: { kind: FinanceCheckKind; id: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [decided, setDecided] = useState<Record<string, "accepted" | "rejected">>({});

  useEffect(() => {
    let live = true;
    // Online only: nothing AI-related is queued offline.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState({ status: "unavailable" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    fetch("/api/ai/finance-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id }), signal: controller.signal })
      .then(async (res) => {
        // The company has the check off (AI section): show nothing at all, not an error.
        if (res.status === 403 && ((await res.json().catch(() => null)) as { code?: string } | null)?.code === "company_off") {
          if (live) setState({ status: "company_off" });
          return;
        }
        const body = res.ok ? ((await res.json()) as { suggestions?: Suggestion[] }) : null;
        if (live) setState(body && Array.isArray(body.suggestions) ? { status: "ready", suggestions: body.suggestions } : { status: "unavailable" });
      })
      .catch(() => live && setState({ status: "unavailable" }))
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, id]);

  async function decide(suggestion: Suggestion, decision: "accepted" | "rejected") {
    setDecided((d) => ({ ...d, [suggestion.id]: decision }));
    try {
      await fetch("/api/ai/finance-check/decision", {
        method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
        body: JSON.stringify({ kind, id, suggestionId: suggestion.id, code: suggestion.code, decision }),
      });
    } catch {
      // Best effort: the decision is only a record; nothing on the document depends on it.
    }
  }

  if (state.status === "company_off") return null;
  return (
    <section aria-label="Check before issue" data-testid="ai-finance-check" className="space-y-2 rounded-lg border p-3 text-sm">
      <h3 className="font-semibold text-slate-950">Check before issue</h3>
      {state.status === "loading" ? <p className="text-xs text-slate-500">Checking… You can issue without waiting.</p> : null}
      {state.status === "unavailable" ? <p className="text-xs text-slate-500">Check not available.</p> : null}
      {state.status === "ready" && !state.suggestions.length ? <p className="text-xs text-slate-600">Nothing to flag.</p> : null}
      {state.status === "ready" && state.suggestions.length ? (
        <ul className="space-y-2">
          {state.suggestions.map((s) => (
            <li key={s.id} data-code={s.code} className="flex flex-wrap items-start gap-2">
              <span className={s.severity === "warning" ? "flex-1 text-amber-800 dark:text-amber-300" : "flex-1 text-slate-700"}>{s.message}</span>
              {decided[s.id] ? (
                <span className="text-xs text-slate-500">{decided[s.id] === "accepted" ? "Noted: correct the document, then issue." : "Dismissed"}</span>
              ) : (
                <span className="flex gap-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => void decide(s, "accepted")}>Accept</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void decide(s, "rejected")}>Dismiss</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-slate-500">Suggestions only. Nothing is changed for you.</p>
    </section>
  );
}
