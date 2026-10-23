"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ElementType } from "react";
import {
  CalendarClock,
  Timer,
  Calculator,
  CheckCircle,
  Database,
  FileText,
  History,
  Layers,
  LayoutDashboard,
  Lock,
  LogOut,
  Package,
  Plug,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useOrgSettings } from "@/lib/org-settings";
import { canOpenDestination } from "@/lib/destinations";
import { passwordProblem } from "@/lib/password";
import { awaitingApproval } from "@/lib/approval-queue";
import { supabase } from "@/lib/supabase";
import { isCompanyPending } from "@/lib/brand-pending";
import { useCompanyProfile } from "@/lib/company";
import { friendlyError } from "@/lib/friendly-error";
import { useUser } from "@/lib/use-user";
import type { UserRole } from "@/types";
import { PRODUCT } from "@/lib/product";
import { useOfflineStatus } from "@/lib/offline/scope";
import { connectionState, roleLabel } from "@/lib/shell-status";
import { ConnectionDot } from "@/components/shell-status";
import { DisplayNameForm } from "@/components/display-name";

type NavItem = {
  href: string;
  label: string;
  icon: ElementType;
  roles: UserRole[];
};

const navSections: { title: string; items: NavItem[] }[] = [
  { title: "Workspace", items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "office", "workshop", "viewer"] }] },
  {
    title: "Sales Pipeline",
    items: [
      { href: "/rfq", label: "RFQ Control Centre", icon: FileText, roles: ["admin", "office"] },
      { href: "/quotes", label: "Quote Generator", icon: Calculator, roles: ["admin", "office"] },
      { href: "/sales-orders", label: "Sales Orders", icon: Receipt, roles: ["admin", "office"] },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/jobs", label: "Job Board", icon: Layers, roles: ["admin", "office", "workshop", "viewer"] },
      { href: "/schedule", label: "Machine Schedule", icon: CalendarClock, roles: ["admin", "office", "workshop", "viewer"] },
      { href: "/time", label: "Weekly hours", icon: Timer, roles: ["admin", "office", "workshop"] },
      { href: "/invoices", label: "Invoicing", icon: Receipt, roles: ["admin", "office"] },
      { href: "/approval", label: "Approval Queue", icon: CheckCircle, roles: ["admin", "office"] },
      { href: "/purchase-orders", label: "Purchase Orders", icon: ShoppingCart, roles: ["admin", "office"] },
      { href: "/delivery-notes", label: "Delivery Notes", icon: Truck, roles: ["admin", "office", "workshop"] },
    ],
  },
  {
    title: "Resources",
    items: [
      { href: "/customers", label: "Customers", icon: Users, roles: ["admin", "office"] },
      { href: "/suppliers", label: "Suppliers", icon: Package, roles: ["admin", "office"] },
      { href: "/admin/users", label: "User Management", icon: Users, roles: ["admin"] },
      { href: "/admin/activity", label: "Activity", icon: History, roles: ["admin"] },
      { href: "/admin/compliance", label: "Security", icon: ShieldCheck, roles: ["admin"] },
      { href: "/admin/data", label: "Data", icon: Database, roles: ["admin"] },
      { href: "/admin/integrations", label: "Integrations", icon: Plug, roles: ["admin"] },
      { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
    ],
  },
];

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { profile, organizations, switchOrganization, activeRole, setActiveRole, signOut, hasAnyRole, hiddenSections } = useUser();
  const orgSettings = useOrgSettings();
  const connection = connectionState(useOfflineStatus());
  const { profile: company, loading: companyLoading } = useCompanyProfile();
  // Until the company is known the header shows a neutral placeholder, never the product name in the company's place (lib/brand-pending).
  const companyPending = isCompanyPending(company, companyLoading);
  const [approvalCount, setApprovalCount] = useState<number | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const currentOrg = organizations.find((org) => org.is_current);
  const canChooseView = profile?.role === "admin" || Boolean(profile?.secondary_role);

  useEffect(() => {
    async function loadApprovalCount() {
      if (!supabase) return;
      const { count, error } = await awaitingApproval(supabase.from("email_history").select("*", { count: "exact", head: true }));
      if (!error) setApprovalCount(count ?? 0);
    }

    void loadApprovalCount();
    function handleApprovalCountChange(event: Event) {
      setApprovalCount((event as CustomEvent<number>).detail);
    }
    window.addEventListener("approval-count-change", handleApprovalCountChange);
    return () => window.removeEventListener("approval-count-change", handleApprovalCountChange);
  }, []);

  async function handleSwitchOrganization(organizationId: string) {
    if (organizationId === currentOrg?.organization_id) return;
    setSwitching(true);
    try {
      if (!(await switchOrganization(organizationId))) setSwitching(false);
    } catch (err) {
      setSwitching(false);
      toast.error(friendlyError(err, "Couldn't switch organisation. Try again."));
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const currentPassword = String(form.get("currentPassword") || "");
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");

    if (!currentPassword) {
      toast.error("Current password is required.");
      return;
    }

    const problem = passwordProblem(password);
    if (problem) {
      toast.error(problem);
      return;
    }

    if (password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    if (!supabase) {
      toast.error("Supabase is not configured.");
      return;
    }

    const email = profile?.email;
    if (!email) {
      toast.error("Could not verify your account email.");
      return;
    }

    const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
    if (verifyError) {
      toast.error("Current password incorrect.");
      return;
    }

    // Through the server, which applies the same rules as everywhere else (length, and a known-breach check).
    const response = await fetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(response.status === 400 && result.error ? result.error : "Couldn't update your password. Try again.");
      return;
    }

    formEl.reset();
    toast.success("Password updated successfully.");
  }

  return (
    <div className="flex h-full flex-col bg-brand text-brand-ink">
      <div className="px-5 pb-5 pt-6">
        <div className="flex items-center gap-3">
          {companyPending ? (
            <div data-testid="company-pending" aria-hidden="true" className="size-12 shrink-0 animate-pulse rounded-xl bg-brand-ink/10" />
          ) : company?.logoSrc && !logoFailed ? (
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white p-1.5">
              <Image src={company.logoSrc} alt={`${company.name} logo`} width={48} height={48} unoptimized className="max-h-full w-auto object-contain" onError={() => setLogoFailed(true)} />
            </div>
          ) : (
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-ink/10 text-base font-semibold tracking-tight">{company ? company.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase() : PRODUCT.monogram}</div>
          )}
          <div className="min-w-0">
            {/* The company first; the product is a small credit. */}
            {companyPending ? (
              <div aria-hidden="true" className="space-y-2"><div className="h-4 w-28 animate-pulse rounded bg-brand-ink/15" /><div className="h-2.5 w-12 animate-pulse rounded bg-brand-ink/10" /></div>
            ) : (
              <>
                <p className="truncate text-[0.95rem] font-semibold leading-tight tracking-tight">{company?.name ?? PRODUCT.name}</p>
                {company ? <p className="label-mono mt-1 text-brand-ink/50">{PRODUCT.name}</p> : null}
              </>
            )}
          </div>
        </div>
        {organizations.length > 1 ? (
          <select
            aria-label="Switch organisation"
            className="mt-4 h-10 pointer-coarse:h-11 w-full rounded-lg border border-brand-ink/15 bg-brand-ink/[0.06] px-2 text-sm text-brand-ink [&>option]:text-ink"
            value={currentOrg?.organization_id ?? ""}
            disabled={switching}
            onChange={(event) => void handleSwitchOrganization(event.target.value)}
          >
            {organizations.map((org) => <option key={org.organization_id} value={org.organization_id}>{org.name}</option>)}
          </select>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {navSections.map((section) => {
          const visibleItems = section.items.filter((item) => hasAnyRole(item.roles) && canOpenDestination(item.href, { activeRole, hiddenSections, hiddenNav: orgSettings.hiddenNav }));
          if (!visibleItems.length) return null;

          return (
            <div key={section.title} className="mb-5">
              <p className="label-mono px-3 pb-2 text-brand-ink/45">{section.title}</p>
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const badge = item.href === "/approval" && approvalCount ? approvalCount.toString() : null;
                  return (
                    <Link key={item.href} href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn("relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 pointer-coarse:min-h-11 text-[0.9rem] text-brand-ink/70 transition hover:bg-brand-ink/[0.07] hover:text-brand-ink", active && "bg-brand-ink/[0.11] font-medium text-brand-ink before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand-accent")}>
                      <Icon className="size-[18px] shrink-0" strokeWidth={1.75} />
                      <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{item.label}</span>
                      {badge ? <span className="flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white">{badge}</span> : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-brand-ink/10 p-4">
        {/* Top-aligned: the settings button sits level with the name however many lines the role and status take. */}
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-accent text-xs font-semibold text-white">{(profile?.full_name?.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2) || profile?.email?.[0] || "").toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{profile?.full_name || profile?.email || ""}</p>
            <span className="label-mono flex flex-wrap items-center gap-x-1.5 text-brand-ink/50"><span>{roleLabel(activeRole)}</span><span className="flex min-w-0 items-center gap-1.5"><ConnectionDot tone={connection.tone} /><span data-testid="drawer-connection">{connection.label}</span></span></span>
          </div>
          <Dialog>
            <DialogTrigger asChild><button type="button" className="-mt-2.5 flex size-10 shrink-0 items-center justify-center rounded-full pointer-coarse:-mt-3 pointer-coarse:size-11 text-brand-ink/55 transition hover:bg-brand-ink/10 hover:text-brand-ink" aria-label="Settings"><Settings className="size-[18px]" strokeWidth={1.75} /></button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Account Settings</DialogTitle><DialogDescription>Profile and {PRODUCT.name} preferences.</DialogDescription></DialogHeader>
              <div className="space-y-4 text-sm">
                <div className="rounded-lg border bg-slate-50 p-4"><p className="font-semibold text-slate-950">{profile?.full_name || profile?.email || ""}</p><p className="text-slate-500">{roleLabel(profile?.role)}{company ? `, ${company.name}` : ""}</p><p className="mt-2 text-slate-600">{profile?.email}</p></div>
                <div className="rounded-lg border p-4"><DisplayNameForm /></div>
                {canChooseView ? (
                  <Button variant="outline" className="w-full" onClick={() => { window.location.assign("/select-role"); }}>Choose admin, office, or workshop view</Button>
                ) : profile?.secondary_role ? (
                  <Button variant="outline" className="w-full" onClick={() => setActiveRole(activeRole === profile.role ? profile.secondary_role! : profile.role)}>Switch view to {roleLabel(activeRole === profile.role ? profile.secondary_role : profile.role)}</Button>
                ) : null}
                <form onSubmit={changePassword} className="rounded-lg border p-4">
                  <div className="mb-3 flex items-center gap-2 font-semibold text-slate-950"><Lock className="size-4" />Change password</div>
                  <div className="space-y-3">
                    <Input name="currentPassword" type="password" placeholder="Current password" className="h-11" autoComplete="current-password" />
                    <Input name="password" type="password" placeholder="New password" className="h-11" autoComplete="new-password" />
                    <Input name="confirmPassword" type="password" placeholder="Confirm new password" className="h-11" autoComplete="new-password" />
                    <Button type="submit" className="min-h-11 w-full bg-brand text-brand-ink hover:bg-brand-hover">Update Password</Button>
                  </div>
                </form>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        {canChooseView ? (
          <Button variant="outline" className="mt-3 w-full border-brand-ink/20 bg-transparent text-brand-ink hover:border-brand-ink/35 hover:bg-brand-ink/10" onClick={() => { window.location.assign("/select-role"); }}>Choose view</Button>
        ) : profile?.secondary_role ? (
          <Button variant="outline" className="mt-3 w-full border-brand-ink/20 bg-transparent text-brand-ink hover:border-brand-ink/35 hover:bg-brand-ink/10" onClick={() => setActiveRole(activeRole === profile.role ? profile.secondary_role! : profile.role)}>
            Switch view: {roleLabel(activeRole === profile.role ? profile.secondary_role : profile.role)}
          </Button>
        ) : null}
        <Button variant="ghost" className="mt-1 w-full justify-start text-brand-ink/60 hover:bg-brand-ink/10 hover:text-brand-ink" onClick={signOut}><LogOut className="size-4" /> Log out</Button>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col bg-brand desk:flex">
      <SidebarContent />
    </aside>
  );
}
