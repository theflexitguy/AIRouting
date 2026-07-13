import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "RouteIQ — AI-Powered Routing",
  applicationName: "RouteIQ",
  description: "Autonomous field service routing powered by AI. Optimize routes, reduce drive time, and learn from every dispatch.",
  // icon.png / apple-icon.png in app/ are auto-detected by Next for favicon and
  // the iOS home-screen icon; the manifest (app/manifest.ts) supplies the PWA
  // install icons.
  appleWebApp: {
    capable: true,
    title: "RouteIQ",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#1a1a1a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased">
        <AuthProvider>
          {children}
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: { background: "hsl(224 71% 4%)", border: "1px solid hsl(216 34% 17%)", color: "hsl(213 31% 91%)" },
            }}
          />
        </AuthProvider>
      </body>
    </html>
  );
}
