/**
 * BOUNDARY (ISO templates, Module 9, PM-approved 6a, PREVIEW ONLY). Route /admin/iso/preview inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware already limits /admin routes by role). Input: none (takes no params, reads nothing). Output: the Admin > ISO templates look-and-feel prototype with fictional
 * sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no auth, session, role read, data fetching, Supabase, PDF or zip call here; nothing is wired from this route to real data; no link from the real page to
 * this route; it replaces nothing; no controlled document wording lives here. Delete the three preview files (this page, components/iso/preview/IsoPreview.tsx and .module.css) and
 * tests/unit/isoPreview.test.ts to remove it completely.
 */
import type { Metadata } from "next";

import IsoPreview from "@/components/iso/preview/IsoPreview";

export const metadata: Metadata = { title: "ISO templates preview", robots: { index: false, follow: false } };

export default function IsoPreviewPage() {
  return <IsoPreview />;
}
