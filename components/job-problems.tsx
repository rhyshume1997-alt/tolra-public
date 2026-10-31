"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canReadUsernames, loadCompanyPeople } from "@/lib/company-people";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { loadOpenProblems, problemControls, problemsFor, reasonLabel, resolveJobProblem, RESOLUTION_NOTE_MIN, type OpenProblem } from "@/lib/job-problems";
import { type PeopleMap, personName } from "@/lib/people";
import { supabase } from "@/lib/supabase";
import { useMaybeUser } from "@/lib/use-user";

/** The jobs that carry an open problem (migration 117), for the Job Board's rows. Empty until the database says it has 117 (fail closed). */
export const ProblemJobsContext = createContext<ReadonlySet<string>>(new Set());

/** The "Problem" tag on a Job Board row or card: red, with its word. Nothing when the job has no open problem. */
export function ProblemTag({ jobId, className }: { jobId: string | undefined; className?: string }) {
  const jobs = useContext(ProblemJobsContext);
  if (!jobId || !jobs.has(jobId)) return null;
  return <StatusBadge data-testid="problem-tag" status="problem" label="Problem" className={className} />;
}

/**
 * The open problems on one job, in the job's worksheet: what, who raised it and when. Admin and office clear one with a note saying what
 * was done (it is then recorded in the job's history); everyone else only reads. Shows nothing until the database has 117 or while the job
 * has no open problem. Clearing a problem never changes the job itself.
 */
export function JobProblemsPanel({ jobId, jobNo, onChanged }: { jobId: string; jobNo: string; onChanged?: () => void }) {
  const viewer = useMaybeUser();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [problems, setProblems] = useState<OpenProblem[]>([]);
  const [people, setPeople] = useState<PeopleMap>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const controls = problemControls({ available, role: viewer?.activeRole, online: true, readOnly: viewer?.session?.read_only ?? false });

  const load = useCallback(async () => {
    if (!supabase) return;
    const answer = await loadOpenProblems(supabase, [jobId]);
    setAvailable(answer.available);
    setProblems(answer.problems);
    if (answer.problems.length) {
      const who = await loadCompanyPeople(supabase, { usernames: canReadUsernames(viewer?.profile) }).catch(() => null);
      if (who) setPeople(who);
    }
  }, [jobId, viewer?.profile]);
  useEffect(() => { void load(); }, [load]);

  async function resolve(problem: OpenProblem) {
    if (!supabase || busy) return;
    const note = (notes[problem.id] ?? "").trim();
    if (note.length < RESOLUTION_NOTE_MIN) {
      setFailure(`Say what was done (at least ${RESOLUTION_NOTE_MIN} characters).`);
      return;
    }
    setBusy(problem.id);
    setFailure(null);
    try {
      await resolveJobProblem(supabase, problem.id, note);
      toast.success("Problem resolved.");
      await load();
      onChanged?.();
    } catch (err) {
      setFailure(friendlyError(err, "The problem wasn't resolved. Try again."));
    } finally {
      setBusy(null);
    }
  }

  if (available !== true || !problems.length) return null;
  const mine = problemsFor(problems, jobId);
  return (
    <section data-testid="job-problems" aria-label={`Problems on ${jobNo}`} className="mt-4 space-y-3 border border-line bg-surface p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><AlertTriangle className="size-4" />Problems reported ({mine.length})</h3>
      {mine.map((problem) => (
        <div key={problem.id} data-testid="job-problem" className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
          <p className="text-sm text-ink"><StatusBadge status="problem" label="Problem" /> <span className="font-semibold">{reasonLabel(problem.reason)}</span>{problem.note ? `: ${problem.note}` : ""}</p>
          <p className="text-xs text-muted-foreground">Reported by {personName(people, problem.reported_by)} on {fmtDateTime(problem.reported_at)}. Waiting for the office.</p>
          {controls.canResolve ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label={`What was done about the ${reasonLabel(problem.reason).toLowerCase()} problem on ${jobNo}`} data-testid="job-problem-note" className="h-11 min-w-0 flex-1" maxLength={500} placeholder="What was done" value={notes[problem.id] ?? ""} disabled={busy === problem.id} onChange={(event) => setNotes((current) => ({ ...current, [problem.id]: event.target.value }))} />
              <Button type="button" className="h-auto min-h-12 px-4 py-2 text-base font-semibold pointer-coarse:h-auto pointer-coarse:min-h-12" data-testid="job-problem-resolve" disabled={busy === problem.id} onClick={() => void resolve(problem)}>{busy === problem.id ? "Resolving..." : "Mark resolved"}</Button>
            </div>
          ) : null}
        </div>
      ))}
      {failure ? <p role="alert" className="text-sm font-semibold text-destructive">{failure}</p> : null}
    </section>
  );
}
