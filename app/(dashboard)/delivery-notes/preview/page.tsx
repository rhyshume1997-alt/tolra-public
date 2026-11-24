/**
 * BOUNDARY (Delivery Notes, Invoices module 4, PREVIEW ONLY). Route /delivery-notes/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits the route by role). Input: none (the page takes no params and reads nothing). Output: the Delivery Notes look-and-feel prototype
 * with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no Supabase, e-mail, payment or accounting call here; no link from the real page to this route;
 * it replaces nothing. Delete the four preview files (this page, components/delivery-notes/preview/DeliveryNotesPreview.tsx and .module.css, tests/unit/deliveryNotesPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import DeliveryNotesPreview from "@/components/delivery-notes/preview/DeliveryNotesPreview";

export const metadata: Metadata = { title: "Delivery Notes preview", robots: { index: false, follow: false } };

export default function DeliveryNotesPreviewPage() {
  return <DeliveryNotesPreview />;
}
