// Platform owner Rollouts (module G). Reached by URL and by the link on the platform page; middleware already limits /platform/** to the platform
// owner, and the route and database check again. Off unless PLATFORM_ROLLOUTS_ENABLED is exactly "true". Must not change: no other platform file.
import Link from "next/link";

import { RolloutsCard } from "@/components/platform/rollouts-card";
import { rolloutsEnabled } from "@/lib/platform/owner-flags";

export const dynamic = "force-dynamic";

export default function RolloutsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl p-4">
      <Link href="/platform" className="text-sm text-slate-500 underline">Back to the platform</Link>
      {rolloutsEnabled() ? <RolloutsCard /> : <p role="status" className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">Rollouts are switched off.</p>}
    </main>
  );
}
