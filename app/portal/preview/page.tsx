/**
 * BOUNDARY (Customer portal, Module 10, PREVIEW ONLY, security-sensitive). Route /portal/preview, inside the existing bare portal layout (noindex, no staff shell).
 * Input: none (the page takes no params, reads no cookie, no header, no query string and no database). Output: the customer portal look-and-feel prototype
 * (components/portal/preview/PortalPreview.tsx) with fictional sample data, labelled "Preview only".
 * The ONLY check here is the platform flag, read through the existing pure lib/portal/flag.ts: with CUSTOMER_PORTAL_ENABLED not exactly "true" the route is a 404, the
 * same as every other portal page, so the preview is off by default and cannot be mistaken for a live sign-in on a production site. That check is not authentication.
 * Must not change: no auth logic, no session, no portal cookie, no token, no API call, no e-mail, no code check, nothing logged; nothing may ever be wired from this route
 * to portal authentication or portal data; no link from a real portal page to this route; it replaces nothing. Delete the four preview files (this page,
 * components/portal/preview/PortalPreview.tsx and .module.css, tests/unit/portal-preview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import PortalPreview from "@/components/portal/preview/PortalPreview";
import { portalEnabled } from "@/lib/portal/flag";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customer portal preview", robots: { index: false, follow: false, nocache: true } };

export default function PortalPreviewPage() {
  if (!portalEnabled()) notFound();
  return <PortalPreview />;
}
