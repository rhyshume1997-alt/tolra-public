import type { Metadata, Viewport } from "next";
import { PwaRegister } from "@/components/pwa-register";
import { Toaster } from "@/components/ui/sonner";
// Self-hosted fonts (no third-party requests; allowed by the CSP's font-src 'self').
import "@fontsource/archivo/300.css";
import "@fontsource/archivo/400.css";
import "@fontsource/archivo/500.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { PRODUCT } from "@/lib/product";

export const metadata: Metadata = {
  title: PRODUCT.name,
  description: PRODUCT.tagline,
  robots: { index: false, follow: false },
  applicationName: PRODUCT.name,
  // iPhone / iPad "Add to Home Screen": opens full screen with the company's icon.
  appleWebApp: { capable: true, title: PRODUCT.shortName, statusBarStyle: "default" },
  // The Tolra app icon (lib/server/app-icon.tsx), the same for every company.
  icons: {
    icon: [{ url: "/api/pwa-icon?size=32", sizes: "32x32", type: "image/png" }, { url: "/api/pwa-icon?size=192", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/api/pwa-icon?size=180", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: PRODUCT.appTheme,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/* The install manifest (app/manifest.webmanifest/route.ts). */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors />
        <PwaRegister />
      </body>
    </html>
  );
}
