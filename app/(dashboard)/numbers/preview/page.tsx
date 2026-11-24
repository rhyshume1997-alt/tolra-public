/**
 * BOUNDARY (Numbers, Module 7, PREVIEW ONLY). Route /numbers/preview inside the existing dashboard shell (verified session, sidebar, top bar; middleware
 * already limits /numbers to admin). Input: none (no params, reads nothing). Output: the Numbers look-and-feel prototype with fictional sample data, labelled
 * "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase call here; no link from the real page to this route; it replaces nothing.
 * Delete the four preview files (this page, components/numbers/preview/NumbersPreview.tsx and .module.css, tests/unit/numbersPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import NumbersPreview from "@/components/numbers/preview/NumbersPreview";

export const metadata: Metadata = { title: "Numbers preview", robots: { index: false, follow: false } };

export default function NumbersPreviewPage() {
  return <NumbersPreview />;
}
