"use client";

/**
 * BOUNDARY (Admin > Integrations > confirm the Xero organisation, PREVIEW ONLY: nothing here is wired to anything, and nothing here can connect anything).
 * v2 (claude/portal-admin-v2, owner approved STRUCTURAL-CHANGES-BRIEF items 4, 7, 9, 10, 11): shared PreviewBar and PageHeader replace the local preview pill and h1, text uses the v4 type scale, a row with several actions shows one primary and a More menu, narrow records use the shared StackedRows. Presentation only: wording, controls, states, roles and rules are unchanged.
 * OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md gives Module 6 (Integrations) components/integrations/** but does not name the route
 * app/(dashboard)/admin/integrations/**. By the coordinator's decision the route is treated as Module 6's.
 * Inputs: none from the server. The "organisations" are two made-up names with made-up ids ("sample-org-1"), no real Xero tenant id, token, code or CSRF value exists here.
 * Outputs: the real page's screen: heading, the sentence for one organisation or several, the list of organisations (none selected at first), "Connect this organisation", the
 * problem line, and "Back to Integrations. Nothing is connected until you confirm." It calls NO Supabase, fetch, OAuth or auth code. "Connect this organisation" answers with the
 * neutral "Preview only ... Nothing was saved." toast and nothing is connected: the real success (a redirect to /admin/integrations?xero=connected) is deliberately NOT drawn, and the
 * fresh authenticator-code step the real button needs is not drawn either. The Role control only changes which screen is drawn; it grants nothing.
 * The sentences are the real page's (pinned to its source by tests/unit/adminXeroOrganisationPreview.test.ts); the connect-failed line is the real default wording of
 * lib/integrations/overview.ts connectOutcomeMessage. Connecting never turns transfers on or releases held documents (stated on the real page's header comment).
 * MUST NOT CHANGE: wording, "none is selected", the button disabled until one is chosen, the admin-only rule. Do not wire this to real data, a session or an action, do not add a
 * control the real page lacks, keep every control at a 48 px hit area. Delete the preview files to remove it completely.
 */

import { useCallback, useState } from "react";
import { Button, Callout, LoadingState, Popover, SegmentedControl, ToastProvider, cx, premiumTokens, useToast, PageHeader, PreviewBar } from "@/components/ui/premium";
import { connectOutcomeMessage } from "@/lib/integrations/overview";
import type { UserRole } from "@/types";

import s from "./XeroOrganisationPreview.module.css";

export type Role = UserRole;
export type Screen = "one" | "several" | "loading" | "nothing" | "failed";
export type Org = { tenantId: string; name: string };

/* ---------- the real page's wording (app/(dashboard)/admin/integrations/xero-organisation/page.tsx), pinned by the test ---------- */
export const PAGE_TITLE = "Confirm the Xero organisation";
export const ONE_TEXT = "Tolra can see this Xero organisation. Confirm it is the right one for this company.";
export const SEVERAL_TEXT = "You gave Tolra access to more than one Xero organisation. Choose the one for this company. The others are disconnected again.";
export const NOTHING_TEXT = "There is nothing to choose any more. Click Connect to Xero again.";
export const FAILED_TEXT = connectOutcomeMessage("unknown");
export const BACK_NOTE = "Nothing is connected until you confirm.";
export const UNNAMED = "Unnamed organisation";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
export const canUseXeroOrganisation = (role: Role): boolean => role === "admin";

/** Fictional organisations with made-up ids. */
export const ONE_ORG: Org[] = [{ tenantId: "sample-org-1", name: "Fernhill Fabrication Ltd (sample)" }];
export const SEVERAL_ORGS: Org[] = [{ tenantId: "sample-org-1", name: "Fernhill Fabrication Ltd (sample)" }, { tenantId: "sample-org-2", name: "Brookside Machining Ltd (sample)" }, { tenantId: "sample-org-3", name: "" }];
export const orgsFor = (screen: Screen): Org[] | null => (screen === "one" || screen === "failed" ? ONE_ORG : screen === "several" ? SEVERAL_ORGS : null);
/** The real sentence: one organisation, or (also while nothing has loaded) the several-organisations one. */
export const sentenceFor = (orgs: Org[] | null): string => (orgs && orgs.length === 1 ? ONE_TEXT : SEVERAL_TEXT);

const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "one", label: "One organisation offered" }, { v: "several", label: "Several organisations offered" }, { v: "loading", label: "Loading the offer" },
  { v: "nothing", label: "Nothing to choose any more" }, { v: "failed", label: "Connecting did not work" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));

export default function XeroOrganisationPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("several");
  const [chosen, setChosen] = useState<string | null>(null);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseXeroOrganisation(role);
  const orgs = orgsFor(screen);
  const pick = (v: Screen) => { toast.clear(); setChosen(null); setScreen(v); };
  const reset = () => { toast.clear(); setRole("admin"); setScreen("several"); setChosen(null); };
  const problem = screen === "nothing" ? NOTHING_TEXT : screen === "failed" ? FAILED_TEXT : null;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="xero-organisation-preview" data-role={role} data-screen={screen}>
      <PreviewBar
        data-testid="preview-bar"
        controls={
          <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
            <div className={s.dock}>
              <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted, nothing is connected and no request is made.</p>
              <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
              <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
              <p className={s.dockLabel}>Screen state</p>
              <div className={s.dockStates} role="group" aria-label="Screen state">
                {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pick(x.v)}>{x.label}</button>)}
              </div>
              <Button size="sm" variant="secondary" data-testid="dock-reset" onClick={reset}>Reset preview</Button>
            </div>
          </Popover>
        }
      />
      <PageHeader
        title={denied ? "Access Denied" : PAGE_TITLE}
        description={denied ? "Redirecting you back to the dashboard." : sentenceFor(orgs)}
      />

      {denied ? (
        <section className={s.denied} data-testid="access-denied" aria-label="Access denied">
          <p className={s.deniedNote}>Only an admin can confirm a Xero organisation.</p>
          <p className={s.deniedPreview}>Preview only: no redirect happens here. This page is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <div className={s.stack}>
          {screen === "loading" ? <LoadingState label="Loading…" rows={3} /> : null}
          {orgs ? (
            <fieldset className={s.fieldset} data-testid="xero-organisation-picker">
              <legend className={s.dockLabel} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Xero organisation</legend>
              {orgs.map((o) => (
                <label key={o.tenantId} className={s.option} data-chosen={chosen === o.tenantId}>
                  <input type="radio" name="tenant" value={o.tenantId} checked={chosen === o.tenantId} onChange={() => setChosen(o.tenantId)} />
                  <span>{o.name || UNNAMED}</span>
                </label>
              ))}
              <div className={s.actions}>
                <Button variant="primary" disabled={!chosen} data-testid="connect-organisation" onClick={() => preview("Xero would be asked to connect this organisation, after an authenticator code. Nothing was connected.")}>Connect this organisation</Button>
              </div>
            </fieldset>
          ) : null}
          {problem ? <Callout tone="error" lead="" role="alert">{problem}</Callout> : null}
          <p className={s.back}><a href="/admin/integrations/preview" className={s.link}>Back to Integrations</a>. {BACK_NOTE}</p>
        </div>
      )}
    </div>
  );
}
