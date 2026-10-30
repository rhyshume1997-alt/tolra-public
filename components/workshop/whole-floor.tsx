"use client";

/**
 * Whole floor, on the workshop Dashboard: every machine (and the bench) right now, for the workshop tablet. Read-only: a row opens the
 * job on the Job Board (or the schedule for an idle machine) when that page opens for this person; nothing here changes anything.
 * Big rows and words beside every dot, for gloves and a glance across the shop. The shaping is lib/whole-floor.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dueWindow } from "@/lib/dates";
import { supabase } from "@/lib/supabase";
import { useCanOpen } from "@/lib/use-destinations";
import { cn } from "@/lib/utils";
import {
  FLOOR_FAILED, FLOOR_WORDS, countText, dueText, elapsedText, floorDotClass, floorJobIds, sinceText, wholeFloor,
  type FloorRow, type FloorState, type WholeFloor as Floor,
} from "@/lib/whole-floor";

const DASH = "—";
const REFRESH_MS = 60_000;

/** One read; null when it failed (logged, never shown as an empty list). */
async function read(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown[] | null> {
  try {
    const { data, error } = await query;
    if (error) throw error;
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** The existing reads, as the Job Board and the schedule make them: machines and their live state first, then the jobs on them. */
async function loadFloor(): Promise<Floor> {
  const client = supabase;
  if (!client) return FLOOR_FAILED;
  const now = new Date();
  const [machines, inUse, paused, bench, bookings] = await Promise.all([
    read(client.from("machines").select("id, name, active")),
    read(client.rpc("machines_in_use")),
    read(client.rpc("paused_machines")),
    read(client.rpc("bench_runs_state")),
    read(client.from("machine_bookings").select("id, job_id, job_no, machine_id, start_at, status").neq("status", "complete").gte("start_at", now.toISOString()).order("start_at").limit(200)),
  ]);
  const ids = floorJobIds(inUse, paused, bench);
  const jobs = ids.length ? await read(client.from("jobs").select("id, job_no, customer, description, date_required, due_date, finished_at").in("id", ids)) : [];
  return wholeFloor({ machines, inUse, paused, bench, jobs, bookings }, dueWindow(now).today, now);
}

/** A dot with its word beside it: colour is never the only signal. */
function StateWord({ word, className }: { word: FloorState | "late"; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold text-ink", className)} data-testid="floor-state" data-state={word}>
      <span aria-hidden className={cn("inline-block size-3 shrink-0 rounded-full", floorDotClass(word))} data-testid="floor-dot" />
      {FLOOR_WORDS[word].label}
    </span>
  );
}

function Row({ row, floor, now }: { row: FloorRow; floor: Floor; now: Date }) {
  const canOpen = useCanOpen();
  const href = row.job ? `/jobs?job=${encodeURIComponent(row.job.id)}` : "/schedule";
  const linkable = canOpen(row.job ? "/jobs" : "/schedule");
  const since = sinceText(row, now);
  const elapsed = elapsedText(row, now);
  const body = (
    <>
      <div className="flex min-w-0 items-center justify-between gap-3 md:flex-col md:items-start md:justify-center md:gap-1">
        <span className="min-w-0 truncate text-lg font-semibold text-ink">{row.place}</span>
        <StateWord word={row.state} className="text-base" />
      </div>
      <div className="min-w-0 space-y-0.5">
        {row.job ? (
          <>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-lg font-semibold tabular-nums text-ink">{row.job.jobNo}</span>
              {row.job.late ? <StateWord word="late" className="text-base" /> : null}
            </p>
            <p className="truncate text-base text-ink">{row.job.customer ?? DASH}</p>
            {row.job.description ? <p className="truncate text-base text-muted-foreground">{row.job.description}</p> : null}
            <p className="text-base text-muted-foreground">{dueText(row.job, floor.detailsFailed)}</p>
          </>
        ) : <p className="text-base text-muted-foreground">Nothing on it</p>}
      </div>
      <div className="min-w-0">
        {row.state === "idle" ? null : (
          <>
            <p className="truncate text-base text-ink">{row.operator ?? "No name on file"}</p>
            <p className="text-base text-muted-foreground">{since || DASH}</p>
            {elapsed ? <p className="text-xl font-semibold tabular-nums text-ink">{elapsed}</p> : null}
            {row.stale ? <p className="text-sm font-semibold text-ink">Open 12 h+ with no Finish or Pause</p> : null}
          </>
        )}
      </div>
      <div className="min-w-0">
        {row.bench ? null : (
          <>
            <p className="text-sm text-muted-foreground">Next</p>
            <p className="truncate text-base font-semibold text-ink">{row.next === undefined ? DASH : row.next ?? <span className="font-normal text-muted-foreground">Nothing booked</span>}</p>
          </>
        )}
      </div>
      {linkable ? <ChevronRight aria-hidden className="hidden size-6 self-center text-brand-accent md:block" /> : <span className="hidden md:block" />}
    </>
  );
  const cls = "grid min-h-16 grid-cols-1 items-center gap-x-5 gap-y-2 px-4 py-4 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,9rem)_minmax(0,8rem)_1.5rem]";
  const label = `${row.place}: ${FLOOR_WORDS[row.state].label}${row.job ? `, ${row.job.jobNo}` : ""}`;
  return (
    <li className="border-line [&:not(:first-child)]:border-t" data-testid="floor-row" data-state={row.state}>
      {linkable ? <Link href={href} aria-label={label} className={cn(cls, "transition hover:bg-canvas")}>{body}</Link> : <div className={cls}>{body}</div>}
    </li>
  );
}

export function WholeFloor() {
  const [state, setState] = useState<{ floor: Floor | null; loading: boolean; now: Date }>({ floor: null, loading: true, now: new Date() });
  const load = useCallback(async () => {
    const floor = await loadFloor().catch((err) => { console.error(err); return FLOOR_FAILED; });
    setState({ floor, loading: false, now: new Date() });
  }, []);
  const retry = useCallback(() => { setState((s) => ({ ...s, loading: true })); void load(); }, [load]);
  // Read on mount, then every minute while the page is visible, and when the person comes back to it.
  useEffect(() => {
    void load();
    const visible = () => document.visibilityState !== "hidden";
    const timer = window.setInterval(() => { if (visible()) void load(); }, REFRESH_MS);
    const onFocus = () => { if (visible()) void load(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onFocus); };
  }, [load]);

  const { floor, loading, now } = state;
  const failed = Boolean(floor?.failed);
  const counts = loading || !floor ? FLOOR_FAILED.counts : floor.counts;
  const summary: Array<[FloorState | "late", number | null]> = [["running", counts.running], ["paused", counts.paused], ["idle", counts.idle], ["late", counts.late]];
  const retryButton = <Button type="button" variant="outline" className="min-h-12 px-5 text-base" disabled={loading} onClick={retry}>Retry</Button>;

  return (
    <Card data-testid="whole-floor" aria-labelledby="whole-floor-title">
      <CardHeader className="gap-2">
        <CardTitle id="whole-floor-title">Whole floor</CardTitle>
        <p className="text-sm text-muted-foreground">Every machine right now, and anything on the bench. Read-only.</p>
        <ul className="flex flex-wrap gap-x-6 gap-y-2 pt-1" aria-label="On the floor now" data-testid="floor-summary">
          {summary.map(([word, value]) => (
            <li key={word} className="inline-flex items-center gap-2 text-base">
              <span className="text-xl font-semibold tabular-nums text-ink" data-testid={`floor-count-${word}`}>{countText(value)}</span>
              <StateWord word={word} className="font-normal" />
            </li>
          ))}
        </ul>
      </CardHeader>
      <CardContent className="px-0">
        {loading && !floor ? <p className="flex min-h-16 items-center border-y border-line px-4 text-base text-muted-foreground">Loading…</p> : null}
        {failed ? (
          <div role="alert" className="mx-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-4" data-testid="floor-failed">
            <p className="min-w-0 flex-1 basis-60 text-base text-ink">Couldn&apos;t load who is on what. Don&apos;t treat the floor as idle.</p>
            {retryButton}
          </div>
        ) : null}
        {floor && !floor.failed ? (
          <>
            {floor.detailsFailed || floor.nextFailed || floor.benchFailed ? (
              <div role="alert" className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-4" data-testid="floor-partial">
                <p className="min-w-0 flex-1 basis-60 text-base text-ink">
                  {[floor.detailsFailed && "Job details couldn't be loaded.", floor.nextFailed && "What's booked next couldn't be loaded.", floor.benchFailed && "Who is on the bench couldn't be loaded."].filter(Boolean).join(" ")} Dashes show what&apos;s missing.
                </p>
                {retryButton}
              </div>
            ) : null}
            {floor.rows.length ? (
              <ul className="border-y border-line" data-testid="floor-rows">
                {floor.rows.map((row) => <Row key={row.key} row={row} floor={floor} now={now} />)}
              </ul>
            ) : <p className="px-4 py-4 text-base text-muted-foreground">No machines set up yet.</p>}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
