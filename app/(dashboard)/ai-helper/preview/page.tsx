/**
 * BOUNDARY (AI section, treated as Integrations module 6 by the coordinator's decision, PREVIEW ONLY; the project owner is to confirm this ownership, the module map does not list /ai-helper).
 * Route /ai-helper/preview inside the existing dashboard shell. Input: none (no params, reads nothing). Output: the AI section look-and-feel prototype, fictional and labelled "Preview, sample data,
 * nothing is saved". The AI is OFF by default on the real page; the preview shows every state, including the off and not-set-up ones.
 * Must not change: no data fetching, no server actions, no model or AI-provider call here; no link from the real AI page to this route; it replaces nothing. Delete the four preview files (this page,
 * components/integrations/preview/AiHelperPreview.tsx and .module.css, tests/unit/aiHelperPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import AiHelperPreview from "@/components/integrations/preview/AiHelperPreview";

export const metadata: Metadata = { title: "AI section preview", robots: { index: false, follow: false } };

export default function AiHelperPreviewPage() {
  return <AiHelperPreview />;
}
