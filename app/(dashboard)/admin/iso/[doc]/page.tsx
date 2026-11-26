"use client";

/**
 * /admin/iso/[doc]: thin page. Renders only the ISO document editor for one of the nine documents; the editor handles the admin-only refusal, the
 * company switch (off by default), reading and saving. Must not change: no data access or logic belongs in this file.
 */
import { useParams } from "next/navigation";

import { IsoDocumentEditor } from "@/components/iso/iso-document-editor";

export default function IsoDocumentPage() {
  const params = useParams<{ doc: string }>();
  return <IsoDocumentEditor docId={decodeURIComponent(String(params?.doc ?? ""))} />;
}
