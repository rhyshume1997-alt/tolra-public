/**
 * What must never appear in a rendered page. An Anthropic API key is "sk-ant-" followed by a long body (real keys are about 100 characters:
 * "sk-ant-api03-" plus 90 or more URL-safe characters). The AI card's input shows the static placeholder "sk-ant-…" (a hint at the format,
 * not a key); a bare prefix, with or without dots or an ellipsis, is not a credential. Anything with 20 or more key characters after the
 * prefix is treated as a key. The other credential words are unchanged.
 */
export const SECRET_IN_PAGE = /sk-ant-[A-Za-z0-9_-]{20,}|client_secret|refresh_token|access_token/;
