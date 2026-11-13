// Platform owner: remove one company's customer-portal links (go-live feature 5). Reached by URL; middleware already limits /platform/**
// to the platform owner, and the route and database check again. Must not change: no company deletion; app/platform/page.tsx is untouched.
import { PortalOffboardCard } from "@/components/platform/portal-offboard-card";

export default function PortalOffboardPage() {
  return (
    <main className="mx-auto w-full max-w-2xl p-4">
      <PortalOffboardCard />
    </main>
  );
}
