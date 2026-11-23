// Platform owner Roadmap (module F). Reached by URL and by the link on the platform page; middleware already limits /platform/** to the platform
// owner, and the route and database check again. Off unless PLATFORM_ROADMAP_ENABLED is exactly "true". Must not change: no other platform file.
import Link from "next/link";

import { RoadmapCard } from "@/components/platform/roadmap-card";
import { roadmapEnabled } from "@/lib/platform/owner-flags";

export const dynamic = "force-dynamic";

export default function RoadmapPage() {
  return (
    <main className="mx-auto w-full max-w-3xl p-4">
      <Link href="/platform" className="text-sm text-slate-500 underline">Back to the platform</Link>
      {roadmapEnabled() ? <RoadmapCard /> : <p role="status" className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">The Roadmap is switched off.</p>}
    </main>
  );
}
