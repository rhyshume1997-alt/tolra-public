/**
 * BOUNDARY (Admin > Integrations, PREVIEW ONLY). OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md lists components/integrations/** and settings cards under Module 6
 * (Integrations) but does not list the route app/(dashboard)/admin/integrations/**; by the coordinator's decision this route is treated as Module 6's. Route /admin/integrations/preview
 * inside the existing dashboard shell (verified session, sidebar, top bar). Input: none. Output: the Integrations look-and-feel prototype with fictional sample data, labelled "Preview,
 * sample data, nothing is saved". Integrations are OFF by default: nothing here is ever drawn as connected, authorised or successful, and nothing is called.
 * Must not change: no auth, session, role read, data fetching, Supabase, fetch, OAuth, e-mail or AI call here; no link from the real page to this route; it replaces nothing. Delete the
 * three preview files (this page, components/integrations/preview/IntegrationsPreview.tsx and .module.css) and tests/unit/adminIntegrationsPreview.test.ts to remove it completely.
 */
import type { Metadata } from "next";

import IntegrationsPreview from "@/components/integrations/preview/IntegrationsPreview";

export const metadata: Metadata = { title: "Integrations preview", robots: { index: false, follow: false } };

export default function IntegrationsPreviewPage() {
  return <IntegrationsPreview />;
}
