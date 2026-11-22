import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * BOUNDARY: app/portal/layout.tsx. Input: children. Output: a bare page frame, noindex. No dashboard shell, no staff navigation, no
 * company branding. Must not read cookies, call the database or add anything that links into the staff app.
 */
export const metadata: Metadata = { title: "Customer portal", robots: { index: false, follow: false, nocache: true } };

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-50 text-slate-900">{children}</div>;
}
