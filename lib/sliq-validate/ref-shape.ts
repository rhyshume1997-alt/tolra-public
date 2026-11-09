/**
 * The confirmed invoice-ref shape (mapping.invoiceRefPattern), checked in linear time.
 *
 * It is NOT a JavaScript regular expression: a mapping-supplied RegExp can backtrack exponentially ("(a+)+$" took 127 s on a
 * 40-character ref and froze the tab). The shape is a small subset that reads like one:
 *   - literal characters: letters, digits, space, "-", "_", "/", "." (a backslash before "-", "_", "/", "." or space is allowed);
 *   - \d (one ASCII digit), optionally followed by {n}, {n,m}, +, * or ?.
 * Nothing else (no groups, alternation, classes or anchors: the whole ref must match). Matching is a set simulation of the
 * tokens, so its time is at most (ref length) x (number of tokens) steps, whatever the pattern.
 */
type Token = { digit: false; ch: string } | { digit: true; min: number; max: number };

export const REF_SHAPE_MAX_LENGTH = 100;
const MAX_REPEAT = 30;
const LITERAL = /^[A-Za-z0-9 _/.-]$/;
const ESCAPABLE = new Set(["-", "_", "/", ".", " "]);

export type RefShape = { test: (ref: string) => boolean; source: string };

/** The compiled shape, or null when the source uses anything outside the subset above. */
export function compileRefShape(source: string): RefShape | null {
  if (typeof source !== "string" || source.length === 0 || source.length > REF_SHAPE_MAX_LENGTH) return null;
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      const e = source[i + 1];
      if (e === "d") {
        i += 2;
        let min = 1;
        let max = 1;
        const q = source[i];
        if (q === "+") { max = Infinity; i += 1; }
        else if (q === "*") { min = 0; max = Infinity; i += 1; }
        else if (q === "?") { min = 0; i += 1; }
        else if (q === "{") {
          const m = /^\{(\d{1,2})(?:,(\d{1,2}))?\}/.exec(source.slice(i, i + 8));
          if (!m) return null;
          min = Number(m[1]);
          max = m[2] === undefined ? min : Number(m[2]);
          if (max < min || max > MAX_REPEAT || max === 0) return null;
          i += m[0].length;
        }
        tokens.push({ digit: true, min, max });
        continue;
      }
      if (e !== undefined && ESCAPABLE.has(e)) { tokens.push({ digit: false, ch: e }); i += 2; continue; }
      return null;
    }
    if (!LITERAL.test(c)) return null;
    tokens.push({ digit: false, ch: c });
    i += 1;
  }
  const T = tokens.length;
  // State: token index * (MAX_REPEAT + 2) + digits taken in that token (an unbounded token saturates at its minimum).
  const W = MAX_REPEAT + 2;
  const close = (states: Set<number>) => {
    const stack = [...states];
    while (stack.length) {
      const s = stack.pop()!;
      const t = Math.floor(s / W);
      const n = s % W;
      const tok = tokens[t];
      if (t < T && tok.digit && n >= tok.min) {
        const next = (t + 1) * W;
        if (!states.has(next)) { states.add(next); stack.push(next); }
      }
    }
    return states;
  };
  const test = (ref: string) => {
    let states = close(new Set([0]));
    for (let k = 0; k < ref.length && states.size > 0; k += 1) {
      const ch = ref[k];
      const isDigit = ch >= "0" && ch <= "9";
      const next = new Set<number>();
      for (const s of states) {
        const t = Math.floor(s / W);
        if (t >= T) continue;
        const n = s % W;
        const tok = tokens[t];
        if (!tok.digit) { if (ch === tok.ch) next.add((t + 1) * W); }
        else if (isDigit && n < tok.max) next.add(t * W + Math.min(n + 1, tok.max === Infinity ? tok.min : tok.max));
      }
      states = close(next);
    }
    return states.has(T * W);
  };
  return { test, source };
}
