"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";

import { DaySheetPrint } from "@/components/time/time-print";
import { NeedsDatabaseUpdate } from "@/components/time/needs-update";
import { Button } from "@/components/ui/button";
import { loadCompanyPeople } from "@/lib/company-people";
import { friendlyError } from "@/lib/friendly-error";
import { UNKNOWN } from "@/lib/people";
import { supabase } from "@/lib/supabase";
import { type DayFlags, loadDayFlags, pickFlags } from "@/lib/time-day-flags";
import { missingDbObject } from "@/lib/time-features";
import { type TimeData, loadTimeData } from "@/lib/time-data";
import { dayTotals, localDateOf, localDayBounds } from "@/lib/time-sheet";
import { useUser } from "@/lib/use-user";

function DayPrint() {
  const params = useSearchParams();
  const { user, hasAnyRole } = useUser();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? (params.get("date") as string) : localDateOf(new Date());
  const personId = (hasAnyRole(["admin", "office"]) && params.get("user")) || user?.id || null;
  const [data, setData] = useState<TimeData | null>(null);
  const [name, setName] = useState<string>(UNKNOWN);
  const [error, setError] = useState<string | null>(null);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [ticks, setTicks] = useState<DayFlags | null>(null);

  useEffect(() => {
    if (!supabase || !personId) return;
    const bounds = localDayBounds(date);
    Promise.all([loadTimeData(supabase, { userId: personId, from: bounds.start, to: bounds.end }), loadCompanyPeople(supabase)])
      .then(([loaded, people]) => { setData(loaded); setName(people?.[personId] ?? UNKNOWN); })
      .catch((err) => (missingDbObject(err) ? setNeedsUpdate(true) : setError(friendlyError(err, "Couldn't load the hours."))));
  }, [date, personId]);

  // The day's SAVED ticks (074), best effort: nothing is shown before 074 or when they can't be read.
  useEffect(() => {
    setTicks(null);
    if (!supabase || !personId) return;
    let current = true;
    loadDayFlags(supabase, { userId: personId, from: date, to: date })
      .then((r) => { const row = r.rows.find((f) => f.user_id === personId && f.day === date); if (current) setTicks(row ? pickFlags(row) : null); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [date, personId]);

  const day = data ? dayTotals({ date, events: data.events, labour: data.labour, settings: data.settings, bankHolidays: data.bankHolidays, now: Date.now() }) : null;
  return (
    <>
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between">
        <p className="text-sm text-slate-500">A4 portrait, Weekly hours: today. Blank rows are left for handwriting.</p>
        <Button className="bg-[#1E3472] text-white" disabled={!day} onClick={() => window.print()}><Printer className="size-4" /> Print Now</Button>
      </div>
      {needsUpdate ? <div className="no-print mx-auto w-[210mm] max-w-full"><NeedsDatabaseUpdate /></div> : error ? <p className="no-print mx-auto w-[210mm] max-w-full rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</p>
        : day && data ? <DaySheetPrint person={name} day={day} jobs={data.jobs} ticks={ticks} />
        : <p className="text-sm text-slate-500">Loading…</p>}
    </>
  );
}

export default function WeeklyHoursTodayPrintPage() {
  return (
    <div className="bg-white p-4 text-black print:p-0">
      <style>{`
        @media print {
          aside, header, nav, .no-print { display:none!important; }
          html, body { background:white!important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
          @page { size:A4 portrait; margin:10mm; }
          * { box-shadow:none!important; }
        }
      `}</style>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <DayPrint />
      </Suspense>
    </div>
  );
}
