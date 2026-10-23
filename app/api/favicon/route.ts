import { appIconResponse } from "@/lib/server/app-icon";

export const dynamic = "force-dynamic";

// The company's icon at 48px (PNG; every current browser accepts it). Served at /favicon.ico by the rewrite in
// next.config.mjs: a route folder named app/favicon.ico would clash with Next's reserved favicon file name.
export function GET(request: Request) {
  return appIconResponse(request, 48);
}
