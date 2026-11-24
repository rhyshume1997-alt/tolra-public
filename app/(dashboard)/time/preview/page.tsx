/**
 * BOUNDARY (Jobs / Schedule / Time / Workshop, Module 2, PREVIEW ONLY). Route /time/preview inside the existing dashboard shell (verified session, sidebar, top bar). Input: none
 * (the page takes no params and reads nothing). Output: the Weekly hours (Today and This week) look-and-feel prototype with fictional sample data, labelled "Preview, sample data,
 * nothing is saved". Must not change: no auth logic, no session or role read, no data fetching, no server action, no Supabase or offline-outbox call here, and nothing may ever be wired
 * from this route to real clock records, job time or approvals; no link from the real page to this route; it replaces nothing. Delete the four preview files (this page,
 * components/time/preview/TimePreview.tsx and .module.css, tests/unit/timePreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import TimePreview from "@/components/time/preview/TimePreview";

export const metadata: Metadata = { title: "Weekly hours preview", robots: { index: false, follow: false } };

export default function TimePreviewPage() {
  return <TimePreview />;
}
