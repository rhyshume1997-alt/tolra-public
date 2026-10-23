// Read-only file helpers for the SliQ archive tools. Nothing here writes, renames, deletes or follows a symbolic link, and
// nothing here uses the network (only node:fs, node:path and node:crypto are imported anywhere in this folder).
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

/** Why a manifest or archive path is not acceptable, or null if it is a safe, relative, forward-slash path. */
export function unsafePathReason(p) {
  if (typeof p !== "string" || p === "") return "path is empty or not text";
  if (p.length > 1024) return "path is longer than 1024 characters";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "path contains a control character";
  if (p.includes("\\")) return "path contains a backslash";
  if (p.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(p)) return "absolute path (drive letter)";
  for (const seg of p.split("/")) {
    if (seg === "") return "path has an empty segment (leading, trailing or doubled slash)";
    if (seg === ".") return 'path contains a "." segment';
    if (seg === "..") return 'path traversal (a ".." segment)';
  }
  return null;
}

/** The key two paths share when they differ only by case or Unicode form (Windows and macOS would treat them as one file). */
export const foldKey = (p) => p.normalize("NFC").toLowerCase();

/** Text safe to print: control characters are shown as \xNN. */
// eslint-disable-next-line no-control-regex
export const show = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** Code-point order, so sorting never depends on the machine's locale. */
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Lists the regular files under `root` (forward-slash paths relative to it, sorted by code point), without following links.
 * Symbolic links and other special files are returned in `problems`, never read, and never descended into.
 */
export function walkArchive(root) {
  const st = lstatSync(root);
  if (!st.isDirectory() && !(st.isSymbolicLink() && lstatSync(realpathSync(root)).isDirectory())) {
    throw new Error(`Not a directory: ${root}`);
  }
  const files = [];
  const problems = [];
  const visit = (abs, rel) => {
    const names = readdirSync(abs).sort(byCodePoint);
    for (const name of names) {
      const childAbs = path.join(abs, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const s = lstatSync(childAbs);
      if (s.isSymbolicLink()) problems.push({ path: childRel, problem: "symbolic link (not followed, not allowed in an archive)" });
      else if (s.isDirectory()) visit(childAbs, childRel);
      else if (s.isFile()) files.push({ path: childRel, size: s.size });
      else problems.push({ path: childRel, problem: "not a regular file (device, socket or similar)" });
    }
  };
  visit(root, "");
  return { files, problems };
}

/** SHA-256 and byte count of one file, opened read only (and refusing a link at the last step). */
export function hashFile(abs) {
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      size += n;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * `p` made absolute with every existing part resolved through symbolic links. A part that does not exist yet (a folder --out
 * will create) is kept as written, under its resolved nearest existing ancestor. A link that points nowhere is an error, not
 * a missing part, because a write would land wherever the link points.
 */
export function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    let exists = true;
    try {
      lstatSync(cur);
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
      exists = false;
    }
    if (exists) {
      try {
        return path.join(realpathSync(cur), ...tail);
      } catch (e) {
        if (e?.code === "ENOENT" || e?.code === "ELOOP") throw new Error(`${cur} is a symbolic link that cannot be resolved (${e.code}).`);
        throw e;
      }
    }
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...tail);
    tail.unshift(path.basename(cur));
    cur = up;
  }
}

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** True if `child` is `parent` or inside it (both resolved through symbolic links). */
export function isInside(parent, child) {
  return within(realish(child), realish(parent));
}

/**
 * True if the two folders are the same, or one is inside the other, after resolving links on both sides. An --out that is the
 * archive, is inside it, or contains it (so a later run would read the reports as archive files) all overlap.
 */
export function overlaps(a, b) {
  const ra = realish(a);
  const rb = realish(b);
  return within(ra, rb) || within(rb, ra);
}
