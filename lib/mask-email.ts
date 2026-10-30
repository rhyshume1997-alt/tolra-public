/** "jane.smith@example.com" -> "j***@example.com": enough for an admin to recognise where a message went, not a full address to copy. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
