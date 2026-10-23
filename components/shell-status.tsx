"use client";

import { useCompanyProfile } from "@/lib/company";
import { useOfflineStatus } from "@/lib/offline/scope";
import { connectionState, roleLabel, shellStatusSummary } from "@/lib/shell-status";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/use-user";

function initials(name?: string | null, email?: string | null) {
  const fromName = name?.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2);
  return (fromName || email?.[0] || "").toUpperCase();
}

/** The connection dot: green online, amber offline or changes waiting. */
export function ConnectionDot({ tone, className }: { tone: "good" | "warn"; className?: string }) {
  return <span aria-hidden data-testid="connection-dot" data-tone={tone} className={cn("size-2.5 shrink-0 rounded-full", tone === "good" ? "bg-emerald-500" : "bg-amber-500", className)} />;
}

/**
 * Who is working (view and company) and whether the device is connected, in the top bar while the sidebar is a drawer
 * (up to 1024px). One small control, not an extra row: initials with a connection dot, plus view / connection and the
 * company name once there is room. It opens the drawer, which holds the full detail.
 */
export function ShellStatusChip({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const { profile, activeRole } = useUser();
  const { profile: company } = useCompanyProfile();
  const status = useOfflineStatus();
  const connection = connectionState(status);
  const summary = shellStatusSummary({ role: activeRole, company: company?.name, connection });

  return (
    <button
      type="button"
      data-testid="shell-status"
      data-connection={connection.kind}
      aria-label={summary}
      title={summary}
      onClick={onOpen}
      className={cn("flex h-9 min-w-9 max-w-[15rem] items-center gap-2 rounded-full pr-1 text-left outline-none transition hover:bg-ink/[0.06] focus-visible:ring-3 focus-visible:ring-brand-accent/35 pointer-coarse:h-11 pointer-coarse:min-w-11 sm:pr-3", className)}
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-accent text-xs font-semibold text-white pointer-coarse:size-9">
        {initials(profile?.full_name, profile?.email)}
        <ConnectionDot tone={connection.tone} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-canvas" />
      </span>
      <span className="hidden min-w-0 flex-col sm:flex">
        <span className="label-mono truncate text-ink">{roleLabel(activeRole)} <span className="text-muted-foreground">· {connection.label}</span></span>
        {company ? <span className="truncate text-xs text-muted-foreground">{company.name}</span> : null}
      </span>
    </button>
  );
}
