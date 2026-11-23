/**
 * BOUNDARY (Admin > Activity, PREVIEW ONLY). OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md assigns no module to /admin/activity; it is treated as a company-admin
 * screen under Module 1 (Auth / Company / Users / Admin), by the coordinator's decision, not by the document. Route /admin/activity/preview inside the existing dashboard shell
 * (verified session, sidebar, top bar). Input: none. Output: the Activity look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no auth, session, role read, data fetching, Supabase or rpc call here; no link from the real page to this route; it replaces nothing. Delete the four preview
 * files (this page, components/admin/activity/preview/ActivityPreview.tsx and .module.css, tests/unit/adminActivityPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import ActivityPreview from "@/components/admin/activity/preview/ActivityPreview";

export const metadata: Metadata = { title: "Activity preview", robots: { index: false, follow: false } };

export default function ActivityPreviewPage() {
  return <ActivityPreview />;
}
