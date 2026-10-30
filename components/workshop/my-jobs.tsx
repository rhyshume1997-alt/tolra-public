"use client";

/**
 * The workshop dashboard's "My jobs" (shop-floor tablet): one card per job assigned to the operator, with one big main action and a big
 * Pause tap. Every action only opens the job on the Job Board (/jobs?job=<id>, which shows and highlights it), where the board's own
 * buttons do the work, so the offline path (outbox, machine pick, paused-machine prompt) is the board's, unchanged. Without access to
 * the Job Board the cards show the same details and no actions.
 */
import Link from "next/link";
import { CheckCircle2, Eye, PauseCircle, Play, Wrench } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate } from "@/lib/dates";
import { JOB_STATUS_BADGE, JOB_STATUS_LABELS, reworkTag, stageLabel, stageOf } from "@/lib/job-flow";
import { jobHref } from "@/lib/job-link";
import { DUE_CHIPS } from "@/lib/job-status";
import { myJobAction, myJobOffersPause, type MyJob, type MyJobAction } from "@/lib/my-jobs";

const DUE_WORD = Object.fromEntries(DUE_CHIPS.map((chip) => [chip.value, chip.label])) as Record<MyJob["dueLight"], string>;
const ACTION_ICON: Record<MyJobAction["kind"], React.ElementType> = { start: Play, finish: CheckCircle2, rework: Wrench, view: Eye };

export function MyJobs({ jobs, role, canOpenJobs }: { jobs: MyJob[]; role: string | null | undefined; canOpenJobs: boolean }) {
  return (
    <Card data-testid="my-jobs">
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>My jobs</CardTitle>
        <p className="text-sm text-slate-600">{jobs.length} job{jobs.length === 1 ? "" : "s"}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {jobs.map((job) => <MyJobCard key={job.id} job={job} role={role} canOpenJobs={canOpenJobs} />)}
      </CardContent>
    </Card>
  );
}

function MyJobCard({ job, role, canOpenJobs }: { job: MyJob; role: string | null | undefined; canOpenJobs: boolean }) {
  const action = myJobAction(job, role);
  const Icon = ACTION_ICON[action.kind];
  const tag = reworkTag(job);
  const what = [job.customer, job.description, job.quantity != null ? `qty ${job.quantity}` : ""].filter(Boolean).join(" · ");
  const href = jobHref(job);
  return (
    <article data-testid="my-job" data-job-id={job.id} aria-label={job.jobNo} className="min-w-0 space-y-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-mono text-2xl font-semibold break-all text-ink">{job.jobNo}</p>
        {/* Status, rework and due light: each a badge with its word, never colour alone. */}
        <span className="inline-flex flex-wrap items-center gap-1 text-xs font-semibold">
          <StatusBadge status={JOB_STATUS_BADGE[job.status]} label={JOB_STATUS_LABELS[job.status]} />
          {tag ? <StatusBadge status={tag.status} label={tag.label} /> : null}
          <StatusBadge data-testid="my-job-due" status={job.dueLight} label={DUE_WORD[job.dueLight]} />
        </span>
      </div>
      {what ? <p className="text-base break-words text-ink">{what}</p> : null}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {stageOf(job.stage) ? <div><dt className="inline text-slate-600">Stage </dt><dd className="inline font-semibold text-ink">{stageLabel(job.stage)}</dd></div> : null}
        <div><dt className="inline text-slate-600">Due </dt><dd className="inline font-semibold text-ink">{job.due ? fmtDate(job.due) : DUE_WORD.no_due_date}</dd></div>
      </dl>
      {job.notes ? (
        <div data-testid="my-job-notes" className="border-l-4 border-brand bg-brand-soft px-4 py-3 text-ink">
          <p className="text-sm font-semibold">Specification</p>
          <p className="mt-1 text-base font-medium whitespace-pre-line break-words">{job.notes}</p>
        </div>
      ) : null}
      {canOpenJobs ? (
        <div className="space-y-3">
          <Button asChild className="h-auto min-h-14 w-full whitespace-normal px-4 py-3 text-lg font-semibold pointer-coarse:h-auto pointer-coarse:min-h-14">
            <Link href={href} data-testid="my-job-action" data-kind={action.kind} aria-label={`${action.label}: ${job.jobNo}`}><Icon className="size-5" />{action.label}</Link>
          </Button>
          {myJobOffersPause(job, role) ? (
            <Button asChild variant="outline" className="h-auto min-h-12 w-full whitespace-normal px-4 py-2 text-base font-semibold pointer-coarse:h-auto pointer-coarse:min-h-12 sm:w-auto">
              <Link href={href} data-testid="my-job-pause" aria-label={`Pause or resume ${job.jobNo} on the Job Board`}><PauseCircle className="size-5" />Pause or resume</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
