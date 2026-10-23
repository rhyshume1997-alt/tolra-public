"use client";

import type { CSSProperties, ReactNode } from "react";

import { PrintLogo } from "@/components/print-logo";
import { clockTime, dayHeading } from "@/components/time/day-sheet";
import { useCompanyProfile } from "@/lib/company";
import { DAY_FLAG_KEYS, DAY_FLAG_LABEL, type DayFlags, type WeekDayFlags, flagsShort } from "@/lib/time-day-flags";
import type { JobInfo } from "@/lib/time-data";
import { type DayTotals, type WeekTotals, FLAG_TEXT, hm, hmSigned } from "@/lib/time-sheet";

const exact: CSSProperties = { WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" };
const HEAD = "#cfd9e8";

function Header({ title, person, when }: { title: string; person: string; when: string }) {
  const { profile: company } = useCompanyProfile();
  return (
    <div className="mb-2 flex items-end justify-between border-b-2 border-black pb-1">
      <div className="flex items-end gap-3">
        <PrintLogo company={company} className="h-12 w-auto max-w-[40mm] object-contain" />
        <div>
          <div className="text-[18px] font-bold uppercase">{title}</div>
          <div className="text-[11px]">{company?.name ?? ""}</div>
        </div>
      </div>
      <div className="text-right text-[12px]"><div className="font-bold">{person}</div><div>{when}</div></div>
    </div>
  );
}

function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return <th className={`border border-black px-1.5 py-1 text-[10px] font-bold uppercase ${right ? "text-right" : "text-left"}`} style={{ background: HEAD, ...exact }}>{children}</th>;
}
function Td({ children, right, mono }: { children?: ReactNode; right?: boolean; mono?: boolean }) {
  return <td className={`border border-black px-1.5 py-1 text-[11px] ${right ? "text-right" : ""} ${mono ? "font-mono" : ""}`}>{children}</td>;
}

function Signatures({ approved }: { approved?: string | null }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-6 text-[11px]">
      <div className="border-t border-black pt-1">Employee signature</div>
      <div className="border-t border-black pt-1">Approved by{approved ? `: ${approved}` : ""}</div>
    </div>
  );
}

/**
 * One person's day, A4 portrait, in the style of the worksheet print (bordered table, blue-grey headings). Paid hours only: no basic and
 * overtime split (overtime is the Overtime tick). `ticks`: the day's SAVED ticks (074); null when none are saved or the database has no 074.
 */
export function DaySheetPrint({ person, day, jobs, ticks = null }: { person: string; day: DayTotals; jobs: Record<string, JobInfo>; ticks?: DayFlags | null }) {
  return (
    <div className="mx-auto w-[210mm] bg-white text-black print:w-full" style={{ ...exact, fontFamily: "Arial, Helvetica, sans-serif" }} data-testid="day-sheet-print">
      <Header title="Weekly hours: today" person={person} when={`${dayHeading(day.date)}${day.bankHolidayName ? ` (${day.bankHolidayName})` : ""}`} />
      <table className="mb-3 w-full border-collapse">
        <thead><tr><Th>Clock in</Th><Th>Clock out</Th><Th>Breaks</Th><Th right>Hours</Th></tr></thead>
        <tbody>
          {day.sessions.length ? day.sessions.map((s, i) => (
            <tr key={i}>
              <Td mono>{s.start !== null ? clockTime(s.start, day.date) : "missing"}</Td>
              <Td mono>{s.end !== null ? clockTime(s.end, day.date) : s.flags.includes("open") ? "still in" : "missing"}</Td>
              <Td mono>{s.breaks.map((b) => `${clockTime(b.start, day.date)}–${clockTime(b.end, day.date)}`).join(", ")}</Td>
              <Td right mono>{s.start !== null && s.countedEnd !== null ? hm((s.countedEnd - s.start) / 60_000) : ""}</Td>
            </tr>
          )) : <tr><Td>—</Td><Td>—</Td><Td /><Td right mono>0:00</Td></tr>}
        </tbody>
      </table>
      <table className="mb-3 w-full border-collapse">
        <thead><tr><Th>Job</Th><Th>Customer / description</Th><Th>Times</Th><Th right>Time</Th><Th right>Share</Th></tr></thead>
        <tbody>
          {day.jobs.length ? day.jobs.map((line) => {
            const job = jobs[line.jobId];
            return (
              <tr key={line.jobId}>
                <Td>{job?.job_no ?? "Job"}</Td>
                <Td>{[job?.customer, job?.description].filter(Boolean).join(" · ")}</Td>
                <Td mono>{line.sessions.map((s) => `${clockTime(s.started_at, day.date)}–${s.ended_at ? clockTime(s.ended_at, day.date) : "now"}`).join(", ")}</Td>
                <Td right mono>{hm(line.minutes)}</Td>
                <Td right mono>{hm(line.allocatedMinutes)}</Td>
              </tr>
            );
          }) : null}
          {/* Blank rows for handwriting, as the worksheet print leaves them. */}
          {Array.from({ length: Math.max(0, 6 - day.jobs.length) }, (_, i) => <tr key={`blank-${i}`} className="h-[8mm]"><Td /><Td /><Td /><Td /><Td /></tr>)}
        </tbody>
      </table>
      <table className="w-full border-collapse">
        <thead><tr><Th>Clocked</Th><Th>Breaks</Th><Th>Paid</Th><Th>On jobs</Th><Th>Not on a job</Th></tr></thead>
        <tbody><tr>
          <Td mono>{hm(day.attendance)}</Td><Td mono>{hmSigned(-day.breakDeduction)}</Td><Td mono>{hm(day.paid)}</Td>
          <Td mono>{hm(day.labour)}</Td><Td mono>{hm(day.unallocated)}</Td>
        </tr></tbody>
      </table>
      {ticks && DAY_FLAG_KEYS.some((k) => ticks[k]) ? <p className="mt-2 text-[11px]" data-testid="day-print-ticks"><strong>Day ticks:</strong> {DAY_FLAG_KEYS.filter((k) => ticks[k]).map((k) => DAY_FLAG_LABEL[k]).join(", ")}.</p> : null}
      {day.flags.length ? <p className="mt-2 text-[11px]"><strong>Check:</strong> {day.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}.</p> : null}
      <Signatures />
    </div>
  );
}

