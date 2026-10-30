/**
 * Text for a one-line mail header (the subject). The providers (Microsoft Graph, Resend) take JSON, not raw MIME, but a CR or LF
 * in a header value is never wanted and is the classic header-injection shape ("S\r\nBcc: x@y"), so every control character
 * (CR, LF and tab included) and the Unicode line and paragraph separators become one space, and the ends are trimmed.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g;

export function headerText(value: string): string {
  return value.replace(CONTROL, " ").trim();
}
