/**
 * BOUNDARY (NCR register, Jobs / Schedule / Time / Workshop module 2, PREVIEW ONLY). Route /jobs/ncr/preview inside the existing dashboard shell (verified session, sidebar, top bar).
 * Input: none (the page takes no params and reads nothing). Output: the NCR register look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase here; no link from the real NCR register to this route; it replaces nothing. Delete the four preview files (this page,
 * components/jobs/preview/NcrRegisterPreview.tsx and .module.css, tests/unit/ncrRegisterPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import NcrRegisterPreview from "@/components/jobs/preview/NcrRegisterPreview";

export const metadata: Metadata = { title: "NCR register preview", robots: { index: false, follow: false } };

export default function NcrRegisterPreviewPage() {
  return <NcrRegisterPreview />;
}
