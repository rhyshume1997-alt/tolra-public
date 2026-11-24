/** Live settings navigation and presentation. Panel controls, writes and Document Designs are rendered by the route. */
import type { ReactNode } from "react";

import { PageHeader, premiumTokens } from "@/components/ui/premium";

import styles from "./settings-redesign.module.css";

export function SettingsRedesign({ productName, company, documentDesigns, panels }: {
  productName: string;
  company: ReactNode;
  documentDesigns: ReactNode;
  panels: ReactNode;
}) {
  return (
    <div className={styles.screen} data-testid="settings-v2">
      <PageHeader title="Settings" description={`Company-wide settings for ${productName}. Only admins can change them.`} />
      <nav className={`${premiumTokens} ${styles.jumps}`} aria-label="Jump to settings">
        <a href="#setup-company">Company</a>
        <a href="#setup-breaks">Working hours</a>
        <a href="#setup-email">Email templates</a>
      </nav>
      <div className={`${premiumTokens} ${styles.panels}`}>{company}</div>
      {documentDesigns}
      <div className={`${premiumTokens} ${styles.panels}`}>{panels}</div>
    </div>
  );
}
