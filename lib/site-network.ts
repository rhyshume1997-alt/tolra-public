/**
 * Site network check, phase 1 (migration 075, B40 / G21): RECORD AND FLAG ONLY, OFF by default.
 *
 * A browser can't read the Wi-Fi name, so the only check is the public IP address a clock action reaches the server from: every
 * device on the site Wi-Fi goes out through the router's one public IP. The SERVER reads it (PostgREST's request headers,
 * cf-connecting-ip), never the phone, and only for people an admin marked "On site only", only while the company's switch is "Flag".
 * Off site is flagged for the office, never refused. A clock action queued offline and synced later is "synced later, network unknown".
 *
 * Every call here goes from the BROWSER straight to Supabase (never through a Next.js server route), so the IP the database sees is
 * the device's own; "Use the network I'm on now" therefore saves the network of the device pressing it.
 *
 * The parsing below mirrors the database's (site_network_parse / site_network_host) so the Settings card can explain a typing mistake
 * before saving and show whether this device is on a saved network; the database decides.
 *
 * Migration 078: the address of each checked clock action is kept apart from the check (attendance_event_network_ips, never in the
 * audit log) for SITE_NETWORK_IP_RETENTION_DAYS, then deleted; the status and the off-site flag are kept. A seen address never becomes a
 * site network by itself: only an admin's explicit save (addSiteNetwork, from the "Use this network" button on the Settings card) adds one.
 *
 * Migration 128: an admin renames a saved network (renameSiteNetwork; the address and the site_networks row never change: the name is kept
 * in site_network_names and shown in place of the saved label), and online clock actions refused by
 * 114's network lock are recorded (clock_in_network_refusals, admin read only; reported by the device, lib/clock-in-lock.ts
 * reportClockInRefusal, and re-checked by the database), so the "unrecognised network" banner counts them too.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** How long the database keeps a clock-in address (078's site_network_ip_retention(); tests/unit/site-network-retention.test.ts checks they match). */
export const SITE_NETWORK_IP_RETENTION_DAYS = 30;

export type IpFamily = 4 | 6;
export type Ip = { family: IpFamily; value: bigint };
export type Network = { family: IpFamily; base: bigint; prefix: number };
export type NetworkProblem = "bad_network" | "too_broad" | "private_network";

/** BigInt without literals (the build targets below ES2020). */
const big = (x: number) => BigInt(x);
const BITS: Record<IpFamily, number> = { 4: 32, 6: 128 };
const MIN_PREFIX: Record<IpFamily, number> = { 4: 16, 6: 32 };

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = big(0);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << big(8)) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  let s = text.toLowerCase();
  // An embedded IPv4 tail (::ffff:203.0.113.7) becomes two groups.
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> big(16)).toString(16)}:${(v4 & big(0xffff)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return all.reduce((acc, g) => (acc << big(16)) | BigInt(parseInt(g, 16)), big(0));
}

const MAPPED_PREFIX = big(0xffff) << big(32);
const isMapped = (v6: bigint) => v6 >> big(32) === big(0xffff);

/** A single address (IPv4, IPv6, or IPv4-mapped IPv6 returned as IPv4), or null. */
export function parseIp(text: string | null | undefined): Ip | null {
  const s = (text ?? "").trim();
  if (!s || s.length > 64 || s.includes("/")) return null;
  const v4 = parseIpv4(s);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = s.includes(":") ? parseIpv6(s) : null;
  if (v6 === null) return null;
  return isMapped(v6) ? { family: 4, value: v6 & big(0xffffffff) } : { family: 6, value: v6 };
}

const maskOf = (family: IpFamily, prefix: number) => {
  const bits = BigInt(BITS[family]);
  const all = (big(1) << bits) - big(1);
  return prefix === 0 ? big(0) : (all >> (bits - BigInt(prefix))) << (bits - BigInt(prefix));
};

/**
 * Ranges a public server never sees as a client address, or that don't name a site (the database's site_network_private): private,
 * loopback, link-local, CGNAT, IETF protocol assignments, benchmarking, NAT64, 6to4, unique-local, multicast, reserved.
 */
const PRIVATE: string[] = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3", "::/127", "64:ff9b::/96", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"];
let privateNets: Network[] | null = null;
const overlaps = (a: Network, b: Network) => {
  if (a.family !== b.family) return false;
  const prefix = Math.min(a.prefix, b.prefix);
  const mask = maskOf(a.family, prefix);
  return (a.base & mask) === (b.base & mask);
};

function rawNetwork(text: string): Network | null {
  const [addr, len, extra] = text.trim().split("/");
  if (extra !== undefined) return null;
  const s = addr.trim();
  const v4 = parseIpv4(s);
  let family: IpFamily;
  let value: bigint;
  if (v4 !== null) {
    family = 4;
    value = v4;
  } else {
    const v6 = s.includes(":") ? parseIpv6(s) : null;
    if (v6 === null) return null;
    family = 6;
    value = v6;
  }
  let prefix = BITS[family];
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len.trim())) return null;
    prefix = Number(len.trim());
    if (prefix > BITS[family]) return null;
  }
  if (family === 6 && (value & ~big(0xffffffff)) === MAPPED_PREFIX) {
    if (prefix !== 128) return null; // a mapped range: type it as IPv4
    return { family: 4, base: value & big(0xffffffff), prefix: 32 };
  }
  return { family, base: value & maskOf(family, prefix), prefix };
}

