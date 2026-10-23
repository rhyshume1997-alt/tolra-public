"use client";

import { UserProvider } from "@/lib/use-user";

export default function SelectRoleLayout({ children }: { children: React.ReactNode }) {
  return <UserProvider>{children}</UserProvider>;
}
