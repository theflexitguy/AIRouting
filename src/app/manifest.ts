import type { MetadataRoute } from "next";

// PWA / "Add to Home Screen" manifest. Next serves this at /manifest.webmanifest
// and injects the <link rel="manifest"> automatically.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RouteIQ",
    short_name: "RouteIQ",
    description: "AI-powered field service routing.",
    start_url: "/",
    display: "standalone",
    background_color: "#1a1a1a",
    theme_color: "#1a1a1a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
