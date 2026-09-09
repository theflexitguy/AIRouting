"use client";

import { AlertTriangle, Info, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SENSAI_EXCEPTION_COPY,
  SENSAI_GENERATE_HELP,
  driveTimeSourceBadgeLabel,
  type HorizonGuidance,
} from "@/lib/routing/drive-time-honesty";

export type RoutingStatusSummary = {
  paused?: boolean;
  healthy?: boolean;
  probed?: boolean;
  summary?: string;
  generateRefused?: boolean;
  routesApi?: {
    apiKeyConfigured?: boolean;
    mapsKeyPresent?: boolean;
  };
  routeOptimization?: {
    configured?: boolean;
    credentialSource?: string;
    projectId?: string;
  };
};

export function DriveTimeSourceBadge({
  source,
  className,
}: {
  source?: string | null;
  className?: string;
}) {
  const label = driveTimeSourceBadgeLabel(source);
  const estimate = label === "ESTIMATE";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1 py-px text-[9px] font-bold tracking-wide leading-none",
        estimate
          ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
          : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
        className,
      )}
      title={
        estimate
          ? "Straight-line estimate — not a road drive time"
          : "Road drive time from Google Routes API"
      }
    >
      {label}
    </span>
  );
}

export function DriveTimeHonestyBanner({
  status,
  estimateRouteCount,
  totalRouteCount,
}: {
  status: RoutingStatusSummary | null;
  estimateRouteCount: number;
  totalRouteCount: number;
}) {
  const paused = status?.paused === true;
  if (!paused && estimateRouteCount === 0) return null;

  return (
    <div
      className={cn(
        "px-3 lg:px-4 py-2.5 border-b no-print flex items-start gap-2.5",
        paused
          ? "border-amber-500/40 bg-amber-500/12"
          : "border-amber-500/25 bg-amber-500/8",
      )}
      role="status"
    >
      {paused ? (
        <PauseCircle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
      )}
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-amber-100">
          {paused
            ? "Google routing is PAUSED — drive times are estimates, not roads"
            : "Some drive times are ESTIMATE (straight-line), not road-snapped"}
        </p>
        <p className="text-xs text-amber-200/90 leading-relaxed">
          {paused
            ? status?.summary ||
              "GOOGLE_APIS_PAUSED is on. Generate is refused so RouteIQ never silently shows haversine as a real drive. Dashed map lines are stop-to-stop estimates — not snapped roads."
            : `${estimateRouteCount} of ${totalRouteCount} visible route${totalRouteCount === 1 ? "" : "s"} ${estimateRouteCount === 1 ? "uses" : "use"} straight-line minutes. Badge every drive metric ESTIMATE until Routes API returns a road time.`}
        </p>
      </div>
    </div>
  );
}

export function RoutingStatusPanel({ status }: { status: RoutingStatusSummary | null }) {
  if (!status) return null;
  const paused = status.paused === true;
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-1.5 text-[11px] leading-snug max-w-xl",
        paused
          ? "border-amber-500/30 bg-amber-500/8 text-amber-100"
          : status.healthy
            ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-200"
            : "border-border/60 bg-accent/20 text-muted-foreground",
      )}
    >
      <div className="flex items-start gap-1.5">
        <Info className="w-3 h-3 shrink-0 mt-0.5 opacity-80" />
        <div>
          <span className="font-semibold">Routing status:</span>{" "}
          {status.summary || (paused ? "Google APIs paused." : "Live status unavailable.")}
          {paused && (
            <span className="block mt-0.5 text-amber-200/80">
              Generate refused under pause. FieldRoutes sync and the dashboard stay current.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SensaiGenerateHints({
  horizon,
}: {
  horizon: HorizonGuidance | null;
}) {
  return (
    <div className="text-[10px] text-muted-foreground/80 leading-snug max-w-md">
      <p>{SENSAI_GENERATE_HELP}</p>
      {horizon?.message ? (
        <p
          className={cn(
            "mt-0.5 font-medium",
            horizon.level === "too_soon" || horizon.level === "too_far"
              ? "text-amber-300"
              : "text-sky-300/90",
          )}
        >
          {horizon.message}
        </p>
      ) : null}
    </div>
  );
}

export function ExceptionFirstCopy() {
  return (
    <p className="text-[10px] text-muted-foreground/70 leading-snug max-w-lg">
      {SENSAI_EXCEPTION_COPY}
    </p>
  );
}

export function SlinkyWeekWarning({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="px-3 lg:px-4 py-1.5 border-b border-sky-500/20 bg-sky-500/8 text-[11px] text-sky-200 no-print flex items-start gap-2">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

export function PausedGenerateEmptyState() {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-6 max-w-md text-center">
      <PauseCircle className="w-8 h-8 text-amber-300 mx-auto mb-3" />
      <p className="text-sm font-semibold text-amber-100">Generate is off while Google is paused</p>
      <p className="text-xs text-amber-200/80 mt-2 leading-relaxed">
        Route generation refuses under GOOGLE_APIS_PAUSED so we never return a
        silent haversine success. Existing routes still show — every drive minute
        is badged ESTIMATE and map lines are dashed straight-line, not fake roads.
      </p>
    </div>
  );
}
