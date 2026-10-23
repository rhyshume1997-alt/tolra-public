"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";

import { WeekSummaryPrint } from "@/components/time/time-print";
import { NeedsDatabaseUpdate } from "@/components/time/needs-update";
import { Button } from "@/components/ui/button";
import { loadCompanyPeople } from "@/lib/company-people";
import { friendlyError } from "@/lib/friendly-error";
import { type PeopleMap, UNKNOWN } from "@/lib/people";
import { supabase } from "@/lib/supabase";
import { missingDbObject } from "@/lib/time-features";
import { type TimeSettings, localDateOf, weekStartOf } from "@/lib/time-sheet";
import { type PersonWeek, WEEK_STATE_TEXT, loadWeek } from "@/lib/time-week";
import { useUser } from "@/lib/use-user";

/** One page per person: the week's days with paid hours and the day ticks, the totals and the approval (or "not approved"). */
function WeekPrint() {
  const params = useSearchParams();
  const { user, hasAnyRole } = useUser();
  const week = weekStartOf(/^\d{4}-\d{2}-\d{2}$/.test(params.get("week") ?? "") ? (params.get("week") as string) : localDateOf(new Date()));
  const userId = hasAnyRole(["admin", "office"]) ? params.get("user") : user?.id ?? null;
  const [people, setPeople] = useState<PersonWeek[] | null>(null);
  const [settings, setSettings] = useState<TimeSettings | null>(null);
  const [names, setNames] = useState<PeopleMap>({});
  const [error, setError] = useState<string | null>(null);
  const [needsUpdate, setNeedsUpdate] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    Promise.all([loadWeek(supabase, week, userId), loadCompanyPeople(supabase)])
      .then(([loaded, who]) => { setPeople(loaded.people.filter((p) => p.week.daysWorked > 0 || p.week.labour > 0)); setSettings(loaded.data.settings); if (who) setNames(who); })
      .catch((err) => (missingDbObject(err) ? setNeedsUpdate(true) : setError(friendlyError(err, "Couldn't load the week."))));
  }, [week, userId]);

  const approval = (p: PersonWeek) => {
    const s = p.status;
    if (!s || s.state === "not_approved") return `${WEEK_STATE_TEXT.not_approved}`;
    const when = s.approved_at ? new Date(s.approved_at).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" }) : "";
    return `${names[s.approved_by ?? ""] ?? UNKNOWN}, ${when}${s.state === "changed_since_approval" ? " (changed since approval)" : ""}`;
  };
  return (
    <>
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between">
        <p className="text-sm text-slate-500">A4 portrait, one page per person. Hours only: no rates or pay.</p>
        <Button className="bg-[#1E3472] text-white" disabled={!people?.length} onClick={() => window.print()}><Printer className="size-4" /> Print Now</Button>
      </div>
      {needsUpdate ? <div className="no-print mx-auto w-[210mm] max-w-full"><NeedsDatabaseUpdate /></div> : error ? <p className="no-print mx-auto w-[210mm] max-w-full rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</p>
        : people && settings ? (people.length
          ? people.sort((a, b) => (names[a.userId] ?? "").localeCompare(names[b.userId] ?? "")).map((p) => <WeekSummaryPrint key={p.userId} person={names[p.userId] ?? UNKNOWN} week={p.week} approval={p.status && p.status.state !== "not_approved" ? approval(p) : null} dayFlags={p.dayFlags} />)
          : <p className="text-sm text-slate-500">Nobody recorded time this week.</p>)
        : <p className="text-sm text-slate-500">Loading…</p>}
    </>
  );
}

export default function WeeklyHoursPrintPage() {
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
        <WeekPrint />
      </Suspense>
    </div>
  );
}
