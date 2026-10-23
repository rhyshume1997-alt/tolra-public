import { auditEvent } from "@/lib/audit";
import type { AuditTable } from "@/lib/audit-contract";
import { esc } from "@/lib/html";

/**
 * Opens a printable window.
 *
 * SECURITY: `sectionsHtml` is written into the page as raw HTML. Callers MUST
 * build every section with esc() from "@/lib/html" around each interpolated
 * value (customer names, descriptions, notes...). `title` is escaped here.
 *
 * Returns false when the browser blocked the pop-up; callers should then
 * toast "Allow pop-ups to print".
 */
export function openPrintPack(title: string, sectionsHtml: string[], entityTable: AuditTable): boolean {
  const win = window.open("", "_blank", "width=1000,height=800");
  if (!win) return false;

  void auditEvent({
    action: "PRINT_PACK",
    entityTable,
    metadata: { title, section_count: sectionsHtml.length },
  });

  const safeTitle = esc(title);
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; padding: 32px; }
    h1 { text-align: center; letter-spacing: .08em; }
    section { page-break-after: always; border: 1px solid #cbd5e1; padding: 24px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    td, th { border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
    .box { display: inline-block; width: 18px; height: 18px; border: 1px solid #111827; margin-right: 8px; vertical-align: middle; }
    @media print { button { display: none; } body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${sectionsHtml.join("")}
</body>
</html>`;
  win.document.write(html);
  win.document.close();
  // Print from the opener: no inline script runs inside the document.
  window.setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch (err) {
      console.error(err);
    }
  }, 350);
  return true;
}
