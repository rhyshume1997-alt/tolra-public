/**
 * BOUNDARY (Dashboard, Module 7, PREVIEW ONLY). Route /dashboard/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits the route by role). Input: none (the page takes no params and reads nothing). Output: the Dashboard look-and-feel prototype
 * with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase, e-mail, accounting or AI call here; no link from the real page to this route;
 * it replaces nothing. Delete the four preview files (this page, components/dashboard/preview/DashboardPreview.tsx and .module.css, tests/unit/dashboardPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import DashboardPreview from "@/components/dashboard/preview/DashboardPreview";

export const metadata: Metadata = { title: "Dashboard preview", robots: { index: false, follow: false } };

export default function DashboardPreviewPage() {
  return <DashboardPreview />;
}
