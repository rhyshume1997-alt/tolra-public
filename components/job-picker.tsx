"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { PICKER_LIMIT, type PickerJob, findJobs } from "@/lib/job-picker";
import { supabase } from "@/lib/supabase";

/**
 * Pick a job from this company's jobs: a search box (job number or customer, searched in the database, newest first) and the list it
 * finds. The chosen job stays in the list while the search changes. `name` is the select's form field name (the job's number is its value
 * when `valueIs` is "job_no", its id when "id").
 */
export function JobPicker({ name, selected, active, includeInternal, valueIs, emptyLabel, onPick, className }: {
  name: string;
  selected: PickerJob | null;
  /** Load only while the form is open. */
  active: boolean;
  includeInternal: boolean;
  valueIs: "id" | "job_no";
  emptyLabel: string;
  onPick: (job: PickerJob | null) => void;
  className?: string;
}) {
  const [term, setTerm] = useState("");
  const [jobs, setJobs] = useState<PickerJob[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = (job: PickerJob) => (valueIs === "id" ? job.id : job.job_no);

  useEffect(() => {
    if (!supabase || !active) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void findJobs(supabase as never, term, { includeInternal }).then((found) => {
        if (!current) return;
        setJobs(found.jobs);
        setTruncated(found.truncated);
        setFailed(found.failed);
      });
    }, term ? 250 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [active, term, includeInternal]);

  const options = selected && !jobs.some((job) => key(job) === key(selected)) ? [selected, ...jobs] : jobs;
  return (
    <div className="grid gap-1">
      <Input aria-label="Search by number or customer" placeholder="Search by job number or customer" value={term} onChange={(event) => setTerm(event.target.value)} className="h-9" />
      <select
        name={name}
        aria-label="Job"
        value={selected ? key(selected) : ""}
        onChange={(event) => onPick(options.find((job) => key(job) === event.target.value) ?? null)}
        className={className ?? "h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"}
      >
        <option value="">{failed ? "Couldn't load the jobs" : emptyLabel}</option>
        {options.map((job) => <option key={job.id} value={key(job)}>{job.job_no}{job.customer ? ` - ${job.customer}` : ""}{job.internal ? " (internal)" : ""}</option>)}
      </select>
      {truncated ? <p className="text-xs text-slate-500" data-testid="job-picker-more">Showing the first {PICKER_LIMIT} jobs, newest first. Type a job number or customer to find an older one.</p> : null}
    </div>
  );
}
