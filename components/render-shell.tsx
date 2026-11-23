"use client";
// DO NOT MERGE: preview hub. Inputs: children (one preview). Output: the real Sidebar and Topbar with the real shell layout classes around it,
// a fake signed-in admin whose role switcher works in memory, and a "UI preview, sample data, nothing is saved" note. No Supabase, no auth, no network.
// Must not be merged into any product branch.
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { ThemeColour } from "@/components/theme-colour";
import { __UserContext } from "@/lib/use-user";

const profile = { id: "u-sam", email: "sam@example.test", full_name: "Sam Okoro", role: "admin", secondary_role: null, organization_id: "org-1", organization: "Example Eng. Ltd", workshop_email: null, active: true };

export function RenderShell({ children }: { children: React.ReactNode }) {
  type Role = "admin" | "office" | "workshop" | "viewer";
  const [activeRole, setRole] = useState<Role>("admin");
  // The chosen role is kept for the tab (sessionStorage, no network) so it survives moving between previews.
  useEffect(() => { try { const r = window.sessionStorage.getItem("hub-role"); if (r === "admin" || r === "office" || r === "workshop" || r === "viewer") setRole(r); } catch { /* storage off: in-memory only */ } }, []);
  const setActiveRole = (r: Role) => { setRole(r); try { window.sessionStorage.setItem("hub-role", r); } catch { /* ignore */ } };
  const value = {
    user: { id: "u-sam", email: "sam@example.test" }, profile, organizations: [], switchOrganization: async () => true, loading: false, error: null, activeRole,
    setActiveRole, signOut: async () => {}, hasRole: () => true, hasAnyRole: (roles: string[]) => roles.includes(activeRole), hiddenSections: [], session: null, updateDisplayName: async () => {},
  };
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <__UserContext.Provider value={value as any}>
      <div className="min-h-screen bg-canvas">
        <Sidebar />
        <ThemeColour />
        <div className="min-h-screen desk:pl-[248px]">
          <Topbar />
          <main className="w-full px-4 py-6 md:px-6 md:py-8 desk:px-8 desk:py-8">
            <p data-testid="hub-note" style={{ margin: "0 0 16px", fontSize: 12, lineHeight: "18px", color: "#566074" }}>
              <strong>UI preview, sample data, nothing is saved.</strong> Fake signed-in admin; nothing here talks to a server. <a href="/preview-hub" style={{ textDecoration: "underline" }}>All previews</a>
              {" "}
              <label style={{ marginLeft: 8 }}>Sidebar role:{" "}
                <select data-testid="hub-role" aria-label="Sidebar role (fake)" value={activeRole} onChange={(e) => setActiveRole(e.target.value as Role)} style={{ font: "inherit", padding: "2px 4px" }}>
                  <option value="admin">Admin</option><option value="office">Office</option><option value="workshop">Workshop</option><option value="viewer">Viewer</option>
                </select>
              </label>
            </p>
            {children}
          </main>
        </div>
      </div>
    </__UserContext.Provider>
  );
}
