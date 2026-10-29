"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Bell, LogOut, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { ShellStatusChip } from "@/components/shell-status";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { SidebarContent } from "@/components/sidebar";
import { SyncStatus } from "@/components/sync-status";
import { useCanOpen } from "@/lib/use-destinations";
import { useUser } from "@/lib/use-user";
import { useIsWide } from "@/lib/view-mode";
import { isCompanyPending } from "@/lib/brand-pending";
import { useShellCompany } from "@/lib/company";
import { PRODUCT } from "@/lib/product";

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/email": "Email & Payment Automation",
  "/rfq": "RFQ Control Centre",
  "/quotes": "Quote Generator",
  "/jobs": "Job Board",
  "/schedule": "Machine Schedule",
  "/time": "Weekly hours",
  "/time/week": "Weekly hours",
  "/time/print": "Print weekly hours: today",
  "/time/week/print": "Print weekly hours: week",
  "/jobs/1/print": "Print Job Sheet",
  "/invoices": "Invoicing",
  "/approval": "Approval Queue",
  "/sales-orders": "Sales Orders",
  "/purchase-orders": "Purchase Orders",
  "/delivery-notes": "Delivery Notes",
  "/customers": "Customers",
  "/suppliers": "Suppliers",
  "/admin/users": "User Management",
  "/admin/compliance": "Security",
  "/admin/activity": "Activity",
  "/admin/data": "Data",
  "/admin/integrations": "Integrations",
  "/settings": "Settings",
};

export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useUser();
  // The drawer (navigation up to 1024px). Closes on navigation, and when the screen grows into the fixed-sidebar layout.
  const [menuOpen, setMenuOpen] = useState(false);
  const wide = useIsWide();
  useEffect(() => { setMenuOpen(false); }, [pathname, wide]);
  const canOpen = useCanOpen();
  // The bell opens the approval queue: shown only when that page opens for this person in this view.
  const canSeeApprovals = canOpen("/approval");
  const { profile: company, loading: companyLoading } = useShellCompany();
  // A page without its own title shows the company, never the product name in its place; a placeholder bar until the company is known.
  const pending = !pageTitles[pathname] && isCompanyPending(company, companyLoading);
  const title = pageTitles[pathname] ?? company?.name ?? PRODUCT.name;

  return (
    <header className="sticky top-0 z-30 flex h-16 print:hidden items-center justify-between border-b border-line bg-canvas/85 px-4 backdrop-blur-md md:px-6 desk:px-10">
      <div className="flex min-w-0 items-center gap-1 sm:gap-2">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="desk:hidden" aria-label="Open menu"><Menu className="size-5" /></Button>
          </SheetTrigger>
          {/* Radix focuses the first focusable thing on open, which is the "Switch organisation" select at the top of the drawer: on a phone that
              looks like the menu button opened the company selector. Focus the drawer itself; the select reacts only to its own taps. */}
          <SheetContent side="left" className="w-[280px] border-0 p-0" showCloseButton onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
            <SidebarContent onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>
        {pathname !== "/dashboard" ? (
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => router.back()}>
            <ArrowLeft className="size-[18px]" strokeWidth={1.75} />
          </Button>
        ) : null}
        {pending ? <div data-testid="title-pending" aria-hidden="true" className="h-3 w-28 animate-pulse rounded-none bg-muted-foreground/15" /> : <p className="label-mono truncate text-muted-foreground">{title}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <SyncStatus />
        {canSeeApprovals ? (
          <Button asChild variant="ghost" size="icon" aria-label="Notifications">
            <Link href="/approval"><Bell className="size-[18px]" strokeWidth={1.75} /></Link>
          </Button>
        ) : null}
        <ShellStatusChip className="desk:hidden" onOpen={() => setMenuOpen(true)} />
        <Button variant="outline" size="sm" className="hidden desk:inline-flex" onClick={signOut}>
          <LogOut className="size-3.5" /> Log out
        </Button>
        <Button variant="ghost" size="icon" className="desk:hidden" aria-label="Log out" onClick={signOut}><LogOut className="size-[18px]" /></Button>
      </div>
    </header>
  );
}
