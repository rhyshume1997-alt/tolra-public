"use client";

import Link from "next/link";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { cn } from "@/lib/utils";
import { gbp } from "@/lib/money";
import { COLOUR_TOKENS } from "@/lib/status-colours";
import type { Light } from "@/lib/dashboard-analytics";

/** John's traffic lights take their colours from the one status map (lib/status-colours): green, yellow (amber) and red. */
export const LIGHT_COLOUR: Record<Light, string> = { green: COLOUR_TOKENS.green.light, amber: COLOUR_TOKENS.yellow.light, red: COLOUR_TOKENS.red.light, none: COLOUR_TOKENS.grey.light };
const LIGHT_WORD: Record<Light, string> = { green: "On track", amber: "Watch", red: "Act now", none: "" };

export function LightDot({ light, className }: { light: Light; className?: string }) {
  return <span className={cn("inline-block size-2.5 shrink-0", className)} style={{ background: LIGHT_COLOUR[light] }} role={light === "none" ? undefined : "img"} aria-label={LIGHT_WORD[light] || undefined} aria-hidden={light === "none" ? true : undefined} />;
}

/** A flat, square panel: title on the left, one line of context on the right, the chart or list below. */
export function Panel({ title, meta, href, children, className }: { title: string; meta?: React.ReactNode; href?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col border border-line bg-surface", className)}>
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-[0.95rem] font-semibold text-ink">{href ? <Link href={href} className="hover:underline">{title}</Link> : title}</h2>
        {meta ? <span className="text-right text-[0.8125rem] text-muted-foreground tabular-nums">{meta}</span> : null}
      </header>
      <div className="min-h-0 flex-1 px-4 py-3">{children}</div>
    </section>
  );
}

const axis = { tickLine: false, axisLine: false, tick: { fontSize: 12, fill: "var(--muted-foreground)" } } as const;
const kGbp = (value: number) => (Math.abs(value) >= 1000 ? `£${Math.round(value / 100) / 10}k` : `£${Math.round(value)}`);

/** Money received per month, as a line with a light fill under it. */
export function RevenueLine({ data }: { data: Array<{ month: string; revenue: number }> }) {
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="month" {...axis} />
          <YAxis {...axis} width={52} tickFormatter={kGbp} />
          <Tooltip cursor={{ stroke: "var(--line)" }} formatter={(value) => [gbp(Number(value), 0), "Received"]} />
          <Area type="linear" dataKey="revenue" stroke="var(--brand)" strokeWidth={2.5} fill="var(--brand)" fillOpacity={0.08} dot={{ r: 3, fill: "var(--brand)", strokeWidth: 0 }} activeDot={{ r: 5 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** One horizontal bar per row, coloured by its traffic light (or a fixed colour), with the figure on the right. */
export function BarList({ rows, format = String, empty }: { rows: Array<{ key: string; label: string; value: number; light?: Light; colour?: string; href?: string }>; format?: (value: number) => string; empty?: string }) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  if (!rows.length || max === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{empty ?? "Nothing to show yet."}</p>;
  return (
    <ul className="divide-y divide-line/70">
      {rows.map((row) => {
        const label = row.href ? <Link href={row.href} className="hover:underline">{row.label}</Link> : row.label;
        return (
          <li key={row.key} className="grid grid-cols-[minmax(7rem,11rem)_1fr_auto] items-center gap-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-ink">{row.light ? <LightDot light={row.light} /> : null}<span className="truncate">{label}</span></span>
            <span className="h-3 bg-canvas"><span className="block h-full" style={{ width: `${(row.value / max) * 100}%`, background: row.colour ?? (row.light ? LIGHT_COLOUR[row.light] : "var(--brand)") }} /></span>
            <span className="min-w-12 text-right font-semibold tabular-nums text-ink">{format(row.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** One bar split by share (e.g. money owed by age), each part in its traffic-light colour. */
export function SplitBar({ parts }: { parts: Array<{ key: string; label: string; value: number; light: Light }> }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total <= 0) return <div className="h-6 bg-canvas" aria-label="Nothing owed" role="img" />;
  return (
    <div className="flex h-6" role="img" aria-label={parts.filter((p) => p.value > 0).map((p) => `${p.label} ${gbp(p.value, 0)}`).join(", ")}>
      {parts.filter((part) => part.value > 0).map((part) => <span key={part.key} className="block h-full" style={{ width: `${(part.value / total) * 100}%`, background: LIGHT_COLOUR[part.light] }} />)}
    </div>
  );
}

/** On-time delivery per month as a line, with the target drawn across. */
export function PercentLine({ data, target }: { data: Array<{ month: string; percent: number | null }>; target: number }) {
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="month" {...axis} />
          <YAxis {...axis} width={44} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => `${value}%`} />
          <ReferenceLine y={target} stroke={COLOUR_TOKENS.green.light} strokeDasharray="4 4" label={{ value: `Target ${target}%`, position: "insideBottomRight", fontSize: 11, fill: "var(--muted-foreground)" }} />
          <Tooltip formatter={(value) => [value === null ? "No dated jobs" : `${value}%`, "On time"]} />
          <Line type="linear" dataKey="percent" stroke="var(--brand)" strokeWidth={2.5} connectNulls dot={{ r: 3, fill: "var(--brand)", strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Jobs coming due per day over the next two weeks; today and overdue days stand out. */
export function DueColumns({ data }: { data: Array<{ date: string; count: number }> }) {
  const rows = data.map((day) => ({ ...day, label: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "Europe/London" }).format(new Date(`${day.date}T12:00:00Z`)) }));
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -24 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="label" {...axis} interval={1} />
          <YAxis {...axis} allowDecimals={false} width={40} />
          <Tooltip cursor={{ fill: "var(--canvas)" }} formatter={(value) => [`${value} job${Number(value) === 1 ? "" : "s"}`, "Due"]} />
          <Bar dataKey="count" fill="var(--brand)" maxBarSize={28} radius={0} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
