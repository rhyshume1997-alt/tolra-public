/**
 * BOUNDARY (PREVIEW ONLY). OWNERSHIP ASSUMPTION, TO BE CONFIRMED BY THE OWNER: Settings is treated as Module 1 for the previews; the real section is Module J (Document designs). Route /settings/documents-preview
 * (beside /settings/preview) inside the existing dashboard shell (verified session, sidebar, top bar; middleware already limits /settings and everything under it to admin). Input: none (no params, nothing read).
 * Output: the redesigned Document designs card with fictional sample data and a live PDF preview built in the browser, labelled "Preview, sample data, nothing is saved".
 * Must not change: no auth logic, no session or role read, no data fetching, no server action, no Supabase, e-mail, payment, AI, Xero or upload call here, and nothing may ever be wired from this route to real settings;
 * no link from the real page to this route; it replaces nothing. Delete the four preview files (this page, components/settings/preview/DocumentDesignsPreview.tsx and .module.css,
 * tests/unit/documentDesignsPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import DocumentDesignsPreview from "@/components/settings/preview/DocumentDesignsPreview";

export const metadata: Metadata = { title: "Document designs preview", robots: { index: false, follow: false } };

export default function DocumentDesignsPreviewPage() {
  return <DocumentDesignsPreview />;
}
