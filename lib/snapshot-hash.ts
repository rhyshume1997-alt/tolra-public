/**
 * Canonical snapshots and their SHA-256 (M4 operator sign-off; a future "site jobs" sign-off reuses it). The TypeScript half of
 * public.canonical_jsonb (migration 045): a DB test proves both give the same text and hash for the same value.
 *
 *  - objects: keys sorted by Unicode code point, rendered {"k":v,...} with no spaces;
 *  - arrays in order; strings escaped exactly as JSON.stringify does; true, false, null;
 *  - numbers (and anything else) are refused: a snapshot holds numbers as their text, so number formatting can't differ.
 */
export type SnapshotValue = string | boolean | null | SnapshotValue[] | { [key: string]: SnapshotValue };

/** Orders two strings by code point (JavaScript's default sort compares UTF-16 code units, which differs above U+FFFF). */
function byCodePoint(a: string, b: string) {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalJson: only plain objects belong in a snapshot");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(byCodePoint).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} can't be in a snapshot (numbers are stored as text)`);
}

/** Lower-case hex SHA-256 of the text's UTF-8 bytes (Web Crypto: the browser and Node 20 alike). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function snapshotSha256(snapshot: unknown): Promise<string> {
  return sha256Hex(canonicalJson(snapshot));
}

/** True when the snapshot still hashes to the stored value. */
export async function verifySnapshot(snapshot: unknown, sha256: string): Promise<boolean> {
  try {
    return (await snapshotSha256(snapshot)) === sha256;
  } catch {
    return false;
  }
}
