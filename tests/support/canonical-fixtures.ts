/** Values whose canonical text and SHA-256 must be identical in TypeScript (lib/snapshot-hash.ts) and SQL (canonical_jsonb, 045). */
export const CANONICAL_FIXTURES: Record<string, unknown> = {
  empty_object: {},
  empty_array: [],
  empty_string: "",
  scalars: { t: true, f: false, n: null, s: "text" },
  quotes_and_backslashes: { "say \"hi\"": "C:\\path\\to\\file \"quoted\" 'single'", slash: "a/b</script>" },
  control_characters: { ctl: "\u0001\u0007\b\f\n\r\t\u000b\u001f\u007f end", "key\n\u0001\t": "x" },
  unicode: { café: "naïve façade", 中文: "工件 ✓", emoji: "😀 grinning", sep: "\u2028\u2029", nbsp: "\u00a0" },
  // UTF-16 order puts the astral key first; code point order (the rule) puts U+FF61 first.
  key_order: { "\uff61": true, "😀": false, b: "2", a: "1", B: "0", aa: "", "a b": "space" },
  nested_checklist: {
    job_no: "J-0001", worksheet_version: "3",
    checklist: { sizes_checked: true, threads_check: false, parts_deburred: null, nested: { deeper: ["x", true, null, { z: "", y: "\\" }] } },
    machines: [["Haas VF-2", "PRG-1"], [], [""]],
  },
};
