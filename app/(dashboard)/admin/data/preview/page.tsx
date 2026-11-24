/**
 * BOUNDARY (Admin > Data, PREVIEW ONLY). OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md assigns no module to /admin/data; it is treated as a company-admin
 * screen under Module 1 (Auth / Company / Users / Admin), by the coordinator's decision, not by the document. Route /admin/data/preview inside the existing dashboard shell
 * (verified session, sidebar, top bar). Input: none. Output: the Data (import) look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no auth, session, role read, file read, data fetching, Supabase or rpc call here; no import, undo, discard or export is ever offered beyond the neutral toast; no link from the real page to this route; it replaces nothing. Delete the four preview
 * files (this page, components/admin/data/preview/DataPreview.tsx and .module.css, tests/unit/adminDataPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import DataPreview from "@/components/admin/data/preview/DataPreview";

export const metadata: Metadata = { title: "Data preview", robots: { index: false, follow: false } };

export default function DataPreviewPage() {
  return <DataPreview />;
}
