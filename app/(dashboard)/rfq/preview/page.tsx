/**
 * BOUNDARY (RFQ, Quotes / RFQ / Sales Orders module 3, PREVIEW ONLY). Route /rfq/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits /rfq to admin and office). Input: none (the page takes no params and reads nothing). Output: the RFQ Control Centre
 * look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase here; no link from the real RFQ screen to this route; it replaces nothing. Delete the
 * four preview files (this page, components/rfq/preview/RfqPreview.tsx and .module.css, tests/unit/rfqPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import RfqPreview from "@/components/rfq/preview/RfqPreview";

export const metadata: Metadata = { title: "RFQ Control Centre preview", robots: { index: false, follow: false } };

export default function RfqPreviewPage() {
  return <RfqPreview />;
}
