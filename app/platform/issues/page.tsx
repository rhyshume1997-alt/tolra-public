// Platform owner: the issues inbox (module E). Reached by URL, like portal-offboard: middleware already limits /platform/** to the platform
// owner, and the route and database check again. OFF unless OWNER_ISSUES_ENABLED is exactly "true" on the server. Must not change:
// app/platform/page.tsx (the Companies screen, another module) is untouched, so there is no link to this page from it yet.
import { IssuesInbox } from "@/components/platform/issues-inbox";
import { ownerIssuesEnabled } from "@/lib/issues/owner-flag";

export const dynamic = "force-dynamic";

export default function PlatformIssuesPage() {
  if (!ownerIssuesEnabled()) {
    return <main className="mx-auto w-full max-w-4xl p-4"><p className="text-sm text-slate-500">The issues inbox is switched off.</p></main>;
  }
  return (
    <main className="mx-auto w-full max-w-4xl p-4">
      <IssuesInbox />
    </main>
  );
}
