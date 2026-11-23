// Platform owner Rollouts (module G). Inputs: the raw JSON body of POST /api/platform/rollouts, and what release 167's overview and apply functions
// return. Outputs: the catalogue of switches that can be rolled out, a checked input, whitelisted rows, fixed-wording refusals. Must not change:
// ONLY switches that already exist as "<name>:on" markers in organization_settings.hidden_nav are listed (their marker text is stored in companies'
// settings and is the same text as lib/reports/reports-switch.ts, lib/reports/revenue/revenue-switch.ts, lib/iso/iso-switch.ts,
// lib/jobs/planned-vs-actual-switch.ts, lib/jobs/ncr-register-switch.ts and components/tooly/tour/tour-switch.ts; tests pin each to its source);
// the list is also hard-coded in release 167's functions (a test pins the two together); nothing is on by default; no message from the database is
// ever shown; pure (no React, no I/O). The Sales Orders switch, Xero transfers, the customer portal and customer sign-off are NOT here: they are
// not plain markers (they clear another setting, or need the company's own second step and audit), so they stay with the company's admin.

export type RolloutSwitch = { marker: string; label: string; note: string };

export const ROLLOUT_SWITCHES: readonly RolloutSwitch[] = [
  { marker: "reports:on", label: "Reports", note: "Operations reports (admin and office). Read only." },
  { marker: "reports-revenue:on", label: "Revenue reports", note: "Money figures, admin and office. Rhys's note: ask the company's accountant to sign off the first run." },
  { marker: "iso-templates:on", label: "ISO templates", note: "Draft ISO templates, admin only. Not certification evidence." },
  { marker: "job-time-variance:on", label: "Planned vs actual time", note: "Read-only panel on a job's worksheet." },
  { marker: "job-ncr-register:on", label: "NCR register", note: "Read-only non-conformance register on Jobs." },
  { marker: "tooly-admin-tour:on", label: "Tooly admin tour", note: "First-login tour for admins. Also needs the server flag TOOLY_ADMIN_TOUR_ENABLED." },
];

export const ROLLOUT_MARKERS: readonly string[] = ROLLOUT_SWITCHES.map((s) => s.marker);
export const ROLLOUT_PHASE_MAX = 60;
export const ROLLOUT_COMPANIES_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function switchLabel(marker: string): string {
  return ROLLOUT_SWITCHES.find((s) => s.marker === marker)?.label ?? marker;
}

export type RolloutInput = { switchMarker: string; organizationIds: string[]; on: boolean; phase: string };
export type RolloutCheck = { ok: true; value: RolloutInput } | { ok: false; error: string };

/** A listed switch, 1 to 200 distinct companies, on or off, and an optional phase label. Unknown keys are refused. */
export function checkRolloutInput(body: unknown): RolloutCheck {
  const bad = (error: string): RolloutCheck => ({ ok: false, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Choose a switch and the companies.");
  const { switchMarker, organizationIds, on, phase, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return bad("Choose a switch and the companies.");
  if (typeof switchMarker !== "string" || !ROLLOUT_MARKERS.includes(switchMarker)) return bad("That is not a switch that can be rolled out.");
  if (typeof on !== "boolean") return bad("Say whether to turn it on or off.");
  if (!Array.isArray(organizationIds) || organizationIds.length < 1) return bad("Choose at least one company.");
  if (organizationIds.length > ROLLOUT_COMPANIES_MAX) return bad(`Choose no more than ${ROLLOUT_COMPANIES_MAX} companies at once.`);
  if (organizationIds.some((x) => typeof x !== "string" || !UUID.test(x))) return bad("Choose companies from the list.");
  const ids = (organizationIds as string[]).map((x) => x.toLowerCase());
  if (new Set(ids).size !== ids.length) return bad("Each company can be chosen once.");
  if (phase !== undefined && typeof phase !== "string") return bad("The phase must be text.");
  const label = (typeof phase === "string" ? phase : "").trim();
  if (label.length > ROLLOUT_PHASE_MAX) return bad(`Keep the phase name to ${ROLLOUT_PHASE_MAX} characters or fewer.`);
  return { ok: true, value: { switchMarker, organizationIds: ids, on, phase: label } };
}

export type RolloutCompany = { organizationId: string; name: string; slug: string; status: string; on: string[] };
export type RolloutLogRow = { id: string; createdAt: string; actorEmail: string; switchMarker: string; turnedOn: boolean; phase: string; orgNames: string[]; changed: number };
export type RolloutOverview = { companies: RolloutCompany[]; log: RolloutLogRow[] };

/** The database's overview, whitelisted. Only listed markers are kept in a company's "on" list. Null when it is not the expected shape. */
export function parseRolloutOverview(data: unknown): RolloutOverview | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.companies) || !Array.isArray(d.log)) return null;
  const companies: RolloutCompany[] = [];
  for (const row of d.companies) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.organization_id !== "string" || typeof r.name !== "string" || typeof r.slug !== "string" || typeof r.status !== "string") continue;
    companies.push({ organizationId: r.organization_id, name: r.name, slug: r.slug, status: r.status, on: Array.isArray(r.on) ? r.on.filter((x): x is string => typeof x === "string" && ROLLOUT_MARKERS.includes(x)) : [] });
  }
  const log: RolloutLogRow[] = [];
  for (const row of d.log) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.created_at !== "string" || typeof r.actor_email !== "string" || typeof r.switch !== "string" || typeof r.turned_on !== "boolean" || typeof r.changed !== "number") continue;
    log.push({ id: r.id, createdAt: r.created_at, actorEmail: r.actor_email, switchMarker: r.switch, turnedOn: r.turned_on, phase: typeof r.phase === "string" ? r.phase : "",
      orgNames: Array.isArray(r.org_names) ? r.org_names.filter((x): x is string => typeof x === "string") : [], changed: r.changed });
  }
  return { companies, log };
}

export type RolloutResult = { logId: string; switchMarker: string; turnedOn: boolean; requested: number; changed: number };

/** The apply function's answer, whitelisted. Null when it is not the expected shape. */
export function parseRolloutResult(data: unknown): RolloutResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.log_id !== "string" || typeof d.switch !== "string" || typeof d.turned_on !== "boolean" || typeof d.requested !== "number" || typeof d.changed !== "number") return null;
  return { logId: d.log_id, switchMarker: d.switch, turnedOn: d.turned_on, requested: d.requested, changed: d.changed };
}

export type RolloutRefusal = { status: number; error: string };

/** Fixed wording for what the database refused. Nothing was changed in any of these cases (one transaction). */
export function rolloutRefusal(error: { code?: string | null; hint?: string | null } | null | undefined): RolloutRefusal {
  if (error?.code === "22023" && error.hint === "unknown_switch") return { status: 400, error: "That is not a switch that can be rolled out." };
  if (error?.code === "22023" && error.hint === "company_not_active") return { status: 409, error: "A switch can only be turned on for an active company. Nothing was changed." };
  if (error?.code === "22023") return { status: 400, error: "Check the switch, the companies and the phase name. Nothing was changed." };
  if (error?.code === "P0002") return { status: 404, error: "A chosen company was not found. Reload the page. Nothing was changed." };
  if (error?.code === "42501") return { status: 403, error: "Forbidden" };
  return { status: 500, error: "Couldn't change the switch. Nothing was changed; check the log before trying again." };
}
