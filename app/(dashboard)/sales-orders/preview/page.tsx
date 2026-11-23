/**
 * BOUNDARY (Sales Orders, Quotes / RFQ / Sales Orders module 3, PREVIEW ONLY). Route /sales-orders/preview inside the existing dashboard shell (verified session, sidebar,
 * top bar; middleware already limits /sales-orders to admin and office, and the existing sales-orders/layout.tsx gate applies: it opens only for a company that has
 * switched Sales Orders on in Settings > Menu). Input: none (the page takes no params and reads nothing). Output: the Sales Orders list look-and-feel prototype with
 * fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase here; no link from the real Sales Orders screen to this route; it replaces nothing. The literal
 * "preview" segment sits beside the dynamic [id] segment (which today holds only [id]/print): /sales-orders/preview is this page, and /sales-orders/preview/print is not
 * a print sheet for an order whose id is "preview" (real ids are UUIDs). Delete the four preview files (this page, components/sales-orders/preview/SalesOrdersPreview.tsx
 * and .module.css, tests/unit/salesOrdersPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import SalesOrdersPreview from "@/components/sales-orders/preview/SalesOrdersPreview";

export const metadata: Metadata = { title: "Sales Orders preview", robots: { index: false, follow: false } };

export default function SalesOrdersPreviewPage() {
  return <SalesOrdersPreview />;
}
