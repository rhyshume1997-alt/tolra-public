/**
 * BOUNDARY (Auth / Company / Users / Admin, Module 1, PREVIEW ONLY, security-critical module). Route /admin/users/preview inside the existing dashboard shell (verified
 * session, sidebar, top bar; middleware already limits /admin routes by role). Input: none (the page takes no params and reads nothing). Output: the Admin > Users
 * look-and-feel prototype with fictional sample data, labelled "Preview, sample data, nothing is saved".
 * Must not change: no auth logic, no session or role read, no data fetching, no server action, no Supabase, e-mail, MFA, password or invite call here, and
 * nothing may ever be wired from this route to real users; no link from the real page to this route; it replaces nothing. Delete the four preview files
 * (this page, components/admin/users/preview/UsersPreview.tsx and .module.css, tests/unit/usersPreview.test.ts) to remove it completely.
 */
import type { Metadata } from "next";

import UsersPreview from "@/components/admin/users/preview/UsersPreview";

export const metadata: Metadata = { title: "User Management preview", robots: { index: false, follow: false } };

export default function UsersPreviewPage() {
  return <UsersPreview />;
}
