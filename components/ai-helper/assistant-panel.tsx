"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AssistantAnswer, AssistantTopic } from "@/lib/ai-helper/assistant";

type Result = Partial<AssistantAnswer> & { notice?: string | null; error?: string };

const DRAFT_LABELS: Record<string, string> = { email: "E-mail", note: "Note", quote_wording: "Quote wording", rfq_clarification: "RFQ clarification" };

/**
 * G3, the assistant (suggestions only; online only: nothing here is queued offline). The person picks what to ask about and types a
 * question; the answer, the records it used (each a link to its own page) and any draft are shown for them to read. A draft has a Copy
 * button and nothing else: there is no Send, Save or Apply here, and the panel calls no route but the assistant's.
 */
export function AiAssistantPanel({ onUsed }: { onUsed?: () => void }) {
  const [topic, setTopic] = useState<AssistantTopic>("quotes");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function ask() {
    setBusy(true);
    try {
      const response = await fetch("/api/ai-helper/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, question }) });
      const payload = (await response.json().catch(() => ({}))) as Result;
      setResult(response.ok ? payload : { error: payload.error || "The AI assistant is not available right now." });
    } catch {
      setResult({ error: "The AI assistant is not available right now. It needs a connection: nothing is queued offline." });
    } finally {
      setBusy(false);
      onUsed?.();
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Draft copied. Check it before you use it.");
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  const draft = result?.draft;
  return (
    <Card data-testid="ai-assistant-panel">
      <CardHeader><CardTitle>Assistant</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">Ask about your recent quotes or jobs, or ask for a draft. Suggestions only: it never sends, saves or changes anything. Online only.</p>
        <div className="space-y-2">
          <select aria-label="Ask about" className="h-9 rounded-md border px-2 text-sm" value={topic} onChange={(e) => setTopic(e.target.value as AssistantTopic)}>
            <option value="quotes">Quotes</option>
            <option value="jobs">Jobs</option>
          </select>
          <textarea aria-label="Your question" className="min-h-24 w-full rounded-md border p-2 text-sm" maxLength={1000} value={question}
            placeholder="For example: which quotes are still waiting for a reply? Draft a chaser for the oldest."
            onChange={(e) => setQuestion(e.target.value)} />
          <Button type="button" onClick={() => void ask()} disabled={busy || !question.trim()}>Ask</Button>
        </div>
        {result?.error ? <p role="alert" className="text-sm text-amber-800">{result.error}</p> : null}
        {result?.answer ? <p className="whitespace-pre-line rounded-lg border bg-slate-50 p-3 text-sm text-slate-800" data-testid="ai-assistant-answer">{result.answer}</p> : null}
        {result?.refs?.length ? (
          <ul className="flex flex-wrap gap-2 text-sm" aria-label="Records it used">
            {result.refs.map((r) => <li key={r.ref}><Link className="underline" href={r.href}>{r.ref}</Link></li>)}
          </ul>
        ) : null}
        {draft ? (
          <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="ai-assistant-draft">
            <p className="font-medium text-slate-900">Draft ({DRAFT_LABELS[draft.kind] ?? "Text"}): check it before you use it. Nothing has been sent.</p>
            {draft.subject ? <p className="text-slate-700">Subject: {draft.subject}</p> : null}
            <p className="whitespace-pre-line text-slate-800">{draft.body}</p>
            <Button type="button" variant="outline" onClick={() => void copy(draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body)}>Copy draft</Button>
          </div>
        ) : null}
        {result?.review?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800" aria-label="Needs human review" data-testid="ai-assistant-review">
            {result.review.map((item) => <li key={item}>{item}</li>)}
          </ul>
        ) : null}
        {result?.notice ? <p className="text-sm text-slate-600" data-testid="ai-assistant-notice">{result.notice}</p> : null}
      </CardContent>
    </Card>
  );
}
