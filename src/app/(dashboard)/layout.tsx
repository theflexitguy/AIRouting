"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Sidebar } from "@/components/layout/Sidebar";
import { Zap } from "lucide-react";

const isDemoMode = !process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === "your-firebase-project-id";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user && !isDemoMode) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse-soft" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse-soft" style={{ animationDelay: "200ms" }} />
            <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse-soft" style={{ animationDelay: "400ms" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!user && !isDemoMode) return null;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background relative">
      {isDemoMode && (
        <div className="shrink-0 bg-blue-500/8 border-b border-blue-500/15 text-blue-400 text-xs text-center py-1.5 px-4">
          Demo mode — showing sample data.{" "}
          <a
            href="https://vercel.com/dashboard"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-blue-300 transition-colors"
          >
            Add Firebase credentials in Vercel
          </a>{" "}
          to go live.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile overlay */}
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-20 lg:hidden transition-opacity"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}

        {/* Sidebar - hidden on mobile unless open */}
        <div className={`
          lg:relative fixed inset-y-0 left-0 z-30
          transition-transform duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]
          ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}>
          <Sidebar />
        </div>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
