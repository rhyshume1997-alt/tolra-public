/**
 * /jobs/ncr: thin page. Renders only the NCR register component, which handles the role refusal (admin and office), the company
 * switch (off by default) and all reading. Must not change: no data access or logic belongs in this file.
 */
import { NcrRegister } from "@/components/jobs/ncr-register";

export default function NcrRegisterPage() {
  return <NcrRegister />;
}
