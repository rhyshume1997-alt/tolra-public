// DO NOT MERGE: preview hub. Scratch route: renders one preview inside the real Sidebar/Topbar with a stubbed admin. No auth, no Supabase.
import { RenderShell } from "@/components/render-shell";
import P from "@/components/dashboard/preview/DashboardPreview";
export default function Page() { return <RenderShell><P /></RenderShell>; }
