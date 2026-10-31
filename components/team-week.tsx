"use client";

import { useEffect, useState } from "react";

import { LightDot, Panel } from "@/components/dashboard-charts";
import type { Light } from "@/lib/dashboard-analytics";
import { loadCompanyPeople } from "@/lib/company-people";
import { supabase } from "@/lib/supabase";
import { teamRows, type NowState, type TeamRow } from "@/lib/team-week";
import { hm, localDateOf, localTimeOf, weekStartOf } from "@/lib/time-sheet";
import { loadWeek } from "@/lib/time-week";

// On a job is "running" (blue in the status map; green is kept for completed work).
const NOW_LIGHT: Record<NowState["state"], Light> = { on_job: "blue", clocked_in: "amber", on_break: "amber", out: "none" };

function nowText(now: NowState) {
  if (now.state === "on_job") return `On ${now.jobNo} since ${localTimeOf(now.since)}`;
  if (now.state === "on_break") return `On a break since ${localTimeOf(now.since)}`;
  if (now.state === "clocked_in") return `Clocked in, not on a job, since ${localTimeOf(now.since)}`;
  return "Not clocked in";
}

/**
 * John's team view: this week per person, busiest first. Only the admin Dashboard renders it (lib/team-week explains why).
 * Reads the same records as Weekly hours, so the hours here and there always agree.
 */
export function TeamWeek() {
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const client = supabase;
    if (!client) { setFailed(true); return; }
    const weekStart = weekStartOf(localDateOf(new Date()));
    Promise.all([
      loadWeek(client, weekStart, null),
      loadCompanyPeople(client, { usernames: true }),
      client.from("jobs").select("finished_by").gte("finished_at", `${weekStart}T00:00:00`),
    ]).then(([week, names, finished]) => {
      if (!active) return;
      const jobNos = Object.fromEntries(Object.values(week.data.jobs).map((job) => [job.id, job.job_no]));
      setRows(teamRows({
        people: week.people,
        events: week.data.events,
        labour: week.data.labour,
        jobNos,
        finishedBy: finished.error ? [] : ((finished.data ?? []) as Array<{ finished_by: string | null }>).map((row) => row.finished_by),
        names: names ?? {},
      }));
    }).catch((err) => {
      console.error(err);
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, []);

  const most = rows ? Math.max(0, ...rows.map((row) => row.jobMinutes)) : 0;
  const totalJob = rows ? rows.reduce((sum, row) => sum + row.jobMinutes, 0) : 0;

  return (
    <Panel title="Team this week" meta={rows ? `${hm(totalJob)} on jobs · only admins see this` : "Only admins see this"} href="/time/week">
      {!rows ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{failed ? "Couldn't load the team's time." : "Loading…"}</p>
      ) : !rows.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nobody has clocked in this week yet.</p>
      ) : (
        <div className="-mx-4">
          <table role="table" className="w-full text-sm desk:min-w-[44rem]" data-tablet-cards>
            <thead role="rowgroup" className="hidden md:table-header-group">
              <tr role="row" className="border-b border-line text-left text-[0.8125rem] text-muted-foreground">
                <th role="columnheader" className="px-4 py-2 font-medium">Person</th>
                <th role="columnheader" className="px-2 py-2 font-medium">Right now</th>
                <th role="columnheader" className="w-[30%] px-2 py-2 font-medium">Time on jobs</th>
                <th role="columnheader" className="px-2 py-2 text-right font-medium">Paid hours</th>
                <th role="columnheader" className="px-2 py-2 text-right font-medium" title="Share of clocked time spent on jobs">On jobs</th>
                <th role="columnheader" className="px-4 py-2 text-right font-medium">Jobs finished</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="divide-y divide-line/70">
              {rows.map((row) => (
                <tr role="row" key={row.userId} className="block md:table-row">
                  <td role="cell" className="block px-4 py-2.5 font-semibold text-ink md:table-cell">
                    {row.name}
                    <span className="block text-xs font-normal text-muted-foreground">{row.daysWorked} day{row.daysWorked === 1 ? "" : "s"} worked</span>
                  </td>
                  <td role="cell" data-label="Right now" className="block px-4 py-2.5 md:table-cell desk:px-2"><span className="inline-flex items-center gap-2 text-ink"><LightDot light={NOW_LIGHT[row.now.state]} />{nowText(row.now)}</span></td>
                  <td role="cell" data-label="Time on jobs" className="block px-4 py-2.5 md:table-cell desk:px-2">
                    <span className="flex items-center gap-2">
                      <span className="h-3 flex-1 bg-canvas"><span className="block h-full bg-brand" style={{ width: `${most ? (row.jobMinutes / most) * 100 : 0}%` }} /></span>
                      <span className="w-14 text-right font-semibold tabular-nums text-ink">{hm(row.jobMinutes)}</span>
                    </span>
                  </td>
                  <td role="cell" data-label="Paid hours" className="block px-4 py-2.5 tabular-nums text-ink md:table-cell desk:px-2 desk:text-right">{hm(row.paidMinutes)}</td>
                  <td role="cell" data-label="On jobs" className="block px-4 py-2.5 tabular-nums text-ink md:table-cell desk:px-2 desk:text-right">{row.onJobsPercent === null ? "—" : `${row.onJobsPercent}%`}</td>
                  <td role="cell" data-label="Jobs finished" className="block px-4 py-2.5 font-semibold tabular-nums text-ink md:table-cell desk:text-right">{row.jobsFinished}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
