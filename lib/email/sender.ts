/** A server sender setting must name one complete mailbox, without header controls. */
export function parseSender(value: string | undefined): { address: string; domain: string } | null {
  const raw = (value ?? "").trim();
  if (/[\r\n\u2028\u2029\0]/.test(value ?? "")) return null;
  const address = raw.includes("<") ? /^[^<>]*<([^<>]+)>$/.exec(raw)?.[1] : raw;
  if (!address || address.length > 254) return null;
  const match = /^([^\s@<>,;"\\]+@([^\s@<>,;"\\]+\.[^\s@<>,;"\\]+))$/.exec(address);
  return match ? { address: match[1].toLowerCase(), domain: match[2].toLowerCase() } : null;
}
