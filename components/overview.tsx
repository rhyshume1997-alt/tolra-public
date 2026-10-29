"use client";

/**
 * The owner's Overview on the admin Dashboard: a sticky row of jump links, the leaks row, and the section headings
 * (Today, Money, Work, Machines, People). The figures come from the Dashboard's own reads and lib/overview.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { LightDot } from "@/components/dashboard-charts";
import { useCanOpen } from "@/lib/use-destinations";
import { OVERVIEW_SECTIONS, type Leak } from "@/lib/overview";

/** Jump links to each section; the one in view is marked. Sections that are hidden by the Columns picker are left out. */
export function OverviewJump({ present }: { present: string[] }) {
  const [current, setCurrent] = useState<string>(present[0] ?? "today");
  useEffect(() => {
    const nodes = present.map((id) => document.getElementById(id)).filter((n): n is HTMLElement => Boolean(n));
    if (!nodes.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const shown = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (shown[0]) setCurrent(shown[0].target.id);
    }, { rootMargin: "-140px 0px -55% 0px" });
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [present]);
  const links = OVERVIEW_SECTIONS.filter((s) => present.includes(s.id));
  if (links.length < 2) return null;
  return (
    <nav aria-label="Jump to" className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1 border-b border-line bg-canvas/95 px-1 py-2 backdrop-blur" data-testid="overview-jump">
      {links.map((s) => (
        <a key={s.id} href={`#${s.id}`} aria-current={current === s.id ? "true" : undefined}
          className={`px-3 py-1.5 text-sm font-semibold transition ${current === s.id ? "bg-surface text-ink ring-1 ring-line" : "text-muted-foreground hover:bg-surface hover:text-ink"}`}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}

/** One section of the Overview: a heading, a line of context, an optional link, then its panels. */
export function OverviewSection({ id, title, sub, href, linkLabel, children }: { id: string; title: string; sub: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  const canOpen = useCanOpen();
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-16 space-y-4" data-testid={`overview-${id}`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">{title}</h2>
        <p className="text-sm text-muted-foreground">{sub}</p>
        {href && linkLabel && canOpen(href) ? <Link href={href} className="ml-auto text-sm font-semibold text-brand-accent hover:underline">{linkLabel}</Link> : null}
      </header>
      {children}
    </section>
  );
}

/** The leaks row: where work and money are slipping right now, each a link to the list that fixes it. */
export function OverviewLeaks({ leaks }: { leaks: Leak[] }) {
  const canOpen = useCanOpen();
  return (
    <div className="grid border border-line bg-surface sm:grid-cols-2 lg:grid-cols-5" data-testid="overview-leaks">
      {leaks.map((leak) => {
        // A leak whose read failed has nowhere honest to go, so it isn't a link
        const linkable = !leak.failed && leak.href !== "#" && canOpen(leak.href);
        const body = (
          <>
            <span className="flex items-center justify-between gap-2 text-sm font-semibold text-ink">
              {leak.label}
              {leak.alarm ? <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-red-700"><LightDot light="red" />{leak.alarm}</span> : null}
            </span>
            <span className="text-[1.875rem] font-semibold leading-none tracking-tight tabular-nums text-ink" data-testid={`leak-count-${leak.id}`}>
              {leak.count === null ? "—" : leak.count}
              {leak.extra ? <span className="ml-2 text-base font-semibold tracking-normal text-ink/75">{leak.extra}</span> : null}
            </span>
            <span className="text-[0.8125rem] text-muted-foreground">{leak.detail}</span>
            {linkable ? <span className="text-[0.8125rem] font-semibold text-brand-accent">{leak.action}</span> : null}
          </>
        );
        const cls = "flex min-w-0 flex-col gap-1.5 border-line p-4 sm:[&:not(:last-child)]:border-r max-sm:[&:not(:last-child)]:border-b";
        return linkable
          ? <Link key={leak.id} href={leak.href} className={`${cls} transition hover:bg-canvas`} data-testid={`leak-${leak.id}`}>{body}</Link>
          : <div key={leak.id} className={cls} data-testid={`leak-${leak.id}`}>{body}</div>;
      })}
    </div>
  );
}
