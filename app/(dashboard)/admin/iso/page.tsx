/**
 * /admin/iso: thin page. Renders only the ISO pack component, which handles the admin-only refusal, the company switch (off by
 * default) and all reading. Must not change: no data access or logic belongs in this file.
 */
import { IsoPackView } from "@/components/iso/iso-pack-view";

export default function IsoTemplatesPage() {
  return <IsoPackView />;
}
