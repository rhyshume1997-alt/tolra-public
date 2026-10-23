import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The two screens of the "Weekly hours" menu item: "Today" (one person's day: clock in and out, breaks, the jobs worked) and
 * "This week" (the week's paid hours per person, and approval). "Job sheet" now means only a job's own sheet.
 */
export function HoursTabs({ active, todayHref = "/time", weekHref }: { active: "today" | "week"; todayHref?: string; weekHref: string }) {
  const tab = (key: "today" | "week", label: string, href: string) => (
    <Link
      key={key}
      href={href}
      role="tab"
      aria-selected={active === key}
      aria-current={active === key ? "page" : undefined}
      className={cn("rounded-md px-3 py-1.5 text-sm font-medium", active === key ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950")}
    >
      {label}
    </Link>
  );
  return (
    <div role="tablist" aria-label="Weekly hours" data-testid="hours-tabs" className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
      {tab("today", "Today", todayHref)}
      {tab("week", "This week", weekHref)}
    </div>
  );
}
