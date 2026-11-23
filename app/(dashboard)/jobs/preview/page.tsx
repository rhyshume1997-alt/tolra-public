/**
 * BOUNDARY (Jobs module 2, PREVIEW ONLY). Route /jobs/preview inside the existing dashboard shell (verified session, sidebar, top bar).
 * Input: none (the page takes no params and reads nothing). Output: the Job Board look-and-feel prototype with fictional sample data.
 * Must not change: no data fetching, no server actions, no Supabase here; no link from the real Jobs screens to this route; it
 * replaces nothing. Delete the four preview files to remove it completely.
 */
import type { Metadata } from "next";

import JobsPreview from "@/components/jobs/preview/JobsPreview";

export const metadata: Metadata = { title: "Job Board preview", robots: { index: false, follow: false } };

export default function JobsPreviewPage() {
  return <JobsPreview />;
}
