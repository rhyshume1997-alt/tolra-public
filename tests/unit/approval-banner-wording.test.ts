import { createElement,type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it,vi } from "vitest";

vi.mock("@/lib/supabase",()=>({supabase:null}));
vi.mock("@/lib/org-settings",()=>({useColumnVisibility:()=>({isVisible:()=>true})}));
vi.mock("@/components/column-toggle",()=>({ColumnToggle:()=>null}));
vi.mock("@/components/reopen-approvals",()=>({ReopenApprovals:()=>null}));
vi.mock("@/components/role-gate",()=>({RoleGate:({allowed,children}:{allowed:string[];children:ReactNode})=>{
  expect(allowed).toEqual(["admin","office"]);return children;
}}));
import ApprovalPage from "@/app/(dashboard)/approval/page";

it("renders setup-neutral review and sending instructions rather than claiming email is unavailable",()=>{
  const html=renderToStaticMarkup(createElement(ApprovalPage));
  const banner=html.match(/<p class="text-sm font-medium text-blue-950">([\s\S]*?)<\/p>/)?.[1];
  expect(banner).toBeDefined();
  expect(banner).toContain("Check each draft before sending.");
  expect(banner).toContain("Chase reminders can be approved and sent here when email sending is set up.");
  expect(banner).toContain("To send a draft yourself, copy it or open it in your email app, then choose Mark as Sent Manually after you have sent it.");
  expect(banner).not.toMatch(/Email sending isn(?:&#x27;|&apos;|')t set up yet/);
  expect(banner).not.toMatch(/email sending is (?:available|unavailable|connected|disconnected)/i);
});
