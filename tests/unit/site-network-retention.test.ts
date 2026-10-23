/**
 * Clock-in addresses after migration 078 (lib/site-network.ts, components/time/site-network-card.tsx): the app's retention matches the
 * database's (30 days), the card learns whether the database keeps addresses apart (a missing table, or any error, reads as no), and a
 * site network is only ever added by an admin's explicit click: the app writes site_networks through add_site_network only, called from
 * the Settings card's two buttons, never from a load, an effect or a banner.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { SITE_NETWORK_IP_RETENTION_DAYS, loadSiteNetworks, purgeSiteNetworkIps } from "@/lib/site-network";

const ROOT = path.resolve(__dirname, "../..");

/** A stand-in client: each table answers what `answers` gives; rpc records its call. */
function fakeClient(answers: Record<string, { data: unknown; error: unknown }>, calls: unknown[] = []) {
  const query = (table: string) => {
    const result = answers[table] ?? { data: [], error: null };
    const chain = { select: () => chain, order: () => chain, limit: () => chain, maybeSingle: () => chain, then: (ok: (r: unknown) => unknown) => Promise.resolve(result).then(ok) };
    return chain;
  };
  return { from: query, rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data: { removed: 3, all: true, retention_days: 30 }, error: null }; } } as unknown as SupabaseClient;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe("retention", () => {
  it("the app's 30 days is the database's site_network_ip_retention()", () => {
    const file = readdirSync(path.join(ROOT, "supabase/migrations")).find((f) => f.endsWith("_ip_retention_and_crd_numbers.sql"))!;
    const sql = readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
    const m = /FUNCTION public\.site_network_ip_retention\(\)[\s\S]*?SELECT INTERVAL '(\d+) days'/.exec(sql);
    expect(m?.[1]).toBe(String(SITE_NETWORK_IP_RETENTION_DAYS));
    expect(SITE_NETWORK_IP_RETENTION_DAYS).toBe(30);
  });

  it("loadSiteNetworks: ipRetention only when the address table answers", async () => {
    const base = { site_network_settings: { data: { site_network_check: "flag" }, error: null }, site_networks: { data: [], error: null } };
    expect(await loadSiteNetworks(fakeClient({ ...base, attendance_event_network_ips: { data: [], error: null } }))).toEqual({ mode: "flag", networks: [], ipRetention: true });
    expect((await loadSiteNetworks(fakeClient({ ...base, attendance_event_network_ips: { data: null, error: { code: "PGRST205", message: "missing" } } }))).ipRetention).toBe(false);
    expect((await loadSiteNetworks(fakeClient({ ...base, attendance_event_network_ips: { data: null, error: { code: "08006", message: "offline" } } }))).ipRetention).toBe(false);
  });

  it("the card's default deletes only expired addresses; deleting all needs the confirmation that names what goes", () => {
    const card = readFileSync(path.join(ROOT, "components/time/site-network-card.tsx"), "utf8");
    const lines = card.split("\n");
    const expired = lines.filter((l) => l.includes("purgeSiteNetworkIps(supabase!, false)"));
    const all = lines.filter((l) => l.includes("purgeSiteNetworkIps(supabase!, true)"));
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatch(/onClick=\{\(\) =>/);
    expect(all).toHaveLength(1);
    expect(all[0]).not.toMatch(/onClick/);
    // The "Delete all" button only opens the dialog; the dialog's confirm runs the purge of all.
    const dialog = card.slice(card.indexOf("<ConfirmDialog"), card.indexOf("/>", card.indexOf("<ConfirmDialog")));
    expect(dialog).toContain("purgeSiteNetworkIps(supabase!, true)");
    expect(dialog).toContain("Delete every kept clock-in address?");
    expect(dialog).toMatch(/including those from the last \$\{SITE_NETWORK_IP_RETENTION_DAYS\} days/);
    expect(card).toContain("onClick={() => setConfirmPurgeAll(true)}");
  });

  it("purgeSiteNetworkIps calls the admin purge with p_all", async () => {
    const calls: unknown[] = [];
    expect(await purgeSiteNetworkIps(fakeClient({}, calls), true)).toMatchObject({ removed: 3 });
    expect(calls).toEqual([["purge_site_network_ips", { p_all: true }]]);
  });
});

describe("a seen address never becomes a site network by itself", () => {
  const sources = ["app", "components", "lib"].flatMap((d) => files(path.join(ROOT, d))).map((f) => ({ f: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

  it("nothing writes site_networks directly; add_site_network is called from lib/site-network.ts only", () => {
    for (const { f, text } of sources) {
      expect(/from\(\s*["']site_networks["']\s*\)\s*\.\s*(insert|upsert|update)/.test(text), f).toBe(false);
      if (f !== path.join("lib", "site-network.ts")) expect(text.includes("add_site_network"), f).toBe(false);
    }
  });

  it("addSiteNetwork is only called from the Settings card's two buttons (onClick), never on load", () => {
    const callers = sources.filter(({ text, f }) => f !== path.join("lib", "site-network.ts") && /\baddSiteNetwork\(/.test(text));
    expect(callers.map((c) => c.f)).toEqual([path.join("components", "time", "site-network-card.tsx")]);
    const card = callers[0].text;
    const lines = card.split("\n").filter((l) => /\baddSiteNetwork\(/.test(l));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/onClick=\{\(\) =>/);
    // "Use the network I'm on now" (network null: the request's address) is one of them, an explicit button.
    expect(card).toContain("Use the network I&apos;m on now");
  });
});
