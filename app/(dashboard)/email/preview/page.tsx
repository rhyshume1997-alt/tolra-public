/**
 * BOUNDARY (Email history, treated as Integrations module 6 by the coordinator's decision, PREVIEW ONLY; the project owner is to confirm this ownership, the module map does not list /email).
 * Route /email/preview inside the existing dashboard shell. Input: none (no params, reads nothing). Output: the Email & Payment Automation look-and-feel prototype with fictional sample data,
 * labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no mail, Microsoft 365 or Resend call here; no link from the real Email screen to this route; it replaces nothing. Delete the four preview files
 * (this page, components/integrations/preview/EmailHistoryPreview.tsx and .module.css, tests/unit/emailHistoryPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import EmailHistoryPreview from "@/components/integrations/preview/EmailHistoryPreview";

export const metadata: Metadata = { title: "Email history preview", robots: { index: false, follow: false } };

export default function EmailHistoryPreviewPage() {
  return <EmailHistoryPreview />;
}
