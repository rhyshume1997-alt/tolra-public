/**
 * BOUNDARY (Reports, Module 7, PREVIEW ONLY). Route /dashboard/reports-preview inside the existing dashboard shell (verified session, sidebar, top bar), hosted under
 * the Dashboard tree because Module 7 does not list reports/preview. Input: none (the page takes no params and reads nothing). Output: the Reports look-and-feel
 * prototype (operations reports and the Revenue report) with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase, export, e-mail or accounting call here; no link from the real pages to this route; it
 * replaces nothing; nothing is created under app/(dashboard)/reports/. Delete the four preview files (this page, components/reports/preview/ReportsPreview.tsx and
 * .module.css, tests/unit/reportsPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import ReportsPreview from "@/components/reports/preview/ReportsPreview";

export const metadata: Metadata = { title: "Reports preview", robots: { index: false, follow: false } };

export default function ReportsPreviewPage() {
  return <ReportsPreview />;
}
