"use client";

import { BriefcaseBusiness, ShieldCheck, Wrench } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import type { ElementType } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompanyProfile } from "@/lib/company";
import { useUser } from "@/lib/use-user";
import type { UserRole } from "@/types";
import { PRODUCT } from "@/lib/product";

const roleContent: Record<UserRole, { title: string; description: string; icon: ElementType }> = {
  admin: {
    title: "Admin",
    description: "Everything in the system: the sales pipeline, invoicing and approvals, the job board and machine schedule, delivery notes, customers and suppliers, user management and settings.",
    icon: ShieldCheck,
  },
  office: {
    title: "Office",
    description: "RFQs, quotes, sales orders, invoices, approvals, purchase orders, delivery notes, customers and suppliers, plus the job board and machine schedule.",
    icon: BriefcaseBusiness,
  },
  workshop: {
    title: "Workshop",
    description: "The job board and job sheets (start, finish and inspect jobs), the machine schedule and delivery notes.",
    icon: Wrench,
  },
  viewer: {
    title: "Viewer",
    description: "Read-only view of the job board and machine schedule, without financial or admin controls.",
    icon: BriefcaseBusiness,
  },
};

export default function SelectRolePage() {
  const router = useRouter();
  const { profile, loading, setActiveRole, signOut } = useUser();
  const { profile: company } = useCompanyProfile();

  const roleOptions = useMemo<UserRole[]>(() => {
    if (!profile) return [];
    if (profile.role === "admin") return ["admin", "office", "workshop"];
    return [profile.role, profile.secondary_role].filter(Boolean) as UserRole[];
  }, [profile]);

  useEffect(() => {
    if (!loading && profile && roleOptions.length <= 1) {
      router.replace("/dashboard");
    }
  }, [loading, profile, roleOptions.length, router]);

  function chooseRole(role: UserRole) {
    setActiveRole(role);
    window.location.assign("/dashboard");
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <Skeleton className="mx-auto h-20 w-full max-w-3xl" />
        <Skeleton className="mx-auto mt-6 h-72 w-full max-w-3xl" />
      </div>
    );
  }

  if (!profile) return null;

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center text-center">
        {company?.logoSrc ? <Image src={company.logoSrc} alt={`${company.name} logo`} width={130} height={130} unoptimized className="h-28 w-auto object-contain" priority /> : company ? <p className="text-xl font-bold text-brand">{company.name}</p> : null}
        <Badge className="mt-6 bg-brand text-brand-ink">{PRODUCT.name}</Badge>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-950">Choose Your View</h1>
        <p className="mt-3 max-w-2xl text-slate-500">
          Select how you want to use {PRODUCT.name} today. Admins can switch between every view; each view only shows the areas it needs.
        </p>

        <div className="mt-8 grid w-full gap-4 md:grid-cols-3">
          {roleOptions.map((role) => {
            const item = roleContent[role];
            const Icon = item.icon;
            return (
              <Card key={role} className="cursor-pointer border-slate-200 transition hover:-translate-y-0.5 hover:border-brand-accent hover:bg-blue-50/40 hover:shadow-md" onClick={() => chooseRole(role)}>
                <CardContent className="flex h-full flex-col p-6 text-left">
                  <div className="flex size-12 items-center justify-center rounded-xl bg-brand text-brand-ink">
                    <Icon className="size-6" />
                  </div>
                  <h2 className="mt-5 text-xl font-bold text-slate-950">{item.title}</h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-500">{item.description}</p>
                  <Button className="mt-6 min-h-11 w-full bg-brand text-brand-ink hover:bg-brand-hover" onClick={(event) => { event.stopPropagation(); chooseRole(role); }}>
                    Continue as {item.title}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Button variant="ghost" className="mt-6 min-h-11 text-slate-500" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
