/**
 * Deterministic pseudo-random numbers for the PQ seed generator. No Math.random, no clock: the same seed string always gives the
 * same stream (xmur3 string hash feeding mulberry32). Not cryptographic; the data it drives is synthetic by design.
 */
function xmur3(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function hashHex8(text) {
  return xmur3(text)().toString(16).padStart(8, "0");
}

export function makeRng(seedText) {
  const seed = xmur3(String(seedText));
  let a = seed();
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  const chance = (p) => next() < p;
  const uuid = () => {
    const hex = Array.from({ length: 32 }, () => int(0, 15).toString(16)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { next, int, pick, chance, uuid, fork: (label) => makeRng(`${seedText}/${label}`) };
}
