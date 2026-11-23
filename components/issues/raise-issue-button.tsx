"use client";

// "Raise an issue": a small button for every signed-in person in a company that has the switch on, opening a short form (what went wrong,
// which page, urgent). Inputs: the company's hidden_nav (the 'issues:on' marker, OFF by default), the current page path, the person's session.
// Outputs: one raise_issue call through lib/issues/raise-issue.ts. Must not change: every role sees it (no role check); it is hidden in a
// support session (the database refuses there); ticking urgent shows "Call Rhys on 07908041480" and the issue is still saved; it sends no
// e-mail and calls no AI; the page defaults to the path only (no query string).

import { LifeBuoy } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { checkRaiseIssue, ISSUE_BODY_MAX, ISSUE_PAGE_MAX, issuePageFrom, issuesEnabled, OWNER_PHONE_DISPLAY, URGENT_CALL_MESSAGE } from "@/lib/issues/issues";
import { raiseIssue } from "@/lib/issues/raise-issue";
import { useOrgSettings } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

function CallRhys() {
  return (
    <p role="status" data-testid="issue-urgent-call" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
      Call Rhys on <a href={`tel:${OWNER_PHONE_DISPLAY}`} className="underline">{OWNER_PHONE_DISPLAY}</a>
    </p>
  );
}

export function RaiseIssueButton() {
  const { hiddenNav } = useOrgSettings();
  const { session } = useUser();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState("");
  const [body, setBody] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "page" | "body" | null; message: string } | null>(null);
  const [sent, setSent] = useState<{ urgent: boolean } | null>(null);

  if (!issuesEnabled(hiddenNav) || session?.support) return null;

  function openForm() {
    setPage(issuePageFrom(pathname));
    setBody("");
    setUrgent(false);
    setError(null);
    setSent(null);
    setOpen(true);
  }

  async function submit() {
    const checked = checkRaiseIssue({ page, body, urgent });
    if (!checked.ok) return setError({ field: checked.field, message: checked.error });
    setBusy(true);
    setError(null);
    const result = await raiseIssue(supabase, checked.value);
    setBusy(false);
    if (!result.ok) return setError({ field: null, message: result.error });
    setSent({ urgent: checked.value.urgent });
  }

  return (
    <>
      <button
        type="button"
        onClick={openForm}
        data-testid="raise-issue-button"
        className="fixed bottom-4 left-4 z-40 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 desk:left-[264px] print:hidden"
      >
        <LifeBuoy className="size-3.5" />Raise an issue
      </button>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Raise an issue</DialogTitle>
            <DialogDescription>Tell us what went wrong. It goes straight to the Tolra team.</DialogDescription>
          </DialogHeader>
          {sent ? (
            <div className="grid gap-3" data-testid="issue-sent">
              <p role="status" className="text-sm text-emerald-800">Thanks, your issue has been sent.</p>
              {sent.urgent ? <CallRhys /> : null}
              <Button type="button" onClick={() => setOpen(false)} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">Close</Button>
            </div>
          ) : (
            <form className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                What went wrong?
                <Textarea aria-label="What went wrong" value={body} maxLength={ISSUE_BODY_MAX} rows={4} onChange={(event) => setBody(event.target.value)} />
                {error?.field === "body" ? <span role="alert" className="text-xs font-normal text-red-700">{error.message}</span> : null}
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Which page?
                <Input aria-label="Which page" value={page} maxLength={ISSUE_PAGE_MAX} onChange={(event) => setPage(event.target.value)} className="h-11" autoComplete="off" />
                {error?.field === "page" ? <span role="alert" className="text-xs font-normal text-red-700">{error.message}</span> : null}
              </label>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} className="size-4" aria-label="Urgent" />
                Urgent: I can&apos;t carry on working
              </label>
              {urgent ? <CallRhys /> : null}
              {error && error.field === null ? <p role="alert" className="text-sm text-red-700">{error.message}</p> : null}
              <Button type="submit" disabled={busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Sending..." : "Send issue"}</Button>
              {urgent ? <p className="text-xs text-slate-500">{URGENT_CALL_MESSAGE}. Sending still saves your issue.</p> : null}
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
