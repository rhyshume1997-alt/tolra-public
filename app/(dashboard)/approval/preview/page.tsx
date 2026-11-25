/**
 * BOUNDARY (Approval Queue, treated as Module 4 (documents, payments and receivables approvals, including chase drafts) by the coordinator's decision, PREVIEW ONLY; the project owner is to confirm this
 * ownership, docs/MODULES.md does not list /approval and the screen also touches Module 3 documents and Module 6 e-mail). Route /approval/preview inside the existing dashboard shell.
 * Input: none (no params, reads nothing). Output: the Approval Queue look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no data fetching, no server actions, no mail or provider call here; no link from the real Approval Queue to this route; it replaces nothing. Delete the four preview files (this page,
 * components/approval/preview/ApprovalPreview.tsx and .module.css, tests/unit/approvalPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import ApprovalPreview from "@/components/approval/preview/ApprovalPreview";

export const metadata: Metadata = { title: "Approval Queue preview", robots: { index: false, follow: false } };

export default function ApprovalPreviewPage() {
  return <ApprovalPreview />;
}
