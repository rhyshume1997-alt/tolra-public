/**
 * BOUNDARY (Suppliers, Module 5, PREVIEW ONLY). Route /suppliers/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits the route by role). Input: none (the page takes no params and reads nothing). Output: the Suppliers look-and-feel prototype
 * with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase, e-mail, accounting or AI call here; no link from the real page to this route;
 * it replaces nothing. Delete the four preview files (this page, components/suppliers/preview/SuppliersPreview.tsx and .module.css, tests/unit/suppliersPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import SuppliersPreview from "@/components/suppliers/preview/SuppliersPreview";

export const metadata: Metadata = { title: "Suppliers preview", robots: { index: false, follow: false } };

export default function SuppliersPreviewPage() {
  return <SuppliersPreview />;
}
