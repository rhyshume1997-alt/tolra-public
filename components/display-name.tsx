"use client";

import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { UserRound, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DISPLAY_NAME_MAX, displayNameProblem, hasDisplayName, shouldPromptForName } from "@/lib/display-name";
import { friendlyError } from "@/lib/friendly-error";
import { useUser } from "@/lib/use-user";

/** The name field with Save, for Account Settings and the prompt. */
export function DisplayNameForm({ compact = false, onSaved }: { compact?: boolean; onSaved?: () => void }) {
  const { profile, updateDisplayName } = useUser();
  const current = hasDisplayName(profile?.full_name) ? profile!.full_name!.trim() : "";
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  useEffect(() => { setValue(current); }, [current]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = displayNameProblem(value);
    setProblem(issue);
    if (issue) return;
    setSaving(true);
    try {
      await updateDisplayName(value);
      toast.success("Your name is saved.");
      onSaved?.();
    } catch (err) {
      setProblem(friendlyError(err, "Couldn't save your name. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={compact ? "flex flex-wrap items-start gap-2" : "grid gap-2"} noValidate>
      <label htmlFor={id} className={compact ? "sr-only" : "text-sm font-medium text-slate-700"}>Display name</label>
      <Input
        id={id}
        name="displayName"
        value={value}
        maxLength={DISPLAY_NAME_MAX}
        autoComplete="name"
        placeholder="e.g. Dave Smith"
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(event) => setValue(event.target.value)}
        className={compact ? "h-11 min-w-0 flex-1 basis-48 bg-white" : "h-11"}
      />
      <Button type="submit" disabled={saving} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{saving ? "Saving..." : "Save name"}</Button>
      {problem ? <p id={`${id}-problem`} role="alert" className="basis-full text-sm text-red-700">{problem}</p> : null}
      {compact ? null : <p className="text-xs text-slate-500">Shown to your colleagues on the Job Board, the schedule and in who-did-what.</p>}
    </form>
  );
}

const DISMISS_KEY = "name-prompt-later";

function dismissedFor(userId: string) {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === userId;
  } catch {
    return false;
  }
}

/**
 * Non-blocking prompt at the top of every page while the signed-in person has no display name, so the Job Board can say who a
 * job is assigned to instead of "—". "Later" hides it for this browser session only; it comes back until a name is saved.
 */
export function DisplayNamePrompt() {
  const { user, profile, session } = useUser();
  const [later, setLater] = useState(true);
  useEffect(() => { setLater(user ? dismissedFor(user.id) : true); }, [user]);
  if (!user || !profile || later || !shouldPromptForName({ fullName: profile.full_name, support: session?.support })) return null;

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, user!.id);
    } catch {
      // Storage unavailable: hidden for this page only.
    }
    setLater(true);
  }

  return (
    <section aria-label="Add your name" data-testid="name-prompt" className="mb-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950 print:hidden dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
      <div className="flex items-start gap-2">
        <UserRound className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1"><strong>Add your name</strong> so colleagues can see who is working on what.</p>
        <button type="button" onClick={dismiss} aria-label="Remind me later" className="-m-1 flex size-9 shrink-0 items-center justify-center rounded-none text-sky-900/70 hover:bg-sky-900/10 pointer-coarse:size-11 dark:text-sky-100/70"><X className="size-4" /></button>
      </div>
      <div className="mt-2"><DisplayNameForm compact /></div>
    </section>
  );
}
