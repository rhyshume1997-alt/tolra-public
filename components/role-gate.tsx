"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/lib/use-user";
import type { UserRole } from "@/types";

type RoleGateProps = {
  allowed: UserRole[];
  children: React.ReactNode;
};

export function RoleGate({ allowed, children }: RoleGateProps) {
  const router = useRouter();
  const { profile, loading, activeRole } = useUser();
  // activeRole is validated against the profile in lib/use-user.ts; never read localStorage here.
  const allowedIn = Boolean(profile) && allowed.includes(activeRole);

  useEffect(() => {
    if (!loading && profile && !allowedIn) {
      const timeout = window.setTimeout(() => router.push("/dashboard"), 2000);
      return () => window.clearTimeout(timeout);
    }
  }, [allowedIn, loading, profile, router]);

  if (loading) return <Skeleton className="h-80" />;
  if (!allowedIn) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <h1 className="text-2xl font-bold text-slate-950">Access Denied</h1>
          <p className="mt-2 text-sm text-slate-500">Redirecting you back to the dashboard.</p>
        </CardContent>
      </Card>
    );
  }

  return <>{children}</>;
}
