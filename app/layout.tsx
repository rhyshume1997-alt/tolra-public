// DO NOT MERGE: preview hub. Inputs: children. Output: the bare HTML frame for the UI preview site: noindex, no manifest, no service worker, no toaster that talks to a server.
// Must not be merged into any product branch.
import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/ui/sonner";
// Self-hosted fonts (same origin).
import "@fontsource/archivo/300.css";
import "@fontsource/archivo/400.css";
import "@fontsource/archivo/500.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tolra UI preview",
  description: "UI preview, sample data, nothing is saved.",
  robots: { index: false, follow: false, nocache: true },
  icons: { icon: [{ url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors />
      </body>
    </html>
  );
}
