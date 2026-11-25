"use client";
/** Live settings navigation and presentation. Panel controls, writes and Document Designs are rendered by the route. */
import { useState, type ReactNode } from "react";

import { PageHeader, Tabs, premiumTokens } from "@/components/ui/premium";

import styles from "./settings-redesign.module.css";

const JUMPS = [
  { value: "setup-company", label: "Company" },
  { value: "setup-breaks", label: "Working hours" },
  { value: "setup-email", label: "Email templates" },
];

export function SettingsRedesign({ productName, company, documentDesigns, panels }: {
  productName: string;
  company: ReactNode;
  documentDesigns: ReactNode;
  panels: ReactNode;
}) {
  const [jump, setJump] = useState(JUMPS[0].value);
  return (
    <div className={styles.screen} data-testid="settings-v2">
      <PageHeader title="Settings" description={`Company-wide settings for ${productName}. Only admins can change them.`} />
      {/* Same three targets as before; selecting one scrolls to its section, nothing is hidden or reordered. */}
      <div className={premiumTokens}>
        <Tabs label="Jump to settings" value={jump} tabs={JUMPS} onChange={(value) => { setJump(value); document.getElementById(value)?.scrollIntoView({ block: "start", behavior: "smooth" }); }} />
      </div>
      <div className={`${premiumTokens} ${styles.panels}`}>{company}</div>
      {documentDesigns}
      <div className={`${premiumTokens} ${styles.panels}`}>{panels}</div>
    </div>
  );
}
