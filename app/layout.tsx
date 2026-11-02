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
  // The Tolra icon files in public/icons (made from public/brand), the same for every company.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
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
