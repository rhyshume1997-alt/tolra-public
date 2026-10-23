/** Password rules, the same everywhere a password is chosen (sign-up / set-password page, sidebar, Admin > Users). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 72; // bcrypt's limit in Supabase Auth
export const PASSWORD_RULES = "At least 12 characters, with a letter and a number.";

/** null when the password is acceptable, otherwise the reason. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return "Password must be 72 characters or fewer.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Password must include at least one letter and one number.";
  return null;
}

// No look-alikes (0/O, 1/l/I) so it can be read out or copied from a screen.
const LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";

/** Uniform random integer in [0, max) from the browser / Node crypto (rejection sampling: no modulo bias). */
function randomInt(max: number) {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  do crypto.getRandomValues(buffer); while (buffer[0] >= limit);
  return buffer[0] % max;
}

/** A random 14-character password that meets the rules. */
export function generatePassword(length = 14): string {
  const all = LETTERS + DIGITS;
  const chars = [LETTERS[randomInt(LETTERS.length)], DIGITS[randomInt(DIGITS.length)]];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
