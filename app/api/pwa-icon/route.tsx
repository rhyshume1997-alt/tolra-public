import { appIconResponse } from "@/lib/server/app-icon";

export const dynamic = "force-dynamic";

// App icons for the manifest, apple-touch-icon and favicon (see lib/server/app-icon.tsx).
export function GET(request: Request) {
  return appIconResponse(request);
}
