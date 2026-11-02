import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/marketing";

// Only the home page is for search engines. The app's routes are disallowed here and also carry noindex (app/layout.tsx).
// /login is left crawlable on purpose: a crawler has to fetch it to see its noindex.
const APP_ROUTES = [
  "/dashboard", "/api/", "/admin", "/numbers", "/invoices", "/sales-orders", "/settings", "/approval", "/email", "/quotes", "/rfq", "/suppliers",
  "/customers", "/purchase-orders", "/jobs", "/schedule", "/delivery-notes", "/time", "/ai-helper", "/auth/", "/mfa", "/platform", "/choose-company", "/select-role",
];

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: APP_ROUTES }], sitemap: `${SITE_URL}/sitemap.xml` };
}
