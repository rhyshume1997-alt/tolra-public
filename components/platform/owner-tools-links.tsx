// The single entry to the owner-only Roadmap and Rollouts screens (modules F and G) from the platform page. Inputs: none. Outputs: two links.
// Must not change: it only links; each screen is off until its own server flag is exactly "true", and says so when opened.
import Link from "next/link";

export function OwnerToolsLinks() {
  return (
    <nav aria-label="Owner tools" className="mt-6 flex flex-wrap gap-4 text-sm" data-testid="owner-tools-links">
      <Link href="/platform/roadmap" className="font-medium text-slate-700 underline">Roadmap</Link>
      <Link href="/platform/rollouts" className="font-medium text-slate-700 underline">Rollouts</Link>
    </nav>
  );
}
