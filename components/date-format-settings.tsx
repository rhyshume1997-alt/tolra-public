"use client";

import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { CalendarDays } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useDateFormat, saveDateFormat } from "@/lib/date-format-preference";
import { DATE_MONTHS, DATE_MONTH_LABELS, DATE_ORDERS, DATE_ORDER_LABELS, type DateMonth, type DateOrder, dateFormatOf, dateFormatParts, fmtDate, fmtDateTime } from "@/lib/dates";
import { NEEDS_DATABASE_UPDATE, missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { useUser } from "@/lib/use-user";

/**
 * Account Settings > Date format (migration 109): the signed-in person's own choice of order and month, with every option previewed
 * on today's date. Saved to their own row only; it changes how dates show for them alone, on screen and on what they print. Exports
 * (CSV, Excel) stay ISO and date pickers stay the browser's own.
 */
export function DateFormatSettings() {
  const { user } = useUser();
  const saved = useDateFormat();
  const [order, setOrder] = useState<DateOrder>(dateFormatParts(saved).order);
  const [month, setMonth] = useState<DateMonth>(dateFormatParts(saved).month);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [today] = useState(() => new Date());
  const id = useId();
  useEffect(() => {
    setOrder(dateFormatParts(saved).order);
    setMonth(dateFormatParts(saved).month);
  }, [saved]);

  const chosen = dateFormatOf(order, month);
  const changed = chosen !== saved;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id || !changed) return;
    setSaving(true);
    setProblem(null);
    try {
      await saveDateFormat(user.id, chosen);
      toast.success(`Saved. The new date format (${fmtDate(today, chosen)}) shows as you move between pages.`);
    } catch (err) {
      setProblem(missingDbObject(err as { code?: string; message?: string }) ? NEEDS_DATABASE_UPDATE : friendlyError(err, "Couldn't save your date format. Try again."));
    } finally {
      setSaving(false);
    }
  }

  const option = "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 has-[:checked]:border-brand has-[:checked]:bg-brand/10";
  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3" data-testid="date-format-settings" noValidate>
      <div className="flex items-center gap-2 font-semibold text-slate-950"><CalendarDays className="size-4" />Date format</div>
      <p className="text-slate-500">How dates show for you on screen and on what you print. Only you see this choice. Exports (CSV, Excel) stay YYYY-MM-DD.</p>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-slate-700">Order</legend>
        {DATE_ORDERS.map((o) => (
          <label key={o} className={option}>
            <input type="radio" name={`${id}-order`} value={o} checked={order === o} onChange={() => setOrder(o)} className="size-4 accent-brand" />
            <span className="min-w-0 flex-1 font-medium">{DATE_ORDER_LABELS[o]}</span>
            <span className="text-slate-500" data-testid={`date-order-preview-${o}`}>{fmtDate(today, dateFormatOf(o, month))}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-slate-700">Month</legend>
        {DATE_MONTHS.map((m) => (
          <label key={m} className={option}>
            <input type="radio" name={`${id}-month`} value={m} checked={month === m} onChange={() => setMonth(m)} className="size-4 accent-brand" />
            <span className="min-w-0 flex-1 font-medium">{DATE_MONTH_LABELS[m]}</span>
            <span className="text-slate-500" data-testid={`date-month-preview-${m}`}>{fmtDate(today, dateFormatOf(order, m))}</span>
          </label>
        ))}
      </fieldset>
      <p className="rounded-lg bg-slate-50 p-3 text-slate-700" aria-live="polite">
        Preview: <span className="font-semibold text-slate-950" data-testid="date-format-preview">{fmtDateTime(today, chosen)}</span>
      </p>
      {problem ? <p role="alert" className="text-sm text-red-700">{problem}</p> : null}
      <Button type="submit" disabled={!changed || saving || !user?.id} className="min-h-11 w-full bg-brand text-brand-ink hover:bg-brand-hover">
        {saving ? "Saving..." : changed ? "Save date format" : "Saved"}
      </Button>
    </form>
  );
}
