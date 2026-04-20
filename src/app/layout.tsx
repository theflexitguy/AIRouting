import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "RouteIQ — AI-Powered Routing",
  description: "Autonomous field service routing powered by AI. Optimize routes, reduce drive time, and learn from every dispatch.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
