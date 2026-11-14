import Link from "next/link";
import type { ReactNode } from "react";

import type { PortalPermission } from "@/lib/portal/types";

/**
 * BOUNDARY: components/portal/portal-frame.tsx (server component). Inputs: a title, children, and (when signed in) who and which tabs.
 * Output: the portal page frame. Tabs appear only for the permissions given. Every link has prefetch off so a prefetch cannot restart the
 * idle clock. Sign-out is a POST form to /api/portal/signout. Must not link to the staff app or show ids, e-mail or tokens.
 */
export type PortalFrameProps = { title: string; children: ReactNode; signedIn?: { displayName: string; companyName: string; permissions: PortalPermission[] } };

const TABS: { permission: PortalPermission; href: string; label: string }[] = [
  { permission: "quotes", href: "/portal/quotes", label: "Quotes" },
  { permission: "jobs", href: "/portal/jobs", label: "Jobs" },
];

export function PortalFrame({ title, children, signedIn }: PortalFrameProps) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {signedIn ? (
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3" data-testid="portal-header">
          <nav aria-label="Portal" className="flex gap-4">
            <Link prefetch={false} href="/portal" className="font-medium">Home</Link>
            {TABS.filter((tab) => signedIn.permissions.includes(tab.permission)).map((tab) => (
              <Link key={tab.href} prefetch={false} href={tab.href} data-testid={`portal-tab-${tab.permission}`}>{tab.label}</Link>
            ))}
          </nav>
          <form method="post" action="/api/portal/signout">
            <button type="submit" className="text-sm underline">Sign out</button>
          </form>
        </header>
      ) : null}
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}
