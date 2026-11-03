/**
 * SliQ archive manifest and verify (scripts/sliq-archive). The archive is built from synthetic text in a temp folder at test
 * time: no fixture files are committed and no real SliQ data is used.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/sliq-archive/cli.mjs";
import { buildManifest, classify, manifestCsv, parseMap } from "../../scripts/sliq-archive/manifest.mjs";
import { renderText, verifyArchive } from "../../scripts/sliq-archive/verify.mjs";

const CLI = path.resolve(__dirname, "../../scripts/sliq-archive/cli.mjs");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A small synthetic archive: CSV exports, document PDFs, a drawing, attachments and the metadata CSV that links them. */
function makeArchive() {
  const root = mkdtempSync(path.join(tmpdir(), "sliq-archive-"));
  roots.push(root);
  const archive = path.join(root, "archive");
  const out = path.join(root, "out");
  const put = (rel: string, content: string | Buffer) => {
    const abs = path.join(archive, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    utimesSync(abs, new Date("2001-02-03T04:05:06Z"), new Date("2001-02-03T04:05:06Z"));
  };
  put("customers.csv", "Company Name,Email\nAcme Test Ltd,a@example.invalid\n");
  put("invoices.csv", "Number,Customer,Gross\nINV-1001,Acme Test Ltd,120.00\nINV-1002,Acme Test Ltd,60.00\n");
  put("pdfs/INV-1001.pdf", "%PDF-1.4 synthetic invoice 1001\n");
  put("pdfs/INV-1002.pdf", "%PDF-1.4 synthetic invoice 1002\n");
  put("drawings/DWG-0001.dxf", "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");
  put("attachments/po-1001.pdf", "%PDF-1.4 synthetic customer PO\n");
  put("attachments/photo-1002.bin", Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) % 256)));
  put("metadata/documents.csv", "Document,Attachment\nINV-1001,po-1001.pdf\nINV-1002,photo-1002.bin\nINV-1003,\n");
  const manifestPath = path.join(out, "manifest.json");
  const manifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
  const build = (extra: string[] = []) => {
    const lines: string[] = [];
    const code = main(["manifest", archive, "--out", out, "--exported-at", "2026-10-14T09:30:00Z", ...extra], (l) => lines.push(l));
    expect(code).toBe(0);
    return lines;
  };
  const writeManifest = (m: unknown, withSidecar = false) => {
    mkdirSync(out, { recursive: true });
    const text = `${JSON.stringify(m, null, 2)}\n`;
    writeFileSync(manifestPath, text);
    rmSync(`${manifestPath}.sha256`, { force: true });
    if (withSidecar) writeFileSync(`${manifestPath}.sha256`, `${sha(text)}  manifest.json\n`);
  };
  const verify = (extra: Partial<Parameters<typeof verifyArchive>[0]> = {}) =>
    verifyArchive({ archiveDir: archive, manifestPath, ...extra });
  return { root, archive, out, put, manifestPath, manifest, build, writeManifest, verify };
}

const meta = (a: ReturnType<typeof makeArchive>) => ({ metadataPath: path.join(a.archive, "metadata", "documents.csv") });
const messages = (report: ReturnType<typeof verifyArchive>) =>
  [
    ...report.problems.map((p: { message: string }) => p.message),
    ...report.entries.flatMap((e: { path: string; problems: { message: string }[] }) => e.problems.map((p) => `${e.path}: ${p.message}`)),
    ...report.extraFiles.map((x: { path: string; message: string }) => `${x.path}: ${x.message}`),
    ...report.relationships.filter((r: { ok: boolean }) => !r.ok).map((r: { document: string; file: string; message: string }) => `${r.document} -> ${r.file}: ${r.message}`),
  ];

