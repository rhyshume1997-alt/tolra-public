/**
 * BOUNDARY (Jobs / Schedule / Time / Workshop, Module 2, PREVIEW ONLY). Route /schedule/preview inside the existing dashboard shell (verified session, sidebar, top bar). Input: none
 * (the page takes no params and reads nothing). Output: the Machine Schedule look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no auth logic, no session or role read, no data fetching, no server action, no Supabase call here, and nothing may ever be wired from this route to real bookings,
 * machines, runs or people; no link from the real page to this route; it replaces nothing. Delete the four preview files (this page, components/schedule/preview/SchedulePreview.tsx and
 * .module.css, tests/unit/schedulePreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import SchedulePreview from "@/components/schedule/preview/SchedulePreview";

export const metadata: Metadata = { title: "Machine Schedule preview", robots: { index: false, follow: false } };

export default function SchedulePreviewPage() {
  return <SchedulePreview />;
}
