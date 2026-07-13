"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Briefcase,
  Route,
  History,
  Brain,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogOut,
} from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/contexts/AuthContext";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: Briefcase },
  { href: "/routes", label: "Routes", icon: Route },
  { href: "/history", label: "History", icon: History },
  { href: "/learning", label: "AI Learning", icon: Brain },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { signOut, userProfile } = useAuth();

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex flex-col h-screen bg-[hsl(224,71%,3%)] border-r border-border/60 shrink-0 relative",
          "transition-[width] duration-300 ease-out",
          collapsed ? "w-16" : "w-60"
        )}
      >
        {/* Logo */}
        <div className={cn(
          "flex items-center h-16 px-4 border-b border-border/60",
          collapsed ? "justify-center" : "gap-3"
        )}>
          <Image src="/icons/icon-512.png" alt="routiq" width={32} height={32} className="w-8 h-8 rounded-lg shrink-0 shadow-lg shadow-black/30" />
          <span className={cn(
            "font-bold text-lg text-white tracking-tight transition-all duration-300",
            collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
          )}>
            routiq
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const linkEl = (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium min-h-[44px]",
                  "transition-all duration-150",
                  isActive
                    ? "bg-blue-500/10 text-blue-400"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  collapsed && "justify-center px-0"
                )}
              >
                <div className="relative shrink-0">
                  <Icon className={cn("transition-transform duration-150", collapsed ? "w-5 h-5" : "w-[18px] h-[18px]")} />
                  {isActive && (
                    <div className="absolute -left-[19px] top-1/2 -translate-y-1/2 w-[3px] h-4 bg-blue-400 rounded-r-full" />
                  )}
                </div>
                <span className={cn(
                  "transition-all duration-300",
                  collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
                )}>
                  {item.label}
                </span>
              </Link>
            );
            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
                  <TooltipContent side="right" className="font-medium">{item.label}</TooltipContent>
                </Tooltip>
              );
            }
            return linkEl;
          })}
        </nav>

        {/* Bottom */}
        <div className="p-2 border-t border-border/60 space-y-1">
          {!collapsed && userProfile && (
            <div className="px-3 py-2 text-xs text-muted-foreground/70 truncate">
              {userProfile.email}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size={collapsed ? "icon" : "sm"}
                className={cn(
                  "w-full text-muted-foreground hover:text-foreground transition-colors",
                  collapsed ? "" : "justify-start gap-3"
                )}
                onClick={signOut}
              >
                <LogOut className="w-4 h-4 shrink-0" />
                <span className={cn(
                  "transition-all duration-300",
                  collapsed ? "opacity-0 w-0 overflow-hidden sr-only" : "opacity-100"
                )}>
                  Sign out
                </span>
              </Button>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">Sign out</TooltipContent>}
          </Tooltip>
        </div>

        {/* Collapse toggle */}
        <button
          className={cn(
            "absolute -right-3 top-20 w-6 h-6 rounded-full border border-border/60 bg-background",
            "flex items-center justify-center shadow-sm z-10",
            "hover:bg-accent hover:border-border transition-colors duration-150"
          )}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronRight className="w-3 h-3 text-muted-foreground" /> : <ChevronLeft className="w-3 h-3 text-muted-foreground" />}
        </button>
      </aside>
    </TooltipProvider>
  );
}
