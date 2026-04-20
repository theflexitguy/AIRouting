"use client";

import { useMemo } from "react";
import { parseSchedulingRequest, CRITICAL_CLASSES } from "@/lib/scheduling-constraints";
import { Phone, AlertTriangle, Calendar as CalendarIcon, MessageSquare } from "lucide-react";

interface ConstraintBadgesProps {
  schedulingRequest?: string;
  compact?: boolean;
}

export function ConstraintBadges({ schedulingRequest, compact = true }: ConstraintBadgesProps) {
  const parsed = useMemo(
    () => parseSchedulingRequest(schedulingRequest),
    [schedulingRequest]
  );

  if (!parsed.schedulingRequestClass) return null;

  const badges: Array<{
    label: string;
    color: string;
    bg: string;
    border: string;
    icon?: React.ReactNode;
  }> = [];

  // Critical holds — red
  if (CRITICAL_CLASSES.has(parsed.schedulingRequestClass)) {
    const label =
      parsed.schedulingRequestClass === "DO_NOT_SCHEDULE" ? "DO NOT SCHEDULE" :
      parsed.schedulingRequestClass === "PAYMENT_OR_ACCOUNT_HOLD" ? "PAYMENT HOLD" :
      "ADDRESS HOLD";
    badges.push({
      label,
      color: "text-red-400",
      bg: "bg-red-500/10",
      border: "border-red-500/20",
      icon: <AlertTriangle className="w-2.5 h-2.5" />,
    });
  }

  // Weekday rules — blue
  if (parsed.schedulingAllowedWeekdays) {
    badges.push({
      label: `${parsed.schedulingAllowedWeekdays} ONLY`,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
      border: "border-blue-500/20",
      icon: <CalendarIcon className="w-2.5 h-2.5" />,
    });
  }
  if (parsed.schedulingBlockedWeekdays) {
    badges.push({
      label: `NO ${parsed.schedulingBlockedWeekdays}`,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
      border: "border-blue-500/20",
      icon: <CalendarIcon className="w-2.5 h-2.5" />,
    });
  }

  // Phone confirm — orange
  if (parsed.schedulingRequiresPhoneConfirm) {
    badges.push({
      label: "CALL FIRST",
      color: "text-orange-400",
      bg: "bg-orange-500/10",
      border: "border-orange-500/20",
      icon: <Phone className="w-2.5 h-2.5" />,
    });
  }

  // Other constraint types — gray
  if (badges.length === 0 && parsed.schedulingRequestClass === "TIME_WINDOW_REQUEST") {
    badges.push({
      label: "TIME WINDOW",
      color: "text-muted-foreground",
      bg: "bg-accent/30",
      border: "border-border/40",
      icon: <MessageSquare className="w-2.5 h-2.5" />,
    });
  }

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {badges.map((badge, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold tracking-wide ${badge.color} ${badge.bg} ${badge.border} ${compact ? "" : "text-[10px] px-2 py-1"}`}
        >
          {badge.icon}
          {badge.label}
        </span>
      ))}
    </div>
  );
}
