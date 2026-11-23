/**
 * BOUNDARY (Customers, Module 5, PREVIEW ONLY). Route /customers/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits the route by role). Input: none (the page takes no params and reads nothing). Output: the Customers look-and-feel prototype
 * with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase, e-mail, statement or accounting call here; no link from the real page to this route;
 * it replaces nothing. Delete the four preview files (this page, components/customers/preview/CustomersPreview.tsx and .module.css, tests/unit/customersPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import CustomersPreview from "@/components/customers/preview/CustomersPreview";

export const metadata: Metadata = { title: "Customers preview", robots: { index: false, follow: false } };

export default function CustomersPreviewPage() {
  return <CustomersPreview />;
}
