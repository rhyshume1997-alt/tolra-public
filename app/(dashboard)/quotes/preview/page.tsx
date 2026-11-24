/**
 * BOUNDARY (Quotes module 3, PREVIEW ONLY). Route /quotes/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits /quotes to admin and office). Input: none (the page takes no params and reads nothing). Output: the Quote
 * Generator look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase here; no link from the real Quotes screens to this route; it replaces
 * nothing. Delete the four preview files (this page, components/quotes/preview/QuotesPreview.tsx and .module.css, tests/unit/quotesPreview.test.ts)
 * to remove it completely.
 */
import type { Metadata } from "next";

import QuotesPreview from "@/components/quotes/preview/QuotesPreview";

export const metadata: Metadata = { title: "Quote Generator preview", robots: { index: false, follow: false } };

export default function QuotesPreviewPage() {
  return <QuotesPreview />;
}
