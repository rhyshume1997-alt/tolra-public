import type { MetadataRoute } from "next";

import { PRIVACY_PATH, SITE_URL } from "@/lib/marketing";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/` }, { url: `${SITE_URL}${PRIVACY_PATH}` }];
}
