"use client";

import { Bell, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/contexts/AuthContext";

interface TopBarProps {
  title: string;
  onMenuToggle?: () => void;
}

export function TopBar({ title, onMenuToggle }: TopBarProps) {
  const { userProfile } = useAuth();
  const initials = userProfile?.email?.slice(0, 2).toUpperCase() ?? "RQ";

  return (
    <header className="h-14 border-b border-border/60 bg-background/80 backdrop-blur-md flex items-center justify-between px-4 lg:px-6 shrink-0 sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="lg:hidden -ml-1" onClick={onMenuToggle}>
          <Menu className="w-5 h-5" />
        </Button>
        <h1 className="text-base font-semibold text-foreground tracking-tight">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="relative h-9 w-9">
          <Bell className="w-[18px] h-[18px]" />
          <span className="absolute top-2 right-2 w-1.5 h-1.5 bg-blue-500 rounded-full ring-2 ring-background" />
        </Button>
        <Avatar className="w-8 h-8 cursor-pointer transition-opacity hover:opacity-80">
          <AvatarFallback className="bg-blue-500/15 text-blue-400 text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
