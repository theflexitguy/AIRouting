"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  LayoutDashboard, Route, Briefcase, History, Brain,
  Settings, Wand2, Upload, RefreshCw, Search
} from "lucide-react";

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, group: "Navigation" },
  { label: "Route Builder", href: "/routes", icon: Route, group: "Navigation" },
  { label: "Jobs", href: "/jobs", icon: Briefcase, group: "Navigation" },
  { label: "History", href: "/history", icon: History, group: "Navigation" },
  { label: "AI Learning", href: "/learning", icon: Brain, group: "Navigation" },
  { label: "Settings", href: "/settings", icon: Settings, group: "Navigation" },
];

const ACTION_ITEMS = [
  { label: "Generate Routes", href: "/routes", icon: Wand2, group: "Actions", hint: "Open route builder" },
  { label: "Upload Jobs CSV", href: "/jobs", icon: Upload, group: "Actions", hint: "Open jobs page" },
  { label: "Retrain AI Model", href: "/learning", icon: RefreshCw, group: "Actions", hint: "Open learning page" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setOpen(prev => !prev);
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleSelect = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={() => setOpen(false)}
      />

      {/* Command dialog */}
      <div className="absolute top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg animate-scale-in">
        <Command
          className="bg-card border border-border/60 rounded-xl shadow-2xl shadow-black/30 overflow-hidden"
          loop
        >
          <div className="flex items-center gap-2 px-4 border-b border-border/40">
            <Search className="w-4 h-4 text-muted-foreground/50 shrink-0" />
            <Command.Input
              placeholder="Search pages and actions..."
              className="w-full h-12 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
              autoFocus
            />
            <kbd className="text-[10px] text-muted-foreground/40 bg-accent/50 px-1.5 py-0.5 rounded border border-border/30 shrink-0">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground/50">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigation" className="text-[11px] text-muted-foreground/40 uppercase tracking-wider px-2 py-1.5">
              {NAV_ITEMS.map(item => (
                <Command.Item
                  key={item.href}
                  value={item.label}
                  onSelect={() => handleSelect(item.href)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground cursor-pointer transition-colors data-[selected=true]:bg-accent/50 data-[selected=true]:text-foreground"
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Separator className="h-px bg-border/30 my-1" />

            <Command.Group heading="Actions" className="text-[11px] text-muted-foreground/40 uppercase tracking-wider px-2 py-1.5">
              {ACTION_ITEMS.map(item => (
                <Command.Item
                  key={item.label}
                  value={item.label}
                  onSelect={() => handleSelect(item.href)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground cursor-pointer transition-colors data-[selected=true]:bg-accent/50 data-[selected=true]:text-foreground"
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {item.hint && (
                    <span className="text-[11px] text-muted-foreground/30">{item.hint}</span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>

          <div className="px-4 py-2 border-t border-border/30 flex items-center gap-4 text-[11px] text-muted-foreground/30">
            <span><kbd className="bg-accent/50 px-1 py-0.5 rounded border border-border/30">↑↓</kbd> navigate</span>
            <span><kbd className="bg-accent/50 px-1 py-0.5 rounded border border-border/30">↵</kbd> select</span>
            <span><kbd className="bg-accent/50 px-1 py-0.5 rounded border border-border/30">esc</kbd> close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
