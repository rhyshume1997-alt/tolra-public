// Offline guard for the reconciliation CLI. This tool compares two folders of files. It never talks to anything, so every
// argument that looks like a network location, a database connection or a Supabase project is refused BEFORE any file is read,
// and so is every option that could mean "write" or "connect". Fail closed: an unknown option is refused too.

export class OfflineGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfflineGuardError";
  }
}

export const PROJECT_REFS = ["qtgqliczvyyrkibvxfqv", "qngvemzbdsvtydkbplpo"];

const FORBIDDEN = [
  [/[a-z][a-z0-9+.-]*:\/\//i, "a URL (scheme://)"],
  [/\b(?:postgres(?:ql)?|jdbc|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|mssql|sqlserver)\s*:/i, "a database connection string"],
  [/supabase/i, "a Supabase address or project"],
  [new RegExp(PROJECT_REFS.join("|"), "i"), "a Supabase project reference"],
  [/(?:^|[\s;&?])(?:host|hostaddr|port|dbname|database|user|username|password|sslmode|apikey|api_key|token|key)\s*=/i, "connection parameters"],
  [/^[^\s/\\@]+:[^\s/\\@]*@[^\s/\\@]+/, "credentials in a connection string (user:password@host)"],
  [/^[^\s/\\@]+@[a-z0-9.-]+:\d{2,5}(?:\/|$)/i, "a user@host:port address"],
  [/^(?:localhost|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:\/.*)?$/i, "a local host name"],
  [/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/, "an IP address"],
  [/^[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}(?:\/.*)?$/i, "a host:port address"],
  [/^www\./i, "a web address"],
  [/^(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|dev|app|cloud|eu|uk|us|in)(?::\d+)?(?:\/.*)?$/i, "a host name"],
];

// Options that would mean a write or a connection somewhere. Named so the refusal can say why.
const WRITE_OR_CONNECT = new Set([
  "--write", "--apply", "--commit", "--push", "--fix", "--upload", "--sync", "--import", "--install-importer",
  "--database-url", "--db", "--db-url", "--url", "--host", "--port", "--connection", "--connection-string", "--dsn",
  "--organization-id", "--organisation-id", "--org", "--project", "--project-ref", "--supabase-url", "--supabase-key", "--api-key", "--token",
]);

export function describeForbidden(text) {
  const s = String(text);
  for (const [re, what] of FORBIDDEN) if (re.test(s)) return what;
  return null;
}

/**
 * Screens the whole argument list. Throws OfflineGuardError naming the first offending argument (never echoing a secret-looking
 * value in full: only its first 40 characters). Returns nothing on success.
 */
export function assertOfflineArgs(argv) {
  if (!Array.isArray(argv)) throw new OfflineGuardError("Refusing: the arguments could not be read.");
  argv.forEach((raw, i) => {
    const token = String(raw);
    const name = token.startsWith("--") ? token.split("=")[0] : null;
    if (name && WRITE_OR_CONNECT.has(name.toLowerCase())) {
      throw new OfflineGuardError(`Refusing: ${name.toLowerCase()} is not available. This tool is a read-only, offline comparison of files: it has no write path and never connects to a database or a network.`);
    }
    const parts = name ? [name, token.slice(name.length + 1)] : [token];
    for (const part of parts) {
      const what = describeForbidden(part);
      if (what) {
        // The offending value is never echoed: it may carry a password or a key.
        const prev = String(argv[i - 1] ?? "");
        const where = name ? `the value of ${/^--[a-z][a-z-]{0,30}$/.test(name) ? name : "an option"}` : /^--[a-z][a-z-]{0,30}$/.test(prev) ? `the value of ${prev}` : `argument ${i + 1}`;
        throw new OfflineGuardError(`Refusing: ${where} looks like ${what}. This tool compares local files only and never connects to a database, Supabase or any network address.`);
      }
    }
  });
}