/** A site network as the database would save it (host bits cleared), or why it would be refused. */
export function parseNetwork(text: string | null | undefined): { ok: true; network: Network } | { ok: false; problem: NetworkProblem } {
  const s = (text ?? "").trim();
  if (!s || s.length > 64) return { ok: false, problem: "bad_network" };
  const network = rawNetwork(s);
  if (!network) return { ok: false, problem: "bad_network" };
  if (network.prefix < MIN_PREFIX[network.family]) return { ok: false, problem: "too_broad" };
  privateNets ??= PRIVATE.map((p) => rawNetwork(p)!);
  if (privateNets.some((p) => overlaps(p, network))) return { ok: false, problem: "private_network" };
  return { ok: true, network };
}

export const NETWORK_PROBLEM_TEXT: Record<NetworkProblem, string> = {
  bad_network: "Enter a public IP address, or a range such as 203.0.113.0/28.",
  too_broad: "That range is too broad (at most /16 for IPv4, /32 for IPv6).",
  private_network: "That is a private or local address. Use the public address the site's internet comes from (Use the network I'm on now).",
};

/** True when the address is inside the network (same family). */
export function ipInNetwork(ip: Ip | null, network: Network | null): boolean {
  if (!ip || !network || ip.family !== network.family) return false;
  return (ip.value & maskOf(network.family, network.prefix)) === network.base;
}

/** True when the address is inside any of the saved networks (as text, e.g. from site_networks.network). */
export function onSavedNetwork(ipText: string | null | undefined, networks: string[]): boolean {
  const ip = parseIp(ipText);
  return networks.some((n) => {
    const parsed = rawNetwork(n);
    return parsed ? ipInNetwork(ip, parsed) : false;
  });
}

/** The network as text: dotted IPv4, or IPv6 with the longest run of zero groups shortened to "::"; then "/prefix". */
export function formatNetwork(n: Network): string {
  if (n.family === 4) return `${[big(24), big(16), big(8), big(0)].map((s) => ((n.base >> s) & big(0xff)).toString()).join(".")}/${n.prefix}`;
  const groups = Array.from({ length: 8 }, (_, i) => Number((n.base >> BigInt(112 - 16 * i)) & big(0xffff)));
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > best.len && j - i >= 2) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  const text = best.at < 0 ? hex.join(":") : `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.len).join(":")}`;
  return `${text}/${n.prefix}`;
}

// ----- database calls (browser client only: the server must see the device's own address) ---------------------------------------------
export type SiteNetworkMode = "off" | "flag";
export type SavedNetwork = { id: string; network: string; label: string; created_at: string };
export type RequestNetwork = { ip: string | null; network: string | null; private: boolean | null; on_saved_network: boolean };
export const NETWORK_STATUS_TEXT: Record<string, string> = {
  on_site: "On the site network",
  off_site: "Not on the site network",
  synced_later: "Synced later, network unknown",
  unknown: "Network unknown",
};

type Db = SupabaseClient;

/**
 * The switch (no row: off), the saved networks, and whether the database keeps clock-in addresses apart for a limited time (078:
 * `ipRetention`; a GET of at most one row of attendance_event_network_ips, never head-only; any error, a missing table (075 only)
 * included, reads as false, so the card never claims a deletion the database may not do). Admin and office can read
 * them. Throws on a read error of the switch or the networks.
 */
export async function loadSiteNetworks(client: Db): Promise<{ mode: SiteNetworkMode; networks: SavedNetwork[]; ipRetention: boolean; canRename: boolean }> {
  const [settings, networks, kept, names] = await Promise.all([
    client.from("site_network_settings").select("site_network_check").maybeSingle(),
    client.from("site_networks").select("id, network, label, created_at").order("created_at", { ascending: true }),
    client.from("attendance_event_network_ips").select("event_id").limit(1),
    // 128: the names admins gave the networks (site_network_names; admin and office read them). It also tells whether the database has
    // 128: any error, a missing table included, reads as no (no names, and the Rename action stays hidden).
    client.from("site_network_names").select("network_id, label"),
  ]);
  if (settings.error) throw settings.error;
  if (networks.error) throw networks.error;
  const mode = (settings.data as { site_network_check?: string } | null)?.site_network_check === "flag" ? "flag" : "off";
  const given = new Map(names.error ? [] : ((names.data ?? []) as { network_id: string; label: string }[]).map((n) => [n.network_id, n.label]));
  const saved = ((networks.data ?? []) as SavedNetwork[]).map((n) => (given.has(n.id) ? { ...n, label: given.get(n.id)! } : n));
  return { mode, networks: saved, ipRetention: !kept.error, canRename: !names.error };
}

