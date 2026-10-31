"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { gbp } from "@/lib/money";
import { COLOUR_TOKENS } from "@/lib/status-colours";

const axis = { tickLine: false, axisLine: false, tick: { fontSize: 12, fill: "var(--muted-foreground)" } } as const;
const kGbp = (value: number) => (Math.abs(value) >= 1000 ? `£${Math.round(value / 100) / 10}k` : `£${Math.round(value)}`);

export const INVOICED_COLOUR = "var(--brand)";
export const RECEIVED_COLOUR = COLOUR_TOKENS.blue.light;

/** Invoiced ex VAT and money received for each month, side by side on ONE money axis (the same unit, so one scale). A month that could not be read has no bar. */
export function CashBars({ data }: { data: Array<{ label: string; invoiced: number | null; received: number | null }> }) {
  const named: Record<string, string> = { invoiced: "Invoiced ex VAT", received: "Received" };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5" style={{ background: INVOICED_COLOUR }} />Invoiced ex VAT</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5" style={{ background: RECEIVED_COLOUR }} />Received</span>
      </div>
      <div className="h-56" data-testid="numbers-cash-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -4 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
            <YAxis {...axis} width={52} tickFormatter={kGbp} />
            <Tooltip cursor={{ fill: "var(--line)", fillOpacity: 0.4 }} formatter={(value, name) => [gbp(Number(value), 0), named[String(name)] ?? String(name)]} />
            <Bar dataKey="invoiced" fill={INVOICED_COLOUR} maxBarSize={22} radius={0} isAnimationActive={false} />
            <Bar dataKey="received" fill={RECEIVED_COLOUR} maxBarSize={22} radius={0} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
