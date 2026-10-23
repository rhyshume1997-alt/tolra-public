/** Sign-in usernames: 3-32 characters, letters, digits, dot, dash, underscore; starts with a letter or digit. Stored lower-case. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normaliseUsername(value: string) {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string) {
  return USERNAME_PATTERN.test(value);
}

export const USERNAME_RULES = "3-32 characters: letters, numbers, dots, dashes or underscores, starting with a letter or number.";