async function call<T>(client: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const myRequestNetwork = (client: Db) => call<RequestNetwork>(client, "my_request_network");
/** network null: "Use the network I'm on now" (the server saves the address this request comes from). */
export const addSiteNetwork = (client: Db, clientOpId: string, network: string | null, label: string | null) =>
  call<{ id: string; network: string; label: string; added: boolean }>(client, "add_site_network", { p_client_op_id: clientOpId, p_network: network, p_label: label });
export const removeSiteNetwork = (client: Db, clientOpId: string, id: string) => call(client, "remove_site_network", { p_client_op_id: clientOpId, p_id: id });
/** The longest name a network can have (the database's rename_site_network and site_networks.label: 1 to 60 characters, trimmed). */
export const SITE_NETWORK_LABEL_MAX = 60;
/** Admin, two-step (128): a saved network's new name, trimmed, 1 to 60 characters. Keyed: the same key and name answer the first result. */
export const renameSiteNetwork = (client: Db, clientOpId: string, id: string, label: string) =>
  call<{ id: string; network: string; label: string; renamed: boolean; replayed: boolean }>(client, "rename_site_network", { p_client_op_id: clientOpId, p_id: id, p_label: label.trim() });
export const setSiteNetworkCheck = (client: Db, clientOpId: string, mode: SiteNetworkMode) => call(client, "set_site_network_check", { p_client_op_id: clientOpId, p_mode: mode });
/** Admin: delete the company's kept clock-in addresses now (078): those past the retention period, or (all) every one. */
export const purgeSiteNetworkIps = (client: Db, all: boolean) =>
  call<{ removed: number; all: boolean; retention_days: number }>(client, "purge_site_network_ips", { p_all: all });
export const setOnSiteOnly = (client: Db, clientOpId: string, userId: string, onSiteOnly: boolean) =>
  call(client, "set_member_on_site_only", { p_client_op_id: clientOpId, p_user: userId, p_on_site_only: onSiteOnly });

/** Who is "On site only" in the caller's company (admin and office see everyone's). Throws on a read error. */
export async function loadOnSiteOnly(client: Db): Promise<Set<string>> {
  const { data, error } = await client.from("site_network_members").select("user_id, on_site_only").eq("on_site_only", true);
  if (error) throw error;
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}

// ----- the "unrecognised network" banner (admin, dashboard and Time pages) ---------------------------------------------------------------
/** Clock actions from an unrecognised network are counted over this many days. */
export const UNRECOGNISED_NETWORK_WINDOW_DAYS = 7;
export type UnrecognisedClockAction = { event_id: string; checked_at: string };

/**
 * The clock actions of the last 7 days that came from a network that is not a saved site network: 075's checks with status off_site
 * (written only while the Flag check is on; admin and office read them) and, with 128, the online clock actions 114's network lock
 * refused (clock_in_network_refusals, status refused_unrecognised; the company's admins read them). Newest first. Throws on a read error
 * of the checks; a refusal read that fails (no 128 yet) adds nothing.
 */
export async function loadUnrecognisedClockActions(client: Db, now: Date = new Date()): Promise<UnrecognisedClockAction[]> {
  const since = new Date(now.getTime() - UNRECOGNISED_NETWORK_WINDOW_DAYS * 86_400_000).toISOString();
  const [checks, refused] = await Promise.all([
    client.from("attendance_event_networks").select("event_id, checked_at")
      .eq("status", "off_site").gte("checked_at", since).order("checked_at", { ascending: false }).limit(500),
    client.from("clock_in_network_refusals").select("id, attempted_at")
      .eq("status", "refused_unrecognised").gte("attempted_at", since).order("attempted_at", { ascending: false }).limit(500),
  ]);
  if (checks.error) throw checks.error;
  const rows = (checks.data ?? []) as UnrecognisedClockAction[];
  const refusals = refused.error ? [] : ((refused.data ?? []) as { id: string; attempted_at: string }[]).map((r) => ({ event_id: r.id, checked_at: r.attempted_at }));
  return [...rows, ...refusals].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at));
}

/**
 * What the banner shows: the clock actions newer than the batch the admin last dismissed (an ISO time; null: none dismissed). A later
 * clock action from an unrecognised network is a new batch and shows the banner again. Null: nothing to show.
 */
export function unrecognisedBatch(rows: UnrecognisedClockAction[], dismissedUpTo: string | null): { count: number; latest: string } | null {
  const after = dismissedUpTo ? Date.parse(dismissedUpTo) : Number.NEGATIVE_INFINITY;
  const fresh = rows.filter((r) => Date.parse(r.checked_at) > after);
  if (!fresh.length) return null;
  const latest = fresh.reduce((a, r) => (Date.parse(r.checked_at) > Date.parse(a) ? r.checked_at : a), fresh[0].checked_at);
  return { count: fresh.length, latest };
}

export function unrecognisedBannerText(count: number): string {
  return `${count === 1 ? "1 clock-in came" : `${count} clock-ins came`} from a network Tolra doesn't recognise. If the workshop's internet address changed, stand on the workshop Wi-Fi and click Use this network.`;
}
