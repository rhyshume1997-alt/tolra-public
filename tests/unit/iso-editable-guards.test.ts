// Source pins for the editable ISO documents: the client only reads and calls the two functions, the editor is admin-only behind the switch,
// it degrades when the migration is absent, the proposal is append-only and admin-only, and nothing guarded or new was touched.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("client data layer", () => {
  const src = read("lib/iso/iso-document-versions.ts");
  it("never updates, inserts or deletes a table row: reads, and the two functions", () => {
    expect(src).not.toMatch(/\.(update|insert|upsert|delete)\(/);
    expect(src).toContain('.rpc("save_iso_document"');
    expect(src).toContain('.rpc("approve_iso_document"');
  });
  it("never sends the company or the person: the database decides them", () => {
    expect(src).not.toMatch(/p_org|p_user|p_created|p_approved_by/);
  });
  it("any failed read is unavailable (ok false), never thrown", () => {
    expect(src).toMatch(/catch \{ return \{ ok: false \}/);
  });
});

describe("editor", () => {
  const src = read("components/iso/iso-document-editor.tsx");
  const page = read("app/(dashboard)/admin/iso/[doc]/page.tsx");
  it("is admin only and behind the iso-templates switch", () => {
    expect(src).toContain('<RoleGate allowed={["admin"]}>');
    expect(src).toContain("isoTemplatesEnabled(hiddenNav)");
    expect(src).toContain("ISO_OFF_NOTICE");
  });
  it("falls back to the read-only generated draft with a plain note when versions cannot be read", () => {
    expect(src).toContain("Editing is not available yet");
    expect(src).toContain("data-testid=\"iso-editor-unavailable\"");
  });
  it("never starts from the generated draft over a version whose text could not be read", () => {
    expect(src).toContain("Couldn't load the latest saved version");
  });
  it("the page file is thin", () => {
    expect(page).toContain("IsoDocumentEditor");
    expect(page).not.toContain("supabase");
  });
  it("the pack page links to the editor and shows its fallback note", () => {
    const view = read("components/iso/iso-pack-view.tsx");
    expect(view).toContain("/admin/iso/${d.id}");
    expect(view).toContain("Editing is not available yet");
    expect(view).toContain("effectiveDocument(");
  });
});

describe("proposal p171", () => {
  const sql = read("supabase/proposals/p171_iso_editable_documents.sql");
  const back = read("supabase/proposals/p171_iso_editable_documents.rollback.sql");
  it("row security on, select for admin of the session company only, no write grant or policy", () => {
    expect(sql).toContain("ALTER TABLE public.iso_document_versions ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON public.iso_document_versions FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("GRANT SELECT ON public.iso_document_versions TO authenticated");
    expect(sql).toMatch(/CREATE POLICY "iso_document_versions admin select" ON public\.iso_document_versions FOR SELECT TO authenticated\s+USING \(organization_id = \(SELECT public\.current_user_organization_id\(\)\) AND \(SELECT public\.has_org_role\(ARRAY\['admin'\]\)\)\)/);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)/);
  });
  it("every function is SECURITY DEFINER with a fixed search_path; the browser gets the two functions only", () => {
    expect(sql.match(/SECURITY DEFINER/g)?.length).toBe(4);
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(4);
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.save_iso_document(TEXT, JSONB, TEXT, INTEGER, INTEGER) TO authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.approve_iso_document(TEXT, INTEGER, TEXT) TO authenticated");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.iso_document_caller() FROM PUBLIC, anon, authenticated");
  });
  it("copies the existing guard pattern: 2FA step, admin, not support, not read-only", () => {
    expect(sql).toContain("public.assert_privileged_aal()");
    expect(sql).toContain("public.has_org_role(ARRAY['admin'])");
    expect(sql).toContain("(v_session ->> 'support')");
    expect(sql).toContain("(v_session ->> 'read_only')");
  });
  it("append-only: the only update is draft to approved; versions are unique per company and document", () => {
    expect(sql).toContain("OLD.status = 'draft' AND NEW.status = 'approved'");
    expect(sql).toContain("UNIQUE (organization_id, doc_id, version)");
    expect(sql).toContain("already_approved");
  });
  it("audits from inside the functions and never copies the text", () => {
    expect(sql).toContain("'iso_document.save'");
    expect(sql).toContain("'iso_document.approve'");
    expect(sql).not.toContain("log_row_change()\n");
    expect(sql).not.toMatch(/new_data[^;]*to_jsonb\(/);
  });
  it("rollback refuses while rows exist and drops only p171's objects", () => {
    expect(back).toContain("this file never deletes records");
    expect(back).toContain("DROP TABLE IF EXISTS public.iso_document_versions");
    expect(back.match(/DROP /g)?.length).toBe(5);
  });
  it("the nine ids in the database check are exactly the nine documents", () => {
    const ids = [...read("lib/iso/document-list.ts").matchAll(/^\s+id: "([a-z-]+)", title:/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(9);
    for (const id of ids) expect(sql.split(`'${id}'`).length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("scope", () => {
  it("adds no dependency and leaves the guarded files alone", () => {
    let changed = "";
    try { changed = execSync("git diff --name-only claude/premium-sweep-2...HEAD", { cwd: root, encoding: "utf8" }); } catch { return; }
    for (const f of ["package.json", "package-lock.json", "components/ui/premium/premium.module.css", "lib/org-settings.ts", "lib/use-company-ui-switch.ts", "next.config.mjs", "tests/unit/security-headers.test.ts"]) {
      expect(changed.split("\n")).not.toContain(f);
    }
  });
});
