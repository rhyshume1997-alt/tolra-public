/**
 * BOUNDARY (Invoices module 4, PREVIEW ONLY). Route /invoices/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits /invoices to admin and office). Input: none (the page takes no params and reads nothing). Output: the Invoicing
 * look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase, payment, Xero or accounting call here; no link from the real Invoicing page to
 * this route; it replaces nothing. Delete the four preview files (this page, components/invoices/preview/InvoicesPreview.tsx and .module.css,
 * tests/unit/invoicesPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import InvoicesPreview from "@/components/invoices/preview/InvoicesPreview";

export const metadata: Metadata = { title: "Invoicing preview", robots: { index: false, follow: false } };

export default function InvoicesPreviewPage() {
  return <InvoicesPreview />;
}
