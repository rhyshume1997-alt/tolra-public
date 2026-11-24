/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW, scratch environment only). Route /quotes/preview-live inside the existing dashboard shell (verified session, sidebar, top bar;
 * middleware ROUTE_ROLES for "/quotes" is a prefix match, so this sub-route is limited to admin and office like the real page, and QuotesLive wraps RoleGate again).
 * Input: none (no params). Output: the redesigned Quote Generator over the signed-in person's REAL quotes, read with their own row-level-security session; every write, send, archive,
 * e-mail, PDF and export action answers "Not enabled in this preview".
 * GATE (default OFF): returns notFound() unless QUOTE_LIVE_PREVIEW_ENABLED is exactly "true" AND VERCEL_ENV is exactly "preview" (Vercel sets "preview" on branch and scratch builds; "production" on production; nothing locally).
 * So it is closed on production, closed locally, and closed on a preview until the flag is set. The page is dynamic so the check runs per request.
 * Must not change: the default-off gate, no link from the real Quotes screens to this route, no data fetching or server action here (the client component reads, SELECT only). Delete this page,
 * components/quotes/preview/QuotesLive.tsx, lib/quote-list-load.ts and the live tests to remove it completely.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import QuotesLive from "@/components/quotes/preview/QuotesLive";
import { quoteLivePreviewOpen } from "@/lib/quote-live-gate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Quote Generator live preview", robots: { index: false, follow: false } };

export default function QuotesLivePreviewPage() {
  if (!quoteLivePreviewOpen()) notFound();
  return <QuotesLive />;
}