/**
 * One person's week: a row per day with paid hours and the day's ticks, the week's totals, the approval. A4 portrait. `dayFlags` (074): the
 * day ticks per day and, per type, the days and paid hours on them (no rates); null before 074 (the column is left out).
 */
export function WeekSummaryPrint({ person, week, approval, dayFlags = null }: { person: string; week: WeekTotals; approval: string | null; dayFlags?: WeekDayFlags | null }) {
  return (
    <div className="mx-auto mb-6 w-[210mm] bg-white text-black print:mb-0 print:w-full print:break-after-page" style={{ ...exact, fontFamily: "Arial, Helvetica, sans-serif" }} data-testid="week-summary-print">
      <Header title="Weekly hours: week" person={person} when={`Week of ${dayHeading(week.weekStart)}`} />
      <table className="w-full border-collapse">
        <thead><tr><Th>Day</Th><Th right>Clocked</Th><Th right>Breaks</Th><Th right>Paid</Th><Th right>On jobs</Th>{dayFlags ? <Th>Ticks</Th> : null}<Th>Check</Th></tr></thead>
        <tbody>
          {week.days.map((d, i) => (
            <tr key={d.date}>
              <Td>{dayHeading(d.date)}{d.bankHolidayName ? ` (${d.bankHolidayName})` : ""}</Td>
              <Td right mono>{hm(d.attendance)}</Td><Td right mono>{d.breakDeduction ? hmSigned(-d.breakDeduction) : ""}</Td>
              <Td right mono>{hm(d.paid)}</Td><Td right mono>{hm(d.labour)}</Td>
              {dayFlags ? <Td>{flagsShort(dayFlags.days[i].flags)}{dayFlags.days[i].source === "suggested" ? " *" : ""}</Td> : null}
              <Td>{d.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}</Td>
            </tr>
          ))}
          <tr className="font-bold">
            <Td>Week ({week.daysWorked} day{week.daysWorked === 1 ? "" : "s"} worked)</Td>
            <Td right mono>{hm(week.attendance)}</Td><Td right mono>{hmSigned(-week.breakDeduction)}</Td><Td right mono>{hm(week.paid)}</Td>
            <Td right mono>{hm(week.labour)}</Td>{dayFlags ? <Td /> : null}<Td />
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[11px]">Paid {hm(week.paid)} h. Overtime is not worked out: it is the days ticked Overtime. Hours only: no rates or pay.</p>
      {dayFlags ? (
        <p className="mt-1 text-[11px]" data-testid="week-print-day-flags">
          <strong>Day ticks</strong> (saved; days, and paid hours on those days): {DAY_FLAG_KEYS.map((k) => `${DAY_FLAG_LABEL[k]} ${dayFlags.totals[k].days} (${hm(dayFlags.totals[k].paidMinutes)} h)`).join(" · ")}.
          {dayFlags.anySuggested ? " * suggested from the date, not saved, not counted." : ""}
        </p>
      ) : null}
      <Signatures approved={approval} />
    </div>
  );
}
