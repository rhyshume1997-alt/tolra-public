/**
 * BOUNDARY (PREVIEW ONLY). OWNERSHIP ASSUMPTION, TO BE CONFIRMED BY THE OWNER: docs/MODULES.md assigns the Settings page to no module; for this preview it is treated as
 * Module 1 (Auth / Company / Users / Admin). Route /settings/preview inside the existing dashboard shell (verified session, sidebar, top bar; middleware already limits /settings
 * and everything under it to admin). Input: none (the page takes no params and reads nothing). Output: the Settings look-and-feel prototype with fictional sample data, labelled
 * "Preview, sample data, nothing is saved".
 * Must not change: no auth logic, no session or role read, no data fetching, no server action, no Supabase, e-mail, payment, AI, Xero or upload call here, and nothing may ever be wired
 * from this route to real settings; no link from the real page to this route; it replaces nothing. Delete the four preview files (this page, components/settings/preview/SettingsPreview.tsx
 * and .module.css, tests/unit/settingsPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import SettingsPreview from "@/components/settings/preview/SettingsPreview";

export const metadata: Metadata = { title: "Settings preview", robots: { index: false, follow: false } };

export default function SettingsPreviewPage() {
  return <SettingsPreview />;
}
