/**
 * Site network addresses (migration 075, lib/site-network.ts): the app's parsing mirrors the database's site_network_parse and
 * site_network_host (tests/db/site-network.test.ts proves the database side): IPv4, IPv6 (compressed, embedded IPv4, IPv4-mapped),
 * CIDR with host bits cleared, the private / too-broad refusals, and matching.
 */
import { describe, expect, it } from "vitest";

import { formatNetwork, ipInNetwork, onSavedNetwork, parseIp, parseNetwork } from "@/lib/site-network";

const net = (text: string) => {
  const r = parseNetwork(text);
  if (!r.ok) throw new Error(`${text}: ${r.problem}`);
  return r.network;
};

describe("addresses", () => {
  it("IPv4, IPv6 and IPv4-mapped IPv6 (returned as IPv4); anything else is not an address", () => {
    expect(parseIp("203.0.113.7")).toEqual({ family: 4, value: BigInt(0xcb007107) });
    expect(parseIp(" 198.51.100.1 ")).toMatchObject({ family: 4 });
    expect(parseIp("::ffff:203.0.113.7")).toEqual({ family: 4, value: BigInt(0xcb007107) });
    expect(parseIp("2001:db8::5")).toMatchObject({ family: 6 });
    expect(parseIp("2001:DB8:0:0:0:0:0:5")).toEqual(parseIp("2001:db8::5"));
    expect(parseIp("::1")).toMatchObject({ family: 6, value: BigInt(1) });
    for (const bad of ["", "junk", "256.1.1.1", "1.2.3", "1.2.3.4.5", "2001:db8::1::2", "2001:db8:0:0:0:0:0:0:1", "12345::", "10.0.0.0/8", null, undefined]) {
      expect(parseIp(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("networks (CIDR)", () => {
  it("host bits are cleared; a single address is /32 or /128; a mapped address is IPv4", () => {
    expect(formatNetwork(net("203.0.113.9/28"))).toBe("203.0.113.0/28");
    expect(formatNetwork(net("203.0.113.7"))).toBe("203.0.113.7/32");
    expect(formatNetwork(net("2001:db8:1:2::77/64"))).toBe("2001:db8:1:2::/64");
    expect(formatNetwork(net("2001:db8:1:2:aaaa:bbbb:cccc:dddd"))).toBe("2001:db8:1:2:aaaa:bbbb:cccc:dddd/128");
    expect(formatNetwork(net("::ffff:198.51.100.4"))).toBe("198.51.100.4/32");
  });

  it("refuses text that isn't one, private and local ranges, and anything broader than /16 or /32", () => {
    expect(parseNetwork("workshop")).toEqual({ ok: false, problem: "bad_network" });
    expect(parseNetwork("203.0.113.0/33")).toEqual({ ok: false, problem: "bad_network" });
    expect(parseNetwork("203.0.113.0/2/3")).toEqual({ ok: false, problem: "bad_network" });
    expect(parseNetwork("::ffff:198.51.100.0/120")).toEqual({ ok: false, problem: "bad_network" });
    for (const p of ["192.168.1.1", "10.1.2.3", "172.16.5.4", "100.64.1.1", "127.0.0.1", "169.254.1.1", "fe80::1", "fd00::1", "::1", "224.0.0.1",
      "198.18.0.1", "198.19.255.255", "192.0.0.9", "64:ff9b::203.0.113.7", "2002:cb00:7107::1", "2002:cb00::/32"]) {
      expect(parseNetwork(p), p).toEqual({ ok: false, problem: "private_network" });
    }
    expect(parseNetwork("8.0.0.0/8")).toEqual({ ok: false, problem: "too_broad" });
    expect(parseNetwork("2001::/16")).toEqual({ ok: false, problem: "too_broad" });
    expect(parseNetwork("203.0.0.0/16")).toMatchObject({ ok: true });
    expect(parseNetwork("2001:db8::/32")).toMatchObject({ ok: true });
    expect(parseNetwork("192.0.2.1")).toMatchObject({ ok: true });
    expect(parseNetwork("198.20.0.1")).toMatchObject({ ok: true });
  });
});

describe("matching", () => {
  it("IPv4 inside and outside a range; a single address; IPv4-mapped compares as IPv4", () => {
    const range = net("203.0.113.0/28");
    expect(ipInNetwork(parseIp("203.0.113.0"), range)).toBe(true);
    expect(ipInNetwork(parseIp("203.0.113.15"), range)).toBe(true);
    expect(ipInNetwork(parseIp("203.0.113.16"), range)).toBe(false);
    expect(ipInNetwork(parseIp("::ffff:203.0.113.5"), range)).toBe(true);
    expect(ipInNetwork(parseIp("203.0.113.7"), net("203.0.113.7"))).toBe(true);
    expect(ipInNetwork(parseIp("203.0.113.8"), net("203.0.113.7"))).toBe(false);
  });

  it("IPv6 inside the /64 (any interface id), a neighbouring /64 not; families never cross", () => {
    const site = net("2001:db8:1:2::/64");
    expect(ipInNetwork(parseIp("2001:db8:1:2:1234:5678:9abc:def0"), site)).toBe(true);
    expect(ipInNetwork(parseIp("2001:db8:1:3::1"), site)).toBe(false);
    expect(ipInNetwork(parseIp("203.0.113.5"), site)).toBe(false);
    expect(ipInNetwork(parseIp("2001:db8:1:2::1"), net("203.0.113.0/28"))).toBe(false);
    expect(ipInNetwork(null, site)).toBe(false);
  });

  it("onSavedNetwork reads the database's text form", () => {
    const saved = ["203.0.113.0/28", "2001:db8:1:2::/64"];
    expect(onSavedNetwork("203.0.113.9", saved)).toBe(true);
    expect(onSavedNetwork("2001:db8:1:2::abcd", saved)).toBe(true);
    expect(onSavedNetwork("198.51.100.9", saved)).toBe(false);
    expect(onSavedNetwork(null, saved)).toBe(false);
    expect(onSavedNetwork("203.0.113.9", [])).toBe(false);
  });
});