describe("manifest", () => {
  it("lists every file with paths, size, SHA-256, export time, record type and status", () => {
    const a = makeArchive();
    a.build(["--csv"]);
    const m = a.manifest();
    expect(m.format).toBe("sliq-archive-manifest/1");
    expect(m.exportedAt).toBe("2026-10-14T09:30:00Z");
    expect(m.entries.map((e: { path: string }) => e.path)).toEqual([
      "attachments/photo-1002.bin",
      "attachments/po-1001.pdf",
      "customers.csv",
      "drawings/DWG-0001.dxf",
      "invoices.csv",
      "metadata/documents.csv",
      "pdfs/INV-1001.pdf",
      "pdfs/INV-1002.pdf",
    ]);
    const inv = m.entries.find((e: { path: string }) => e.path === "pdfs/INV-1001.pdf");
    const bytes = readFileSync(path.join(a.archive, "pdfs", "INV-1001.pdf"));
    expect(inv).toEqual({
      path: "pdfs/INV-1001.pdf",
      sourcePath: "pdfs/INV-1001.pdf",
      size: bytes.length,
      sha256: sha(bytes),
      exportedAt: "2026-10-14T09:30:00Z",
      recordType: "documents-pdf",
      status: "unverified",
    });
    expect(m.recordTypes).toEqual({ attachments: 2, customers: 1, drawings: 1, "documents-pdf": 2, invoices: 1, metadata: 1 });
    expect(readFileSync(`${a.manifestPath}.sha256`, "utf8")).toBe(`${sha(readFileSync(a.manifestPath))}  manifest.json\n`);
    const csv = readFileSync(path.join(a.out, "manifest.csv"), "utf8").split("\n");
    expect(csv[0]).toBe("path,source_path,size,sha256,exported_at,record_type,status");
    expect(csv).toHaveLength(m.entries.length + 2);
  });

  it("manifest.csv cells can't run as spreadsheet formulas (audit S3), and plain values are unchanged", () => {
    const entry = { path: "=HYPERLINK(\"http://x.example\",\"a\").pdf", sourcePath: "+cmd.pdf", size: 12, sha256: "ab", exportedAt: "2026-10-14", recordType: "attachments", status: "ok" };
    const csv = manifestCsv({ entries: [entry, { ...entry, path: "docs/a, b.pdf", sourcePath: "@x.pdf" }] } as never).split("\n");
    expect(csv[1]).toBe('"\'=HYPERLINK(""http://x.example"",""a"").pdf",\'+cmd.pdf,12,ab,2026-10-14,attachments,ok');
    expect(csv[2]).toBe('"docs/a, b.pdf",\'@x.pdf,12,ab,2026-10-14,attachments,ok');
  });

  it("is deterministic and ignores file modification times", () => {
    const a = makeArchive();
    const first = buildManifest({ archiveDir: a.archive, exportedAt: "2026-10-14" });
    utimesSync(path.join(a.archive, "customers.csv"), new Date("2020-01-01"), new Date("2030-01-01"));
    const second = buildManifest({ archiveDir: a.archive, exportedAt: "2026-10-14" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(manifestCsv(second)).toBe(manifestCsv(first));
    expect(JSON.stringify(first)).not.toMatch(/2001|2020|2030/);
  });

  it("classifies by sidecar map, then folder, then file name, then extension", () => {
    const map = parseMap({
      format: "sliq-archive-map/1",
      types: [
        { prefix: "extra/", recordType: "credit-notes", exportedAt: "2026-10-01" },
        { path: "extra/special.pdf", recordType: "templates" },
      ],
      sources: { "extra/a.csv": "Exports/2026/a.csv" },
    });
    expect(classify("extra/a.csv", map)).toEqual({ recordType: "credit-notes", exportedAt: "2026-10-01" });
    expect(classify("extra/special.pdf", map).recordType).toBe("templates");
    expect(classify("Customers/x.csv").recordType).toBe("customers");
    expect(classify("payments.csv").recordType).toBe("payments");
    expect(classify("loose/thing.pdf").recordType).toBe("documents-pdf");
    expect(classify("loose/part.STEP").recordType).toBe("drawings");
    expect(classify("loose/what.dat").recordType).toBe("unclassified");
  });

  it("applies the map's source paths and per-prefix export times", () => {
    const a = makeArchive();
    a.put("extra/a.csv", "x\n");
    const m = buildManifest({
      archiveDir: a.archive,
      exportedAt: "2026-10-14",
      map: { format: "sliq-archive-map/1", types: [{ prefix: "extra/", recordType: "credit-notes", exportedAt: "2026-10-01" }], sources: { "extra/a.csv": "Exports/2026/a.csv" } },
    });
    const e = m.entries.find((x: { path: string }) => x.path === "extra/a.csv");
    expect(e).toMatchObject({ sourcePath: "Exports/2026/a.csv", exportedAt: "2026-10-01", recordType: "credit-notes" });
  });

  it("refuses a bad --exported-at, an empty archive, links, and names that differ only by case", () => {
    const a = makeArchive();
    expect(() => buildManifest({ archiveDir: a.archive, exportedAt: "yesterday" })).toThrow(/ISO 8601/);
    expect(() => buildManifest({ archiveDir: a.archive, exportedAt: "2026-13-45" })).toThrow(/ISO 8601/);
    symlinkSync(path.join(a.archive, "customers.csv"), path.join(a.archive, "link.csv"));
    expect(() => buildManifest({ archiveDir: a.archive, exportedAt: "2026-10-14" })).toThrow(/link\.csv: symbolic link/);
    const empty = mkdtempSync(path.join(tmpdir(), "sliq-archive-empty-"));
    roots.push(empty);
    expect(() => buildManifest({ archiveDir: empty, exportedAt: "2026-10-14" })).toThrow(/no files/);
    const b = makeArchive();
    b.put("pdfs/inv-1001.PDF", "case twin");
    // On a case-insensitive file system the second name overwrites the first, so there is nothing to refuse.
    if (readdirSync(path.join(b.archive, "pdfs")).length === 3) {
      expect(() => buildManifest({ archiveDir: b.archive, exportedAt: "2026-10-14" })).toThrow(/pdfs\/inv-1001\.PDF: differs only by case or Unicode form from pdfs\/INV-1001\.pdf/);
    }
  });

  it("will not write inside the archive or over an existing manifest", () => {
    const a = makeArchive();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => errors.push(String(m));
    try {
      expect(main(["manifest", a.archive, "--out", path.join(a.archive, "sub"), "--exported-at", "2026-10-14"])).toBe(2);
      expect(errors.join("\n")).toMatch(/inside the archive/);
      expect(readdirSync(a.archive)).not.toContain("sub");
      a.build();
      expect(main(["manifest", a.archive, "--out", a.out, "--exported-at", "2026-10-14"])).toBe(2);
      expect(errors.join("\n")).toMatch(/Refusing to overwrite/);
      expect(main(["manifest", a.archive, "--out", a.out, "--exported-at", "2026-10-14", "--overwrite"], () => {})).toBe(0);
    } finally {
      console.error = orig;
    }
  });
});

/** Everything under `dir` (files and folders, links not followed) with bytes, size and mtime, so any change shows up. */
function treeState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const s = lstatSync(abs);
      const rel = path.relative(dir, abs);
      if (s.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
      else if (s.isDirectory()) {
        out[`${rel}/`] = `dir:${s.mtimeMs}`;
        walk(abs);
      } else out[rel] = `${sha(readFileSync(abs))}:${s.size}:${s.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

describe("output safety: --out and output links (both commands)", () => {
  const quiet = (argv: string[]) => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => errors.push(String(m));
    try {
      return { code: main(argv, () => {}), errors: errors.join("\n") };
    } finally {
      console.error = orig;
    }
  };
  const manifestArgs = (a: ReturnType<typeof makeArchive>, out: string, ...extra: string[]) => ["manifest", a.archive, "--out", out, "--exported-at", "2026-10-14", ...extra];
  const verifyArgs = (a: ReturnType<typeof makeArchive>, out: string) => ["verify", a.archive, "--manifest", a.manifestPath, "--out", out];

  /** Every --out that is the archive, inside it, contains it, or reaches it through a link. */
  const badOuts = (a: ReturnType<typeof makeArchive>) => {
    const alias = path.join(a.root, "alias-to-sub");
    mkdirSync(path.join(a.archive, "pdfs"), { recursive: true });
    symlinkSync(path.join(a.archive, "pdfs"), alias);
    const aliasToArchive = path.join(a.root, "alias-to-archive");
    symlinkSync(a.archive, aliasToArchive);
    const aliasToRoot = path.join(a.root, "alias-to-root");
    symlinkSync(a.root, aliasToRoot);
    return {
      "the archive itself": a.archive,
      "the archive with a trailing dot segment": `${a.archive}${path.sep}.`,
      "an existing folder inside it": path.join(a.archive, "pdfs"),
      "a new folder inside it": path.join(a.archive, "new", "deeper"),
      "a folder that contains it": a.root,
      "its parent written with ..": path.join(a.archive, "..", "archive", ".."),
      "a symlink beside it that points at the archive": aliasToArchive,
      "a symlink outside it that points into it": alias,
      "a new folder under a symlink that points into it": path.join(alias, "reports"),
      "a symlink that points at a folder containing it": aliasToRoot,
    };
  };

  it("manifest refuses every --out in, at, around or aliased to the archive, and changes nothing", () => {
    const a = makeArchive();
    const outs = badOuts(a);
    const before = treeState(a.root);
    for (const [label, out] of Object.entries(outs)) {
      for (const extra of [[], ["--overwrite"], ["--csv", "--overwrite"]]) {
        const r = quiet(manifestArgs(a, out, ...extra));
        expect(r.code, `${label} ${extra.join(" ")}`).toBe(2);
        expect(r.errors, label).toMatch(/inside the archive/);
      }
    }
    expect(treeState(a.root)).toEqual(before);
  });

  it("verify refuses every --out in, at, around or aliased to the archive, and changes nothing", () => {
    const a = makeArchive();
    a.build();
    const outs = badOuts(a);
    const before = treeState(a.root);
    for (const [label, out] of Object.entries(outs)) {
      const r = quiet(verifyArgs(a, out));
      expect(r.code, label).toBe(2);
      expect(r.errors, label).toMatch(/inside the archive/);
    }
    expect(treeState(a.root)).toEqual(before);
  });

  it("refuses --out through a link that points nowhere, and --out that is a file", () => {
    const a = makeArchive();
    symlinkSync(path.join(a.root, "does-not-exist"), path.join(a.root, "dangling"));
    writeFileSync(path.join(a.root, "afile"), "x");
    for (const out of [path.join(a.root, "dangling"), path.join(a.root, "afile")]) {
      expect(quiet(manifestArgs(a, out)).code).toBe(2);
    }
    a.build();
    for (const out of [path.join(a.root, "dangling"), path.join(a.root, "afile")]) {
      expect(quiet(verifyArgs(a, out)).code).toBe(2);
    }
    expect(readFileSync(path.join(a.root, "afile"), "utf8")).toBe("x");
  });

  it("allows an --out beside the archive, new or existing, or reached through a link to such a folder", () => {
    const a = makeArchive();
    const real = path.join(a.root, "real-out");
    mkdirSync(real);
    const alias = path.join(a.root, "alias-out");
    symlinkSync(real, alias);
    expect(quiet(manifestArgs(a, path.join(a.root, "new", "deeper"), "--csv")).code).toBe(0);
    expect(quiet(manifestArgs(a, alias, "--csv")).code).toBe(0);
    expect(readdirSync(real).sort()).toEqual(["manifest.csv", "manifest.json", "manifest.json.sha256"]);
    expect(quiet(verifyArgs({ ...a, manifestPath: path.join(real, "manifest.json") }, alias)).code).toBe(0);
    expect(readdirSync(real).sort()).toEqual(["manifest.csv", "manifest.json", "manifest.json.sha256", "verify-report.json", "verify-report.txt"]);
  });

  it("neither command modifies any archived file in any refused or allowed mode (bytes, sizes, mtimes)", () => {
    const a = makeArchive();
    const archiveBefore = treeState(a.archive);
    const same = () => expect(treeState(a.archive)).toEqual(archiveBefore);
    const outs = badOuts(a);
    const modes: [string, () => number][] = [];
    // refused
    for (const [label, out] of Object.entries(outs)) modes.push([`manifest refused: ${label}`, () => quiet(manifestArgs(a, out, "--csv", "--overwrite")).code]);
    // allowed: new, again without --overwrite (refused), with --overwrite, with --csv
    const o1 = path.join(a.root, "o1");
    modes.push(["manifest new", () => quiet(manifestArgs(a, o1)).code]);
    modes.push(["manifest again, no --overwrite", () => quiet(manifestArgs(a, o1)).code]);
    modes.push(["manifest --overwrite --csv", () => quiet(manifestArgs(a, o1, "--overwrite", "--csv")).code]);
    // output links to archive files
    const o2 = path.join(a.root, "o2");
    mkdirSync(o2);
    symlinkSync(path.join(a.archive, "customers.csv"), path.join(o2, "manifest.json"));
    modes.push(["manifest with manifest.json linked to an archive file", () => quiet(manifestArgs(a, o2, "--overwrite")).code]);
    const codes = modes.map(([, run]) => run());
    expect(codes.slice(0, Object.keys(outs).length).every((c) => c === 2)).toBe(true);
    expect(codes.slice(Object.keys(outs).length)).toEqual([0, 2, 0, 2]);
    same();

    // verify: needs a manifest outside the archive
    const manifestPath = path.join(o1, "manifest.json");
    const v = (out?: string) => quiet(["verify", a.archive, "--manifest", manifestPath, ...(out ? ["--out", out] : [])]).code;
    for (const out of Object.values(outs)) expect(v(out)).toBe(2);
    expect(v()).toBe(0);
    expect(v(path.join(a.root, "v1"))).toBe(0);
    expect(v(path.join(a.root, "v1"))).toBe(0); // replaces its own earlier report
    const v2 = path.join(a.root, "v2");
    mkdirSync(v2);
    symlinkSync(path.join(a.archive, "invoices.csv"), path.join(v2, "verify-report.txt"));
    expect(v(v2)).toBe(2);
    // a damaged archive still only reads: change nothing ourselves, then compare against the damaged state
    rmSync(path.join(a.archive, "pdfs", "INV-1002.pdf"));
    const damaged = treeState(a.archive);
    expect(v()).toBe(1);
    expect(v(path.join(a.root, "v3"))).toBe(1);
    expect(treeState(a.archive)).toEqual(damaged);
  });

  it("manifest: an output that is a symlink to an archive file is refused, with or without --overwrite, and the file is unchanged", () => {
    for (const name of ["manifest.json", "manifest.json.sha256", "manifest.csv"]) {
      for (const extra of [["--csv"], ["--csv", "--overwrite"]]) {
        const a = makeArchive();
        const target = path.join(a.archive, "customers.csv");
        const bytes = readFileSync(target);
        const mtime = statSync(target).mtimeMs;
        mkdirSync(a.out);
        symlinkSync(target, path.join(a.out, name));
        const r = quiet(manifestArgs(a, a.out, ...extra));
        expect(r.code, `${name} ${extra.join(" ")}`).toBe(2);
        expect(r.errors).toMatch(new RegExp(`${name.replace(/\./g, "\\.")} in --out is a symbolic link`));
        expect(readFileSync(target).equals(bytes)).toBe(true);
        expect(statSync(target).mtimeMs).toBe(mtime);
        expect(lstatSync(path.join(a.out, name)).isSymbolicLink()).toBe(true);
        // all or nothing: no other output was written and no temp file is left behind
        expect(readdirSync(a.out)).toEqual([name]);
      }
    }
  });

  it("manifest: a dangling output symlink and a link to a file outside the archive are refused too", () => {
    const a = makeArchive();
    mkdirSync(a.out);
    const elsewhere = path.join(a.root, "elsewhere.txt");
    writeFileSync(elsewhere, "keep");
    symlinkSync(elsewhere, path.join(a.out, "manifest.json"));
    symlinkSync(path.join(a.root, "nowhere"), path.join(a.out, "manifest.json.sha256"));
    expect(quiet(manifestArgs(a, a.out, "--overwrite")).code).toBe(2);
    rmSync(path.join(a.out, "manifest.json"));
    expect(quiet(manifestArgs(a, a.out, "--overwrite")).code).toBe(2);
    expect(readFileSync(elsewhere, "utf8")).toBe("keep");
    expect(existsSync(path.join(a.root, "nowhere"))).toBe(false);
  });

  it("verify: a report file that is a symlink to an archive file is refused and the file is unchanged", () => {
    for (const name of ["verify-report.txt", "verify-report.json"]) {
      const a = makeArchive();
      a.build();
      const reports = path.join(a.root, "reports");
      mkdirSync(reports);
      const target = path.join(a.archive, "invoices.csv");
      const bytes = readFileSync(target);
      const mtime = statSync(target).mtimeMs;
      symlinkSync(target, path.join(reports, name));
      const r = quiet(verifyArgs(a, reports));
      expect(r.code, name).toBe(2);
      expect(r.errors).toMatch(/is a symbolic link/);
      expect(readFileSync(target).equals(bytes)).toBe(true);
      expect(statSync(target).mtimeMs).toBe(mtime);
      expect(readdirSync(reports)).toEqual([name]);
    }
  });

  it("replaces its own earlier regular output files atomically with --overwrite, leaving no temp files", () => {
    const a = makeArchive();
    a.build();
    const inode = statSync(a.manifestPath).ino;
    a.build(["--overwrite"]);
    expect(readdirSync(a.out).sort()).toEqual(["manifest.json", "manifest.json.sha256"]);
    expect(statSync(a.manifestPath).ino).not.toBe(inode); // a new file renamed into place, not the old one rewritten
    expect(readFileSync(`${a.manifestPath}.sha256`, "utf8")).toBe(`${sha(readFileSync(a.manifestPath))}  manifest.json\n`);
  });

  it("a folder where an output file should go is refused", () => {
    const a = makeArchive();
    mkdirSync(path.join(a.out, "manifest.json"), { recursive: true });
    const r = quiet(manifestArgs(a, a.out, "--overwrite"));
    expect(r.code).toBe(2);
    expect(r.errors).toMatch(/not a regular file/);
  });
});

describe("verify: a good archive", () => {
  it("passes, entry by entry, with and without the metadata CSV", () => {
    const a = makeArchive();
    a.build();
    const plain = a.verify();
    expect(plain.result).toBe("PASS");
    expect(plain.entries).toHaveLength(8);
    expect(plain.entries.every((e: { status: string }) => e.status === "PASS")).toBe(true);
    expect(plain.manifest.selfCheck).toMatch(/^ok/);
    const linked = a.verify({ ...meta(a), attachmentsDir: "attachments" });
    expect(linked.result).toBe("PASS");
    expect(linked.relationships.map((r: { document: string; file: string; ok: boolean }) => `${r.document}>${r.file}:${r.ok}`)).toEqual([
      "INV-1001>attachments/po-1001.pdf:true",
      "INV-1002>attachments/photo-1002.bin:true",
    ]);
    expect(linked.warnings).toEqual([]);
    expect(renderText(linked)).toMatch(/PASS {2}pdfs\/INV-1001\.pdf[\s\S]*RESULT: PASS\n$/);
  });

  it("gives identical output on every run", () => {
    const a = makeArchive();
    a.build();
    const one = renderText(a.verify({ ...meta(a), attachmentsDir: "attachments" }));
    const two = renderText(a.verify({ ...meta(a), attachmentsDir: "attachments" }));
    expect(two).toBe(one);
    expect(one).not.toContain(a.root);
  });

  it("exits 0 and writes its report only under --out", () => {
    const a = makeArchive();
    a.build();
    const reports = path.join(a.root, "reports");
    const lines: string[] = [];
    expect(main(["verify", a.archive, "--manifest", a.manifestPath, "--out", reports], (l) => lines.push(l))).toBe(0);
    expect(readdirSync(reports).sort()).toEqual(["verify-report.json", "verify-report.txt"]);
    expect(JSON.parse(readFileSync(path.join(reports, "verify-report.json"), "utf8")).result).toBe("PASS");
    expect(readFileSync(path.join(reports, "verify-report.txt"), "utf8").trimEnd()).toBe(lines.join("\n"));
  });
});

describe("verify: failures name the problem precisely", () => {
  it("a removed file is reported as missing", () => {
    const a = makeArchive();
    a.build();
    rmSync(path.join(a.archive, "drawings", "DWG-0001.dxf"));
    const r = a.verify();
    expect(r.result).toBe("FAIL");
    expect(messages(r)).toEqual(["drawings/DWG-0001.dxf: file is in the manifest but missing from the archive"]);
    expect(renderText(r)).toContain("FAIL  drawings/DWG-0001.dxf\n      - file is in the manifest but missing from the archive");
    expect(renderText(r)).toContain("RESULT: FAIL (1 missing)");
  });

  it("one altered byte is a SHA-256 mismatch (size unchanged)", () => {
    const a = makeArchive();
    a.build();
    const file = path.join(a.archive, "pdfs", "INV-1001.pdf");
    const bytes = readFileSync(file);
    const was = a.manifest().entries.find((e: { path: string }) => e.path === "pdfs/INV-1001.pdf").sha256;
    bytes[10] ^= 0x01;
    writeFileSync(file, bytes);
    const r = a.verify();
    const msgs = messages(r);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe(`pdfs/INV-1001.pdf: SHA-256 mismatch (corrupted or altered): manifest says ${was}, archive has ${sha(bytes)}`);
    expect(r.summary.problemCounts).toEqual({ "hash-mismatch": 1 });
  });

  it("a truncated or extended file is a size mismatch", () => {
    const a = makeArchive();
    a.build();
    const f = path.join(a.archive, "invoices.csv");
    const size = statSync(f).size;
    truncateSync(f, size - 5);
    appendFileSync(path.join(a.archive, "customers.csv"), "x");
    const msgs = messages(a.verify());
    expect(msgs).toContain(`invoices.csv: size mismatch: manifest says ${size} bytes, archive has ${size - 5}`);
    expect(msgs.some((m) => m.startsWith("customers.csv: size mismatch"))).toBe(true);
  });

  it("an unexpected file is reported as extra", () => {
    const a = makeArchive();
    a.build();
    a.put("attachments/unexpected.txt", "not in the manifest");
    const r = a.verify();
    expect(r.result).toBe("FAIL");
    expect(messages(r)).toEqual(["attachments/unexpected.txt: extra file: in the archive but not in the manifest"]);
    expect(r.entries.every((e: { status: string }) => e.status === "PASS")).toBe(true);
  });

  it("a duplicate path in the manifest fails every copy", () => {
    const a = makeArchive();
    a.build();
    const m = a.manifest();
    m.entries.push({ ...m.entries[0] });
    a.writeManifest(m);
    const r = a.verify();
    expect(r.result).toBe("FAIL");
    expect(messages(r)).toEqual([
      "attachments/photo-1002.bin: duplicate path: listed 2 times in the manifest",
      "attachments/photo-1002.bin: duplicate path: listed 2 times in the manifest",
    ]);
  });

  it("paths that differ only by case are duplicates, and both are named", () => {
    const a = makeArchive();
    a.build();
    const m = a.manifest();
    const twin = { ...m.entries.find((e: { path: string }) => e.path === "pdfs/INV-1001.pdf"), path: "PDFS/inv-1001.PDF" };
    m.entries.push(twin);
    a.writeManifest(m);
    const msgs = messages(a.verify());
    expect(msgs).toContain("PDFS/inv-1001.PDF: case-insensitive duplicate: differs only by case or Unicode form from pdfs/INV-1001.pdf");
    expect(msgs).toContain("pdfs/INV-1001.pdf: case-insensitive duplicate: differs only by case or Unicode form from PDFS/inv-1001.PDF");
  });

  it.each([
    ["../outside.txt", 'path traversal (a ".." segment)'],
    ["pdfs/../../outside.txt", 'path traversal (a ".." segment)'],
    ["/etc/passwd", "absolute path"],
    ["C:/Windows/win.ini", "absolute path (drive letter)"],
    ["..\\outside.txt", "path contains a backslash"],
    ["pdfs//INV-1001.pdf", "path has an empty segment (leading, trailing or doubled slash)"],
    ["./customers.csv", 'path contains a "." segment'],
    ["", "path is empty or not text"],
  ])("a manifest path %j is rejected and never opened", (bad, reason) => {
    const a = makeArchive();
    a.build();
    // A real file outside the archive, with a correct hash: it must still not be read or accepted.
    const outside = path.join(a.root, "outside.txt");
    writeFileSync(outside, "outside the archive");
    const m = a.manifest();
    m.entries.push({ path: bad, sourcePath: "x", size: 19, sha256: sha("outside the archive"), exportedAt: "2026-10-14", recordType: "other", status: "unverified" });
    a.writeManifest(m);
    const r = a.verify();
    expect(r.result).toBe("FAIL");
    const entry = r.entries.find((e: { problems: { code: string }[] }) => e.problems.some((p) => p.code === "unsafe-path"));
    expect(entry.problems[0].message).toBe(`unsafe path in the manifest: ${reason}; it was not opened`);
    expect(r.summary.problemCounts).toEqual({ "unsafe-path": 1 });
  });

  it("an unsafe source path is rejected too", () => {
    const a = makeArchive();
    a.build();
    const m = a.manifest();
    m.entries[0].sourcePath = "../../secret";
    a.writeManifest(m);
    expect(messages(a.verify())[0]).toMatch(/unsafe source path.*traversal/);
  });

  it("a symbolic link in the archive is never followed", () => {
    const a = makeArchive();
    a.build();
    const secret = path.join(a.root, "secret.txt");
    writeFileSync(secret, "secret");
    symlinkSync(secret, path.join(a.archive, "attachments", "linked.txt"));
    rmSync(path.join(a.archive, "customers.csv"));
    symlinkSync(secret, path.join(a.archive, "customers.csv"));
    const msgs = messages(a.verify());
    expect(msgs).toContain("attachments/linked.txt: symbolic link (not followed, not allowed in an archive)");
    expect(msgs).toContain("customers.csv: symbolic link (not followed, not allowed in an archive); not read");
  });

  it("a malformed manifest, an empty manifest and a missing manifest fail", () => {
    const a = makeArchive();
    mkdirSync(a.out, { recursive: true });
    expect(messages(a.verify())[0]).toMatch(/Cannot read the manifest/);
    writeFileSync(a.manifestPath, "{ not json");
    expect(messages(a.verify())[0]).toMatch(/not valid JSON/);
    a.writeManifest({ format: "sliq-archive-manifest/1", entries: [] });
    expect(messages(a.verify())).toContain("The manifest lists no files.");
    a.writeManifest({ format: "wrong", entries: [{}] });
    expect(messages(a.verify())[0]).toMatch(/must have "format"/);
  });

  it("a bad entry (size or hash not valid) fails without being read", () => {
    const a = makeArchive();
    a.build();
    const m = a.manifest();
    m.entries[0].size = -1;
    m.entries[1].sha256 = "ABC";
    a.writeManifest(m);
    const msgs = messages(a.verify());
    expect(msgs).toContain("attachments/photo-1002.bin: size must be a whole number of bytes");
    expect(msgs).toContain("attachments/po-1001.pdf: sha256 must be 64 lower-case hex digits");
  });

  it("detects a changed manifest through its .sha256 file or --manifest-sha256", () => {
    const a = makeArchive();
    a.build();
    expect(a.verify().manifest.selfCheck).toMatch(/^ok/);
    const pinned = sha(readFileSync(a.manifestPath));
    expect(a.verify({ expectedManifestSha256: pinned }).result).toBe("PASS");
    const m = a.manifest();
    m.entries[0].recordType = "tampered";
    writeFileSync(a.manifestPath, `${JSON.stringify(m, null, 2)}\n`);
    const r = a.verify();
    expect(r.result).toBe("FAIL");
    expect(messages(r)[0]).toMatch(/The manifest itself has changed: its SHA-256 is [0-9a-f]{64}, manifest\.json\.sha256 says [0-9a-f]{64}\./);
    expect(messages(a.verify({ expectedManifestSha256: pinned }))[0]).toMatch(/--manifest-sha256 says/);
  });
});

describe("verify: document to file relationships", () => {
  it("fails a document whose attachment is not in the manifest or the archive", () => {
    const a = makeArchive();
    a.build();
    a.put("metadata/documents.csv", "Document,Attachment\nINV-1001,po-1001.pdf\nINV-1002,photo-1002.bin;ghost.pdf\n");
    const m = a.manifest(); // the metadata file itself changed, so refresh its entry
    const e = m.entries.find((x: { path: string }) => x.path === "metadata/documents.csv");
    const bytes = readFileSync(path.join(a.archive, "metadata", "documents.csv"));
    Object.assign(e, { size: bytes.length, sha256: sha(bytes) });
    a.writeManifest(m);
    const r = a.verify({ ...meta(a), attachmentsDir: "attachments" });
    expect(r.result).toBe("FAIL");
    expect(messages(r)).toEqual(["INV-1002 -> attachments/ghost.pdf: not in the manifest (and not in the archive listing)"]);
    expect(renderText(r)).toContain("FAIL  INV-1002 -> attachments/ghost.pdf\n      - row 3: not in the manifest");
    expect(r.entries.every((x: { status: string }) => x.status === "PASS")).toBe(true);
  });

  it("fails a listed attachment that was removed from the archive", () => {
    const a = makeArchive();
    a.build();
    rmSync(path.join(a.archive, "attachments", "po-1001.pdf"));
    const r = a.verify({ ...meta(a), attachmentsDir: "attachments" });
    expect(messages(r)).toEqual([
      "attachments/po-1001.pdf: file is in the manifest but missing from the archive",
      "INV-1001 -> attachments/po-1001.pdf: the file is in the manifest but missing from the archive",
    ]);
  });

  it("fails a listed attachment that is corrupted, and one named with a different case", () => {
    const a = makeArchive();
    a.build();
    appendFileSync(path.join(a.archive, "attachments", "po-1001.pdf"), "!");
    a.put("metadata/documents.csv", "Document,Attachment\nINV-1001,po-1001.pdf\nINV-1002,PHOTO-1002.bin\n");
    const m = a.manifest();
    const e = m.entries.find((x: { path: string }) => x.path === "metadata/documents.csv");
    const bytes = readFileSync(path.join(a.archive, "metadata", "documents.csv"));
    Object.assign(e, { size: bytes.length, sha256: sha(bytes) });
    a.writeManifest(m);
    const msgs = messages(a.verify({ ...meta(a), attachmentsDir: "attachments" }));
    expect(msgs).toContain("INV-1001 -> attachments/po-1001.pdf: the file fails verification (size-mismatch, hash-mismatch); see its entry");
    expect(msgs).toContain("INV-1002 -> attachments/PHOTO-1002.bin: not in the manifest under that name; the manifest has attachments/photo-1002.bin (differs only by case)");
  });

  it("rejects an attachment name that climbs out of the archive, and a missing column", () => {
    const a = makeArchive();
    a.build();
    a.put("metadata/documents.csv", "Document,Attachment\nINV-1001,../../etc/passwd\n,orphan.pdf\n");
    let msgs = messages(a.verify({ ...meta(a), attachmentsDir: "attachments" }));
    expect(msgs).toContain('INV-1001 -> attachments/../../etc/passwd: attachment name is unsafe: path traversal (a ".." segment)');
    expect(msgs.some((m) => m.includes("row 3 lists an attachment but no document reference") || m.includes("orphan.pdf"))).toBe(true);
    msgs = messages(a.verify({ ...meta(a), docColumn: "Doc No" }));
    expect(msgs[0]).toMatch(/has no "Doc No" column \(columns found: "Document", "Attachment"\)/);
  });

  it("warns, without failing, about an attachment no document refers to", () => {
    const a = makeArchive();
    a.put("attachments/unreferenced.pdf", "no document points here");
    a.build();
    const r = a.verify({ ...meta(a), attachmentsDir: "attachments" });
    expect(r.result).toBe("PASS");
    expect(r.warnings).toEqual(["attachment attachments/unreferenced.pdf is not referenced by any row of the metadata CSV"]);
  });

  it("supports custom columns and several files per cell", () => {
    const a = makeArchive();
    a.put("metadata/documents.csv", "Doc Ref,Files\nINV-1001,attachments/po-1001.pdf | attachments/photo-1002.bin\n");
    a.build();
    const r = a.verify({ ...meta(a), docColumn: "doc ref", fileColumn: "FILES" });
    expect(r.result).toBe("PASS");
    expect(r.relationships).toHaveLength(2);
  });
});

describe("verify is read only and offline", () => {
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const abs = path.join(d, name);
        const s = statSync(abs);
        if (s.isDirectory()) {
          out[`${path.relative(dir, abs)}/`] = `dir:${s.mtimeMs}`;
          walk(abs);
        } else out[path.relative(dir, abs)] = `${sha(readFileSync(abs))}:${s.size}:${s.mtimeMs}`;
      }
    };
    walk(dir);
    return out;
  };

  it("changes nothing in the archive, the manifest or anywhere else when --out is not given", () => {
    const a = makeArchive();
    a.build();
    const before = snapshot(a.root);
    for (const damage of [false, true]) {
      if (damage) rmSync(path.join(a.archive, "pdfs", "INV-1002.pdf"));
      const damaged = damage ? snapshot(a.root) : before;
      const code = main(["verify", a.archive, "--manifest", a.manifestPath, "--metadata", path.join(a.archive, "metadata", "documents.csv"), "--attachments-dir", "attachments"], () => {});
      expect(code).toBe(damage ? 1 : 0);
      expect(snapshot(a.root)).toEqual(damaged);
    }
  });

  it("uses no network: fetch, http, https, net, tls and dns are stubbed to throw and never called", async () => {
    const a = makeArchive();
    const net = (await import("node:net")).default;
    const http = (await import("node:http")).default;
    const https = (await import("node:https")).default;
    const dns = (await import("node:dns")).default;
    const tls = (await import("node:tls")).default;
    const { vi } = await import("vitest");
    const boom = () => {
      throw new Error("network use is not allowed");
    };
    const fetchStub = vi.fn(boom);
    vi.stubGlobal("fetch", fetchStub);
    const spies = [
      vi.spyOn(net, "connect").mockImplementation(boom),
      vi.spyOn(net, "createConnection").mockImplementation(boom),
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(boom),
      vi.spyOn(http, "request").mockImplementation(boom),
      vi.spyOn(http, "get").mockImplementation(boom),
      vi.spyOn(https, "request").mockImplementation(boom),
      vi.spyOn(https, "get").mockImplementation(boom),
      vi.spyOn(tls, "connect").mockImplementation(boom),
      vi.spyOn(dns, "lookup").mockImplementation(boom),
      vi.spyOn(dns, "resolve").mockImplementation(boom),
    ];
    try {
      a.build(["--csv"]);
      expect(main(["verify", a.archive, "--manifest", a.manifestPath, "--metadata", path.join(a.archive, "metadata", "documents.csv"), "--attachments-dir", "attachments", "--out", path.join(a.root, "rep")], () => {})).toBe(0);
      rmSync(path.join(a.archive, "customers.csv"));
      expect(main(["verify", a.archive, "--manifest", a.manifestPath], () => {})).toBe(1);
      expect(fetchStub).not.toHaveBeenCalled();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("imports only node:fs, node:path, node:crypto, node:url and the sliq-import parsers", () => {
    const dir = path.resolve(__dirname, "../../scripts/sliq-archive");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
      const src = readFileSync(path.join(dir, file), "utf8");
      const imports = [...src.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const spec of imports) expect(spec, `${file} imports ${spec}`).toMatch(/^(node:(fs|path|crypto|url)|\.\/[a-z-]+\.mjs|\.\.\/sliq-import\/(detect|parse)\.mjs)$/);
      expect(src, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|child_process|require\()/);
      // Only cli.mjs writes (temp file + rename into --out, removing its own temp file on failure); nothing else may.
      const allowed = file === "cli.mjs" ? "unlinkSync|renameSync" : "";
      const forbidden = ["unlinkSync", "rmSync", "renameSync", "appendFileSync", "copyFileSync", "truncateSync", "chmodSync", "utimesSync", "symlinkSync"].filter((f) => !allowed.split("|").includes(f));
      expect(src, file).not.toMatch(new RegExp(`\\b(${forbidden.join("|")})\\b`));
    }
  });
});

describe("command line", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });

  it("exits 0 for a good archive and non-zero for each kind of failure", () => {
    const a = makeArchive();
    const built = run("manifest", a.archive, "--out", a.out, "--exported-at", "2026-10-14T09:30:00Z", "--csv");
    expect(built.status).toBe(0);
    expect(built.stdout).toContain("Manifest: 8 files");
    const good = run("verify", a.archive, "--manifest", a.manifestPath);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("RESULT: PASS");
    writeFileSync(path.join(a.archive, "stray.txt"), "x");
    const bad = run("verify", a.archive, "--manifest", a.manifestPath);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("FAIL  stray.txt");
    expect(bad.stdout).toContain("RESULT: FAIL (1 extra)");
    expect(run("verify", a.archive).status).toBe(2);
    expect(run("verify", a.archive, "--manifest", a.manifestPath, "--nope").status).toBe(2);
    expect(run("manifest", a.archive, "--out", path.join(a.root, "o2")).status).toBe(2);
    expect(run("bogus").status).toBe(2);
  });
});
