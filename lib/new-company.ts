/**
 * The platform owner's "New company" form: the rules for the name, the web address (slug) and the first admin's e-mail.
 * Shared by the dialog (to help while typing) and by POST /api/platform/organizations (the real check). The slug rule is the
 * database's own (public.create_organization, migration 007: ^[a-z0-9-]{2,48}$), so nothing the form accepts is refused later
 * for its shape.
 */

export const COMPANY_SLUG_PATTERN = /^[a-z0-9-]{2,48}$/;
export const COMPANY_SLUG_RULES = "2 to 48 characters: lower-case letters, numbers and hyphens.";
export const COMPANY_NAME_MIN = 2;
export const COMPANY_NAME_MAX = 120;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX = 254;

/** A suggested slug for a company name: lower-case, accents dropped, anything else becomes a single hyphen, 48 characters at most. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug;
}

export type NewCompanyInput = { name: string; slug: string; adminEmail: string };
export type NewCompanyField = keyof NewCompanyInput;
export type NewCompanyCheck = { ok: true; value: NewCompanyInput } | { ok: false; field: NewCompanyField; error: string };

/**
 * Trims and checks the three fields; returns the first problem, worded for the person filling in the form. confirmEmail is required
 * (the dialog always sends it: the first admin's e-mail typed a second time): missing, not a string, or a different address after
 * trimming and lower-casing is refused.
 */
export function checkNewCompany(raw: { name?: unknown; slug?: unknown; adminEmail?: unknown; confirmEmail?: unknown }): NewCompanyCheck {
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < COMPANY_NAME_MIN) return { ok: false, field: "name", error: "Enter the company's name." };
  if (name.length > COMPANY_NAME_MAX) return { ok: false, field: "name", error: `The name can be at most ${COMPANY_NAME_MAX} characters.` };
  // Control characters, and invisible format characters (zero-width, bidi overrides) that could make one name look like another.
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return { ok: false, field: "name", error: "The name can't contain control or hidden characters." };

  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  if (!COMPANY_SLUG_PATTERN.test(slug)) return { ok: false, field: "slug", error: `The web address (slug) must be ${COMPANY_SLUG_RULES}` };

  const adminEmail = typeof raw.adminEmail === "string" ? raw.adminEmail.trim().toLowerCase() : "";
  if (!adminEmail || adminEmail.length > EMAIL_MAX || !EMAIL_PATTERN.test(adminEmail)) {
    return { ok: false, field: "adminEmail", error: "Enter a valid e-mail address for the first admin." };
  }
  if (typeof raw.confirmEmail !== "string" || raw.confirmEmail.trim().toLowerCase() !== adminEmail) {
    return { ok: false, field: "adminEmail", error: "The two e-mail addresses don't match. Type the first admin's e-mail again exactly." };
  }
  return { ok: true, value: { name, slug, adminEmail } };
}

/** Names compare without regard to case or repeated spaces, so "Acme  Ltd" and "acme ltd" count as the same company. */
export function sameCompanyName(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}
