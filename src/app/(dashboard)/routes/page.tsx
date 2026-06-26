"use client";

import { useEffect, useState, useRef, useCallback, useMemo, type ReactNode } from "react";
import { collection, getDoc, getDocs, query, where, doc, updateDoc, deleteDoc, writeBatch, setDoc, onSnapshot, documentId } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { Route, Job, Technician } from "@/types";
import { formatTime, cn } from "@/lib/utils";
import { calculateStopProductionValue, formatCurrency } from "@/lib/production-value";
import {
  Loader2, Wand2, CheckCircle, XCircle, GripVertical,
  Clock, AlertTriangle, Calendar,
  Printer, Share2, Pencil, MoreVertical, ArrowRight, MousePointerClick, DollarSign, Layers,
  Check, ChevronDown, Users
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { format, addDays } from "date-fns";
import { toast } from "sonner";
import { ConstraintBadges } from "@/components/routes/ConstraintBadges";
import { parseSchedulingRequest, CRITICAL_CLASSES } from "@/lib/scheduling-constraints";
import { getSubscriptionLastServiced, routeAddressKey, serviceDueAlreadyCompleted } from "@/lib/route-bundles";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEditHistory } from "@/hooks/useEditHistory";
import { Undo2, Redo2 } from "lucide-react";

const TECH_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
// Neutral gray for FieldRoutes appointments with no tech assigned.
const UNASSIGNED_ROUTE_COLOR = "#94a3b8";
// Synthetic tech id prefix for unassigned FieldRoutes appointments (no real tech).
const UNASSIGNED_TECH_PREFIX = "__unassigned__";

function isUnassignedRoute(tr: { tech: { id?: string } }) {
  return String(tr.tech?.id || "").startsWith(UNASSIGNED_TECH_PREFIX);
}
const NW_ARK = { lat: 36.07, lng: -94.17 };
const ROUTE_DROP_PREFIX = "route:";
const FIELDROUTES_SCHEDULED_ROUTE_PREFIX = "fieldroutes-scheduled:";
const WEEKDAY_LABEL_BY_JS_DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface RoadRouteResult {
  path: Array<{ lat: number; lng: number }>;
  totalDriveMinutes: number;
  failedLegs: number;
  status: string;
  driveTimeSource: string;
  polylineSource: string;
  encodedPolyline?: string;
  warnings?: string[];
}

const roadRouteCache = new Map<string, Promise<RoadRouteResult>>();

function routeDropId(routeId: string) {
  return `${ROUTE_DROP_PREFIX}${routeId}`;
}

function parseRouteDropId(id: string) {
  return id.startsWith(ROUTE_DROP_PREFIX) ? id.slice(ROUTE_DROP_PREFIX.length) : null;
}

function fieldRoutesScheduledRouteId(date: string, techId: string) {
  return `${FIELDROUTES_SCHEDULED_ROUTE_PREFIX}${date}:${techId}`;
}

function isFieldRoutesScheduledRoute(routeOrId: Route | string) {
  const id = typeof routeOrId === "string" ? routeOrId : routeOrId.id;
  return id.startsWith(FIELDROUTES_SCHEDULED_ROUTE_PREFIX);
}

function offsetDateString(dateStr: string, days: number) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return dateStr;
  date.setDate(date.getDate() + days);
  return format(date, "yyyy-MM-dd");
}

function normalizeMatchValue(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type MultiSelectOption = { id: string; label: string; hint?: string };

/**
 * Compact multi-select dropdown used for the technician and date filters.
 * Replaces the long chip rows so the header stays small. Supports select-all,
 * clear, and toggling individual options (clear + pick one = single select).
 */
function MultiSelectDropdown({
  label,
  icon,
  options,
  selectedIds,
  onChange,
  allLabel,
  emptyLabel = "None selected",
  triggerClassName,
}: {
  label: string;
  icon?: ReactNode;
  options: MultiSelectOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  allLabel?: string;
  emptyLabel?: string;
  triggerClassName?: string;
}) {
  const total = options.length;
  const selectedSet = new Set(selectedIds);
  const count = options.filter((o) => selectedSet.has(o.id)).length;
  const allSelected = total > 0 && count === total;
  const summary =
    count === 0
      ? emptyLabel
      : allSelected
        ? allLabel ?? `All (${total})`
        : count === 1
          ? options.find((o) => selectedSet.has(o.id))?.label ?? "1 selected"
          : `${count} of ${total}`;

  const toggle = (id: string) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-9 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-3 text-sm hover:bg-accent/50 transition-colors max-w-[220px]",
            triggerClassName,
          )}
          title={`${label}: ${summary}`}
        >
          {icon}
          <span className="text-muted-foreground shrink-0">{label}:</span>
          <span className="font-medium truncate">{summary}</span>
          <ChevronDown className="w-4 h-4 ml-0.5 opacity-60 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onChange(options.map((o) => o.id))}
              className="text-[11px] px-1.5 py-0.5 rounded text-blue-400 hover:bg-blue-500/10"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[11px] px-1.5 py-0.5 rounded text-muted-foreground hover:bg-accent"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {options.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing to show</div>
          ) : (
            options.map((o) => {
              const checked = selectedSet.has(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggle(o.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent/60"
                >
                  <span
                    className={cn(
                      "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                      checked ? "bg-blue-500 border-blue-500 text-white" : "border-border",
                    )}
                  >
                    {checked && <Check className="w-3 h-3" />}
                  </span>
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="text-[11px] text-muted-foreground shrink-0">{o.hint}</span>}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function technicianMatchTokens(tech: Technician) {
  return [
    tech.id,
    tech.name,
    tech.employeeId,
    (tech as unknown as Record<string, unknown>).fieldRoutesEmployeeId,
    (tech as unknown as Record<string, unknown>).fieldRoutesTechId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function jobAssignedToTech(job: Job, tech: Technician) {
  const assignedValues = [
    job.assignedTechId,
    job.fieldRoutesServicedBy,
    job.fieldRoutesServicedById,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (assignedValues.length === 0) return true;

  const tokens = technicianMatchTokens(tech);
  return assignedValues.some((assigned) => {
    const assignedNormalized = normalizeMatchValue(assigned);
    return tokens.some((token) => token === assigned || normalizeMatchValue(token) === assignedNormalized);
  });
}

function assignedTechBlockReason(job: Job, tech: Technician) {
  const assigned = String(job.assignedTechId || job.fieldRoutesServicedBy || job.fieldRoutesServicedById || "").trim();
  if (!assigned) return "";
  return jobAssignedToTech(job, tech) ? "" : `assigned to ${assigned}`;
}

function fieldRoutesScheduledDateForJob(job: Job) {
  return String(job.fieldRoutesScheduledDate || job.scheduledDate || "").trim();
}

function isFieldRoutesScheduledJob(job: Job) {
  return Boolean(job.fieldRoutesScheduled || job.fieldRoutesServicedBy || job.fieldRoutesServicedById);
}

function weekdaySet(value: string) {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

function weekdayLabelForDate(dateStr: string) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const day = date.getUTCDay();
  return WEEKDAY_LABEL_BY_JS_DAY[Number.isFinite(day) ? day : 0];
}

function jobScheduleBlockReason(job: Job, routeDate: string) {
  const parsed = parseSchedulingRequest(job.schedulingRequest);
  if (!parsed.schedulingRequestClass) return "";

  if (CRITICAL_CLASSES.has(parsed.schedulingRequestClass)) {
    return parsed.schedulingConstraintNote || parsed.schedulingRequestClass;
  }

  const weekday = weekdayLabelForDate(routeDate);
  const allowed = weekdaySet(parsed.schedulingAllowedWeekdays);
  if (allowed.size > 0 && !allowed.has(weekday)) {
    return `requires ${parsed.schedulingAllowedWeekdays}`;
  }

  const blocked = weekdaySet(parsed.schedulingBlockedWeekdays);
  if (blocked.has(weekday)) {
    return `no ${weekday}`;
  }

  return "";
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const radiusMiles = 3958.7613;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radiusMiles * 2 * Math.asin(Math.sqrt(h));
}

function estimateRouteMetrics(stopSequence: string[], jobsById: Record<string, Job>) {
  let totalDriveTimeMinutes = 0;
  let totalServiceMinutes = 0;
  let previous: Job | null = null;

  for (const jobId of stopSequence) {
    const job = jobsById[jobId];
    if (!job) continue;

    totalServiceMinutes += Number(job.duration || 25);
    if (
      previous?.lat !== undefined &&
      previous.lng !== undefined &&
      job.lat !== undefined &&
      job.lng !== undefined
    ) {
      totalDriveTimeMinutes +=
        (distanceMiles(
          { lat: previous.lat, lng: previous.lng },
          { lat: job.lat, lng: job.lng },
        ) /
          30) *
        60;
    }
    previous = job;
  }

  const roundedDrive = Math.round(totalDriveTimeMinutes);
  return {
    totalStops: stopSequence.length,
    totalDriveTimeMinutes: roundedDrive,
    totalWorkMinutes: roundedDrive + totalServiceMinutes,
    driveTimeSource: "haversine_fallback",
    polylineSource: "haversine_fallback",
    encodedPolyline: "",
    routePolyline: [],
    polylineStatus: "ESTIMATE_ONLY",
    failedRouteSegments: Math.max(0, stopSequence.length - 1),
  };
}

interface RouteMetricSummary {
  totalStops: number;
  totalDriveTimeMinutes: number;
  totalWorkMinutes: number;
  driveTimeSource?: string;
  polylineSource?: string;
  encodedPolyline?: string;
  routePolyline?: Array<{ lat: number; lng: number }>;
  polylineStatus?: string;
  failedRouteSegments?: number;
}

function getOrderedJobsWithCoordinates(stopSequence: string[], jobsById: Record<string, Job>) {
  const jobs = stopSequence.map((jobId) => jobsById[jobId]).filter(Boolean) as Job[];
  if (
    jobs.length !== stopSequence.length ||
    jobs.some((job) => typeof job.lat !== "number" || typeof job.lng !== "number")
  ) {
    return null;
  }
  return jobs;
}

function roadRouteCacheKey(jobs: Job[]) {
  return jobs
    .map((job) => `${Number(job.lat).toFixed(6)},${Number(job.lng).toFixed(6)}`)
    .join("|");
}

async function getRoadRouteForJobs(jobs: Job[], routeDate?: string): Promise<RoadRouteResult> {
  if (jobs.length < 2) {
    return {
      path: [],
      totalDriveMinutes: 0,
      failedLegs: 0,
      status: "NO_STOPS",
      driveTimeSource: "haversine_fallback",
      polylineSource: "haversine_fallback",
    };
  }

  const cacheKey = `${routeDate || "now"}::${roadRouteCacheKey(jobs)}`;
  const cached = roadRouteCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const res = await fetch("/api/route-geometry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routeDate,
        jobs: jobs.map((job) => ({
          id: job.id,
          lat: job.lat,
          lng: job.lng,
          duration: job.duration,
        })),
      }),
    });

    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      path?: Array<{ lat: number; lng: number }>;
      driveMinutes?: number;
      status?: string;
      failedSegments?: number;
      driveTimeSource?: string;
      polylineSource?: string;
      encodedPolyline?: string;
      warnings?: string[];
      error?: string;
    } | null;

    if (!res.ok || !data?.success) {
      return {
        path: [],
        totalDriveMinutes: 0,
        failedLegs: Math.max(0, jobs.length - 1),
        status: data?.error || `HTTP_${res.status}`,
        driveTimeSource: "haversine_fallback",
        polylineSource: "haversine_fallback",
        warnings: data?.warnings,
      };
    }

    return {
      path: data.path || [],
      totalDriveMinutes: Number(data.driveMinutes || 0),
      failedLegs: Number(data.failedSegments || 0),
      status: data.status || "OK",
      driveTimeSource: data.driveTimeSource || "haversine_fallback",
      polylineSource: data.polylineSource || "haversine_fallback",
      encodedPolyline: data.encodedPolyline,
      warnings: data.warnings,
    };
  })();

  roadRouteCache.set(cacheKey, promise);
  return promise;
}

async function calculateRouteMetricsFromRoads(
  stopSequence: string[],
  jobsById: Record<string, Job>,
  routeDate?: string,
): Promise<RouteMetricSummary> {
  const estimated = estimateRouteMetrics(stopSequence, jobsById);
  const jobs = getOrderedJobsWithCoordinates(stopSequence, jobsById);
  if (!jobs || jobs.length < 2) return estimated;

  const roadRoute = await getRoadRouteForJobs(jobs, routeDate);
  if (roadRoute.failedLegs > 0 || roadRoute.path.length === 0) {
    return {
      ...estimated,
      driveTimeSource: roadRoute.driveTimeSource,
      polylineSource: roadRoute.polylineSource,
      polylineStatus: roadRoute.status,
      failedRouteSegments: roadRoute.failedLegs,
      routePolyline: [],
      encodedPolyline: "",
    };
  }

  const roundedDrive = Math.round(roadRoute.totalDriveMinutes);
  return {
    totalStops: stopSequence.length,
    totalDriveTimeMinutes: roundedDrive,
    totalWorkMinutes: roundedDrive + getRouteServiceMinutes(stopSequence, jobsById),
    driveTimeSource: roadRoute.driveTimeSource,
    polylineSource: roadRoute.polylineSource,
    polylineStatus: roadRoute.status,
    failedRouteSegments: roadRoute.failedLegs,
    routePolyline: roadRoute.path,
    encodedPolyline: roadRoute.encodedPolyline || "",
  };
}

type RouteWithMetrics = Route;

type ApproveRouteUploadResult = {
  sync?: RouteWithMetrics["fieldRoutesSync"];
  stopSequence?: string[];
  totalStops?: number;
  totalServiceMinutes?: number;
  totalWorkMinutes?: number;
};

function getRouteServiceMinutes(stopSequence: string[], jobsById: Record<string, Job>) {
  return stopSequence.reduce((total, jobId) => {
    const job = jobsById[jobId];
    return total + Number(job?.duration || 25);
  }, 0);
}

function getRouteProductionValue(stopSequence: string[], jobsById: Record<string, Job>) {
  return stopSequence.reduce((total, jobId) => {
    const job = jobsById[jobId];
    const stopValue = job ? calculateStopProductionValue(job).value : null;
    return total + (stopValue ?? 0);
  }, 0);
}

function getRouteDisplayMetrics(route: Route, jobsById: Record<string, Job>) {
  const routeWithMetrics = route as RouteWithMetrics;
  const estimated = estimateRouteMetrics(route.stopSequence, jobsById);
  const driveMinutes = Number.isFinite(Number(route.totalDriveTimeMinutes))
    ? Math.round(Number(route.totalDriveTimeMinutes))
    : estimated.totalDriveTimeMinutes;
  const serviceMinutes = getRouteServiceMinutes(route.stopSequence, jobsById);
  const workMinutes = Number.isFinite(Number(routeWithMetrics.totalWorkMinutes))
    ? Math.round(Number(routeWithMetrics.totalWorkMinutes))
    : driveMinutes + serviceMinutes;

  return {
    stops: route.stopSequence.length,
    driveMinutes,
    serviceMinutes,
    workMinutes,
    productionValue: getRouteProductionValue(route.stopSequence, jobsById),
  };
}

function applyMetricsToRoute(route: Route, metrics: RouteMetricSummary): RouteWithMetrics {
  return {
    ...route,
    totalStops: metrics.totalStops,
    totalDriveTimeMinutes: metrics.totalDriveTimeMinutes,
    totalWorkMinutes: metrics.totalWorkMinutes,
    driveTimeSource: metrics.driveTimeSource || route.driveTimeSource || "haversine_fallback",
    polylineSource: metrics.polylineSource || route.polylineSource || "haversine_fallback",
    encodedPolyline: metrics.encodedPolyline ?? route.encodedPolyline ?? "",
    routePolyline: metrics.routePolyline ?? route.routePolyline ?? [],
    polylineStatus: metrics.polylineStatus || route.polylineStatus || "",
    failedRouteSegments: metrics.failedRouteSegments ?? route.failedRouteSegments ?? 0,
  };
}

function routeMetricUpdateFields(metrics: RouteMetricSummary) {
  return {
    totalStops: metrics.totalStops,
    totalDriveTimeMinutes: metrics.totalDriveTimeMinutes,
    totalWorkMinutes: metrics.totalWorkMinutes,
    driveTimeSource: metrics.driveTimeSource || "haversine_fallback",
    polylineSource: metrics.polylineSource || "haversine_fallback",
    encodedPolyline: metrics.encodedPolyline || "",
    routePolyline: metrics.routePolyline || [],
    polylineStatus: metrics.polylineStatus || "",
    failedRouteSegments: metrics.failedRouteSegments || 0,
  };
}

function shouldClearGeneratedAssignment(route: Route, job?: Job) {
  return (
    route.generatedBy === "ai" &&
    Boolean(route.updatedAt) &&
    job?.assignedTechId === route.techId &&
    job.updatedAt === route.updatedAt
  );
}

function describeDirectionsStatus(status?: string) {
  if (status === "REQUEST_DENIED") {
    return "Google rejected the server Routes API request. Check that the server API key has Routes API enabled and billing active.";
  }
  if (status === "OVER_QUERY_LIMIT") {
    return "Google rate-limited the Routes API request. Try again after a moment or increase the Routes quota.";
  }
  if (status === "ZERO_RESULTS") {
    return "Google could not find a drivable route for at least one stop pair.";
  }
  if (status === "INVALID_REQUEST" || status === "INVALID_COORDINATES") {
    return "One or more stops have invalid coordinates for Routes API road geometry.";
  }
  if (status === "MISSING_GOOGLE_MAPS_API_KEY") {
    return "The server is missing GOOGLE_MAPS_API_KEY, so road geometry cannot be requested.";
  }
  return "Google Routes API did not return road geometry for this route.";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function routeStatsHtml(tr: TechRoute, jobsById: Record<string, Job>) {
  const stats = getRouteDisplayMetrics(tr.route, jobsById);
  return `<div style="color:#111;padding:8px;min-width:220px;max-width:280px">
    <div style="font-weight:700;margin-bottom:2px">${escapeHtml(tr.tech.name)}</div>
    <div style="color:#666;font-size:12px;margin-bottom:8px">${escapeHtml(tr.route.date)} · ${stats.stops} stops</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
      <div><div style="color:#777">Drive</div><div style="font-weight:700">${formatTime(stats.driveMinutes)}</div></div>
      <div><div style="color:#777">At stops</div><div style="font-weight:700">${formatTime(stats.serviceMinutes)}</div></div>
      <div><div style="color:#777">Route value</div><div style="font-weight:700">${formatCurrency(stats.productionValue)}</div></div>
      <div style="grid-column:1 / -1;border-top:1px solid #e5e7eb;padding-top:7px">
        <div style="color:#777">Estimated working day</div>
        <div style="font-size:18px;font-weight:800">${formatTime(stats.workMinutes)}</div>
      </div>
    </div>
  </div>`;
}

function poolJobHtml(job: Job) {
  const stopProduction = calculateStopProductionValue(job);
  const lastServiced = getSubscriptionLastServiced(job);
  return `<div style="color:#111;padding:8px;max-width:270px">
    <div style="font-weight:700;margin-bottom:2px">${escapeHtml(job.customerName)}</div>
    <div style="color:#666;font-size:12px;margin-bottom:6px">${escapeHtml(job.address)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">
      <div><div style="color:#777">Due</div><div style="font-weight:700">${escapeHtml(job.scheduledDate || "No date")}</div></div>
      <div><div style="color:#777">Last serviced</div><div style="font-weight:700">${escapeHtml(lastServiced || "-")}</div></div>
      <div><div style="color:#777">Duration</div><div style="font-weight:700">${Number(job.duration || 25)} min</div></div>
      <div><div style="color:#777">Value</div><div style="font-weight:700">${formatCurrency(stopProduction.value)}</div></div>
      <div style="grid-column:1 / -1"><div style="color:#777">Assigned</div><div style="font-weight:700">${escapeHtml(job.assignedTechId || "Open")}</div></div>
    </div>
  </div>`;
}

interface TechRoute {
  route: Route;
  tech: Technician;
  jobs: Job[];
  color: string;
  expanded: boolean;
}

interface StopMenuTarget { routeId: string; techName: string; color: string; date: string; }

function RoutePanelStats({ route, jobsById }: {
  route: Route;
  jobsById: Record<string, Job>;
}) {
  const stats = getRouteDisplayMetrics(route, jobsById);
  const routeWithMetrics = route as RouteWithMetrics;
  const sync = routeWithMetrics.fieldRoutesSync;

  return (
    <div className="grid grid-cols-2 gap-1.5 p-2 border-b border-border/40 bg-accent/10">
      <div className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5">
        <p className="text-[9px] uppercase tracking-wide text-muted-foreground/50">Drive</p>
        <p className="text-xs font-semibold text-foreground">{formatTime(stats.driveMinutes)}</p>
      </div>
      <div className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5">
        <p className="text-[9px] uppercase tracking-wide text-muted-foreground/50">Service</p>
        <p className="text-xs font-semibold text-foreground">{formatTime(stats.serviceMinutes)}</p>
      </div>
      <div className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5">
        <p className="text-[9px] uppercase tracking-wide text-muted-foreground/50">Day</p>
        <p className="text-xs font-semibold text-foreground">{formatTime(stats.workMinutes)}</p>
      </div>
      <div className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5">
        <p className="text-[9px] uppercase tracking-wide text-muted-foreground/50">Value</p>
        <p className="text-xs font-semibold text-emerald-400">{formatCurrency(stats.productionValue)}</p>
      </div>
      {sync?.uploadedAt && (
        <div className="col-span-2 space-y-0.5 text-[10px] text-emerald-400/80">
          <p className="truncate">
            FR route #{sync.routeId || "-"} · {sync.routeDate || sync.dateInputUsed || route.date}{sync.routeTime ? ` ${sync.routeTime}` : ""}
          </p>
          <p className="truncate">
            Employee {sync.assignedTech || "-"} · {sync.routeStatus || "synced"} · uploaded {new Date(sync.uploadedAt).toLocaleString()}
          </p>
          {sync.verifiedAt && (
            <p className="truncate text-emerald-300/70">
              Verified {new Date(sync.verifiedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SortableStop({ job, index, color, dragDisabled, clickOrderActive, clickOrderRank, onClick, onRemove, moveTargets, onMoveTo, onHoverStart, onHoverEnd }: {
  job: Job; index: number; color: string;
  dragDisabled?: boolean;
  clickOrderActive?: boolean;
  clickOrderRank?: number;
  onClick?: () => void;
  onRemove?: () => void;
  moveTargets?: StopMenuTarget[];
  onMoveTo?: (targetRouteId: string) => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: job.id, disabled: dragDisabled });
  const stopProduction = calculateStopProductionValue(job);
  return (
    <div
      ref={setNodeRef}
      data-job-id={job.id}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn(
        "group/stop flex items-center gap-2.5 p-3 rounded-lg bg-accent/20 border border-border/40 mb-1.5 cursor-default touch-manipulation relative",
        "transition-[box-shadow,background,border-color] duration-200",
        clickOrderActive && "cursor-pointer hover:bg-blue-500/10 hover:border-blue-500/30",
        clickOrderRank && "ring-2 ring-amber-400/60 bg-amber-500/10 border-amber-400/30",
        isDragging && "shadow-xl shadow-blue-500/15 border-blue-500/30 ring-2 ring-blue-500/20 scale-[1.02]",
      )}
      onClick={onClick}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div
        {...(!dragDisabled ? attributes : {})}
        {...(!dragDisabled ? listeners : {})}
        className={cn(
          "text-muted-foreground/40 hover:text-muted-foreground touch-none transition-colors",
          dragDisabled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
        )}
      >
        <GripVertical className="w-4 h-4" />
      </div>
      <div
        className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
        style={{ background: clickOrderRank ? "#f59e0b" : color }}
      >
        {clickOrderRank || index + 1}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{job.customerName}</p>
        <p className="text-xs text-muted-foreground/60 truncate">{job.address}</p>
        <ConstraintBadges schedulingRequest={(job as unknown as Record<string, unknown>).schedulingRequest as string} />
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-xs text-muted-foreground/50 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {job.duration}m
          </span>
          <span className="text-xs text-emerald-400/80 flex items-center gap-1" title={stopProduction.explanation}>
            <DollarSign className="w-3 h-3" />
            {formatCurrency(stopProduction.value)}
          </span>
        </div>
        {(onRemove || moveTargets) && (
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              className="opacity-0 group-hover/stop:opacity-100 ml-1 p-1 rounded hover:bg-accent/50 text-muted-foreground/30 hover:text-muted-foreground transition-all"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-card border border-border/60 rounded-lg shadow-xl shadow-black/20 py-1 animate-scale-in">
                  {moveTargets && moveTargets.length > 0 && (
                    <>
                      <p className="px-3 py-1 text-[10px] text-muted-foreground/40 uppercase tracking-wider">Move to</p>
                      {moveTargets.map(t => (
                        <button
                          key={t.routeId}
                          onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveTo?.(t.routeId); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 transition-colors"
                        >
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                          <div className="flex-1 min-w-0">
                            <span className="truncate block">{t.techName}</span>
                            <span className="text-[10px] text-muted-foreground/40">{t.date}</span>
                          </div>
                          <ArrowRight className="w-3 h-3 shrink-0 text-muted-foreground/30" />
                        </button>
                      ))}
                    </>
                  )}
                  {onRemove && (
                    <>
                      <div className="h-px bg-border/30 my-1" />
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRemove(); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors"
                      >
                        <XCircle className="w-3 h-3" />
                        Remove from route
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DroppableStopList({ routeId, enabled, children }: {
  routeId: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: routeDropId(routeId),
    disabled: !enabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "p-2 min-h-20 transition-colors",
        enabled && isOver && "bg-blue-500/5",
      )}
    >
      {children}
    </div>
  );
}

export default function RoutesPage() {
  const { userProfile } = useAuth();
  const [startDate, setStartDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(addDays(new Date(), 6), "yyyy-MM-dd"));
  const [maxStops, setMaxStops] = useState<number>(16);
  const [maxDriveTime, setMaxDriveTime] = useState<number>(240);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("routeiq.generateSettings.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { maxStops?: number; targetStops?: number; maxDriveTime?: number };
      const targetStops = typeof parsed.targetStops === "number" ? parsed.targetStops : parsed.maxStops;
      if (typeof targetStops === "number" && targetStops > 0) {
        setMaxStops(targetStops);
      }
      if (typeof parsed.maxDriveTime === "number" && parsed.maxDriveTime > 0) {
        setMaxDriveTime(parsed.maxDriveTime);
      }
    } catch {
      // ignore malformed localStorage
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(
      "routeiq.generateSettings.v1",
      JSON.stringify({ targetStops: maxStops, maxStops, maxDriveTime }),
    );
  }, [maxStops, maxDriveTime]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]); // which days to show (multi-select)
  const [techs, setTechs] = useState<Technician[]>([]);
  const [selectedTechIds, setSelectedTechIds] = useState<string[]>([]);
  const [allRoutes, setAllRoutes] = useState<TechRoute[]>([]); // all routes in date range
  const [allJobs, setAllJobs] = useState<{ [jobId: string]: Job }>({});
  const [generating, setGenerating] = useState(false);
  const [genStage, setGenStage] = useState("");
  const [genResult, setGenResult] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [geocodingStops, setGeocodingStops] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [allowCrossTechRouteEdits, setAllowCrossTechRouteEdits] = useState(true);
  const [showJobPoolLayer, setShowJobPoolLayer] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(true);
  const [jobPoolDueStart, setJobPoolDueStart] = useState(startDate);
  const [jobPoolDueEnd, setJobPoolDueEnd] = useState(endDate);
  const [jobPoolFilterTouched, setJobPoolFilterTouched] = useState(false);
  // Hover is ref-based (no re-renders) — uses direct DOM manipulation
  const hoveredStopIdRef = useRef<string | null>(null);
  const [leftPanelRouteId, setLeftPanelRouteId] = useState<string | null>(null);
  const [rightPanelRouteId, setRightPanelRouteId] = useState<string | null>(null);
  const [clickReorderRouteId, setClickReorderRouteId] = useState<string | null>(null);
  const [clickReorderSequence, setClickReorderSequence] = useState<string[]>([]);
  const heldKeyRef = useRef<string | null>(null);

  // Track L/R key hold state for map click assignment
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "l" || e.key === "L") heldKeyRef.current = "l";
      if (e.key === "r" || e.key === "R") heldKeyRef.current = "r";
    };
    const up = () => { heldKeyRef.current = null; };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => { document.removeEventListener("keydown", down); document.removeEventListener("keyup", up); };
  }, []);
  const mapMarkerByJobId = useRef<Map<string, google.maps.Marker>>(new Map());
  const hasFittedBounds = useRef(false);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const openMapInfoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const mapMarkersRef = useRef<google.maps.Marker[]>([]);
  const mapPolylinesRef = useRef<google.maps.Polyline[]>([]);
  const roadSnapWarningsRef = useRef<Set<string>>(new Set());
  // Self-heal for stops missing map coordinates: track which jobs we've already
  // tried to geocode (so a genuinely unresolvable address can't loop) and whether
  // a heal pass is currently in flight.
  const autoGeocodeAttemptedRef = useRef<Set<string>>(new Set());
  const autoGeocodeInFlightRef = useRef(false);

  useEffect(() => {
    if (jobPoolFilterTouched) return;
    setJobPoolDueStart(startDate);
    setJobPoolDueEnd(endDate);
  }, [endDate, jobPoolFilterTouched, startDate]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { pushEdit, undo, redo, canUndo, canRedo } = useEditHistory();

  const actualRoutedJobIds = useMemo(() => {
    const ids = new Set<string>();
    allRoutes.forEach((tr) => (tr.route.stopSequence || []).forEach((jobId) => ids.add(jobId)));
    return ids;
  }, [allRoutes]);
  const selectedJobPoolTechs = useMemo(
    () => techs.filter((tech) => selectedTechIds.includes(tech.id)),
    [selectedTechIds, techs],
  );
  const scheduledFieldRoutes = useMemo<TechRoute[]>(() => {
    if (!userProfile?.companyId || selectedJobPoolTechs.length === 0) return [];
    const companyId = userProfile.companyId;

    const groups = new Map<string, { date: string; tech: Technician; jobs: Job[]; color: string }>();
    Object.values(allJobs).forEach((job) => {
      if (!isFieldRoutesScheduledJob(job) || actualRoutedJobIds.has(job.id)) return;
      const routeDate = fieldRoutesScheduledDateForJob(job);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return;
      if (routeDate < startDate || routeDate > endDate) return;
      if (typeof job.lat !== "number" || typeof job.lng !== "number") return;

      // Unassigned FieldRoutes appointments (no tech assigned in FieldRoutes)
      // must NOT be attributed to a selected tech or merged together. Keep each
      // on its own route, grouped by the FieldRoutes route it belongs to, and
      // label it "Unassigned" so it reads the same as "No Tech Assigned" there.
      const assignedTech = String(
        job.assignedTechId || job.fieldRoutesServicedBy || job.fieldRoutesServicedById || "",
      ).trim();
      if (!assignedTech) {
        const frRouteId = String(job.fieldRoutesRouteId || "").trim();
        const routeKey = frRouteId || job.id;
        const key = `${routeDate}::${UNASSIGNED_TECH_PREFIX}::${routeKey}`;
        if (!groups.has(key)) {
          groups.set(key, {
            date: routeDate,
            tech: {
              id: `${UNASSIGNED_TECH_PREFIX}:${routeKey}`,
              name: "Unassigned",
              employeeId: "",
              active: true,
              maxStopsPerDay: 99,
              companyId,
            } as Technician,
            jobs: [],
            color: UNASSIGNED_ROUTE_COLOR,
          });
        }
        groups.get(key)?.jobs.push(job);
        return;
      }

      const techIndex = selectedJobPoolTechs.findIndex((tech) => jobAssignedToTech(job, tech));
      if (techIndex < 0) return;
      const tech = selectedJobPoolTechs[techIndex];
      const key = `${routeDate}:${tech.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          date: routeDate,
          tech,
          jobs: [],
          color: TECH_COLORS[techIndex % TECH_COLORS.length],
        });
      }
      groups.get(key)?.jobs.push(job);
    });

    return Array.from(groups.values())
      .sort((a, b) => a.date.localeCompare(b.date) || a.tech.name.localeCompare(b.tech.name))
      .map((group) => {
        const jobs = group.jobs.sort((a, b) => {
          const dueDiff = String(a.scheduledDate || "").localeCompare(String(b.scheduledDate || ""));
          if (dueDiff !== 0) return dueDiff;
          return String(a.customerName || a.id).localeCompare(String(b.customerName || b.id));
        });
        const stopSequence = jobs.map((job) => job.id);
        const metrics = estimateRouteMetrics(stopSequence, allJobs);
        return {
          route: {
            id: fieldRoutesScheduledRouteId(group.date, group.tech.id),
            companyId,
            date: group.date,
            techId: group.tech.id,
            stopSequence,
            totalDriveTimeMinutes: metrics.totalDriveTimeMinutes,
            totalServiceMinutes: getRouteServiceMinutes(stopSequence, allJobs),
            totalWorkMinutes: metrics.totalWorkMinutes,
            totalStops: stopSequence.length,
            driveTimeSource: metrics.driveTimeSource,
            polylineSource: metrics.polylineSource,
            encodedPolyline: metrics.encodedPolyline,
            routePolyline: metrics.routePolyline,
            polylineStatus: metrics.polylineStatus,
            failedRouteSegments: metrics.failedRouteSegments,
            generatedBy: "human",
            confidence: 1,
            approved: true,
            fieldRoutesSync: {
              routeStatus: "scheduled_csv",
              routeDate: group.date,
              assignedTech: group.tech.name,
              total: stopSequence.length,
            },
            createdAt: `${group.date}T00:00:00.000Z`,
            updatedAt: `${group.date}T00:00:00.000Z`,
          } as Route,
          tech: group.tech,
          jobs,
          color: group.color,
          expanded: true,
        };
      });
  }, [actualRoutedJobIds, allJobs, endDate, selectedJobPoolTechs, startDate, userProfile?.companyId]);
  // Scheduled FieldRoutes stops that fall in the selected range + tech but get
  // silently dropped from the virtual route (e.g. failed geocoding). Surfacing
  // these explains why a route can show fewer stops here than in FieldRoutes.
  const hiddenScheduledStops = useMemo<Array<{ job: Job; techName: string; date: string; reason: string }>>(() => {
    if (selectedJobPoolTechs.length === 0) return [];
    const hidden: Array<{ job: Job; techName: string; date: string; reason: string }> = [];
    Object.values(allJobs).forEach((job) => {
      if (!isFieldRoutesScheduledJob(job) || actualRoutedJobIds.has(job.id)) return;
      const routeDate = fieldRoutesScheduledDateForJob(job);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return;
      if (routeDate < startDate || routeDate > endDate) return;
      const tech = selectedJobPoolTechs.find((t) => jobAssignedToTech(job, t));
      if (!tech) return;
      if (typeof job.lat !== "number" || typeof job.lng !== "number") {
        hidden.push({ job, techName: tech.name, date: routeDate, reason: "missing map coordinates (address not geocoded)" });
      }
    });
    return hidden;
  }, [actualRoutedJobIds, allJobs, endDate, selectedJobPoolTechs, startDate]);

  const displayRoutes = useMemo(
    () => [...allRoutes, ...scheduledFieldRoutes],
    [allRoutes, scheduledFieldRoutes],
  );
  // Get unique dates that have routes
  const routeDates = [...new Set(displayRoutes.map((tr) => tr.route.date))].sort();
  const routeDateKey = routeDates.join("|");
  // Routes for the selected dates AND technicians. Like the date filter, an
  // empty selection or "all techs selected" shows everything (so routes for a
  // tech who isn't in the active list aren't accidentally hidden). Narrowing the
  // Technicians dropdown filters the map and the route list down to those techs.
  const techFilterActive = selectedTechIds.length > 0 && selectedTechIds.length < techs.length;
  const selectedTechIdSet = new Set(selectedTechIds);
  const visibleRoutes = displayRoutes.filter((tr) => {
    const unassigned = isUnassignedRoute(tr);
    if (unassigned && !showUnassigned) return false;
    if (selectedDates.length > 0 && !selectedDates.includes(tr.route.date)) return false;
    // The technician filter never applies to unassigned routes — they belong to
    // no tech, so the dedicated toggle controls their visibility instead.
    if (techFilterActive && !unassigned && !selectedTechIdSet.has(tr.tech.id)) return false;
    return true;
  });
  // Unassigned FieldRoutes routes within the selected dates, for the toggle badge.
  const unassignedRouteCount = displayRoutes.filter(
    (tr) => isUnassignedRoute(tr) && (selectedDates.length === 0 || selectedDates.includes(tr.route.date)),
  ).length;
  const pendingVisibleRoutes = visibleRoutes.filter(tr => !tr.route.approved && !isFieldRoutesScheduledRoute(tr.route));
  const routedJobIds = useMemo(() => {
    const ids = new Set<string>();
    displayRoutes.forEach((tr) => (tr.route.stopSequence || []).forEach((jobId) => ids.add(jobId)));
    return ids;
  }, [displayRoutes]);
  const jobPoolJobs = useMemo(() => {
    return Object.values(allJobs)
      .filter((job) => {
        if (selectedJobPoolTechs.length === 0) return false;
        if (!selectedJobPoolTechs.some((tech) => jobAssignedToTech(job, tech))) return false;
        if (routedJobIds.has(job.id)) return false;
        if (typeof job.lat !== "number" || typeof job.lng !== "number") return false;
        const status = String(job.status || "pending").toLowerCase();
        if (status === "completed" || status === "cancelled") return false;
        if (job.serviceDueAlreadyCompleted || serviceDueAlreadyCompleted(job)) return false;
        const dueDate = String(job.scheduledDate || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;
        if (jobPoolDueStart && dueDate < jobPoolDueStart) return false;
        if (jobPoolDueEnd && dueDate > jobPoolDueEnd) return false;
        return true;
      })
      .sort((a, b) => {
        const dateDiff = String(a.scheduledDate || "").localeCompare(String(b.scheduledDate || ""));
        if (dateDiff !== 0) return dateDiff;
        return String(a.customerName || a.id).localeCompare(String(b.customerName || b.id));
      });
  }, [allJobs, jobPoolDueEnd, jobPoolDueStart, routedJobIds, selectedJobPoolTechs]);

  const getJobsForRoute = useCallback((tr: TechRoute): Job[] => {
    return (tr.route.stopSequence || []).map(id => allJobs[id]).filter(Boolean) as Job[];
  }, [allJobs]);

  useEffect(() => {
    const dates = routeDateKey ? routeDateKey.split("|") : [];
    if (dates.length === 0) {
      setSelectedDates([]);
      return;
    }
    setSelectedDates((prev) => {
      const stillVisible = prev.filter((date) => dates.includes(date));
      const next = stillVisible.length > 0 ? stillVisible : dates;
      return next.length === prev.length && next.every((date, idx) => date === prev[idx]) ? prev : next;
    });
  }, [routeDateKey]);

  const warnRoadSnapFailure = useCallback((routeId: string, message: string) => {
    if (roadSnapWarningsRef.current.has(routeId)) return;
    roadSnapWarningsRef.current.add(routeId);
    toast.warning(message, { duration: 9000 });
  }, []);

  const calculateRouteMetrics = useCallback(
    (stopSequence: string[], routeDate?: string) =>
      calculateRouteMetricsFromRoads(stopSequence, allJobs, routeDate),
    [allJobs],
  );
  const canAssignJobToRoute = useCallback((job: Job | undefined, tr: TechRoute) => {
    if (!job || allowCrossTechRouteEdits) return true;
    return !assignedTechBlockReason(job, tr.tech);
  }, [allowCrossTechRouteEdits]);

  const handleMoveStop = useCallback(async (
    jobId: string,
    fromRouteId: string,
    toRouteId: string,
    insertAfterJobId?: string,
  ) => {
    if (!userProfile?.companyId || fromRouteId === toRouteId) return;
    const fromRoute = displayRoutes.find(r => r.route.id === fromRouteId);
    const toRoute = allRoutes.find(r => r.route.id === toRouteId);
    if (!fromRoute || !toRoute) return;
    const job = allJobs[jobId];
    const assignedBlock = !allowCrossTechRouteEdits && job ? assignedTechBlockReason(job, toRoute.tech) : "";
    if (assignedBlock) {
      toast.error(`${job?.customerName || "Stop"} is ${assignedBlock}, not ${toRoute.tech.name}.`);
      return;
    }

    const fromRouteIsVirtual = isFieldRoutesScheduledRoute(fromRoute.route);
    const newFromSeq = fromRoute.route.stopSequence.filter(id => id !== jobId);
    const newToSeq = toRoute.route.stopSequence.filter(id => id !== jobId);
    const insertAfterIndex = insertAfterJobId ? newToSeq.indexOf(insertAfterJobId) : -1;
    if (insertAfterIndex >= 0) {
      newToSeq.splice(insertAfterIndex + 1, 0, jobId);
    } else {
      newToSeq.push(jobId);
    }

    const shouldDeleteEmptySourceRoute = !fromRouteIsVirtual && newFromSeq.length === 0 && !fromRoute.route.approved;
    const [fromMetrics, toMetrics] = await Promise.all([
      fromRouteIsVirtual || shouldDeleteEmptySourceRoute
        ? Promise.resolve<RouteMetricSummary | null>(null)
        : calculateRouteMetrics(newFromSeq, fromRoute.route.date),
      calculateRouteMetrics(newToSeq, toRoute.route.date),
    ]);
    const previousRoutes = allRoutes;
    const previousJob = allJobs[jobId] ? { ...allJobs[jobId] } : null;
    const now = new Date().toISOString();

    setAllRoutes(allRoutes.flatMap(r => {
      if (r.route.id === fromRouteId) {
        if (shouldDeleteEmptySourceRoute) return [];
        return [{
          ...r,
          route: applyMetricsToRoute({
            ...r.route,
            stopSequence: newFromSeq,
            generatedBy: "human" as const,
          }, fromMetrics as RouteMetricSummary),
        }];
      }
      if (r.route.id === toRouteId) {
        return [{
          ...r,
          route: applyMetricsToRoute({
            ...r.route,
            stopSequence: newToSeq,
            generatedBy: "human" as const,
          }, toMetrics),
        }];
      }
      return [r];
    }));
    setAllJobs(prev => ({
      ...prev,
      [jobId]: {
        ...prev[jobId],
        assignedTechId: toRoute.tech.id,
        status: "scheduled",
        updatedAt: now,
      },
    }));
    if (shouldDeleteEmptySourceRoute || (fromRouteIsVirtual && newFromSeq.length === 0)) {
      if (leftPanelRouteId === fromRouteId) setLeftPanelRouteId(null);
      if (rightPanelRouteId === fromRouteId) setRightPanelRouteId(null);
    }

    try {
      const batch = writeBatch(db);
      if (!fromRouteIsVirtual) {
        const fromRouteRef = doc(db, `companies/${userProfile.companyId}/routes`, fromRouteId);
        if (shouldDeleteEmptySourceRoute) {
          batch.delete(fromRouteRef);
        } else {
          batch.update(fromRouteRef, {
            stopSequence: newFromSeq,
            ...routeMetricUpdateFields(fromMetrics as RouteMetricSummary),
            generatedBy: "human",
            updatedAt: now,
          });
        }
      }
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, toRouteId), {
        stopSequence: newToSeq,
        ...routeMetricUpdateFields(toMetrics),
        generatedBy: "human",
        updatedAt: now,
      });
      batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, jobId), {
        assignedTechId: toRoute.tech.id,
        status: "scheduled",
        updatedAt: now,
      });
      await batch.commit();

      if (!fromRouteIsVirtual) {
        fetch("/api/record-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: userProfile.companyId,
            routeId: fromRouteId,
            originalRoute: fromRoute.route,
            modifiedRoute: { ...fromRoute.route, stopSequence: newFromSeq },
            modifiedBy: userProfile.email,
          }),
        }).catch(() => {});
      }
      fetch("/api/record-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId: toRouteId,
          originalRoute: toRoute.route,
          modifiedRoute: { ...toRoute.route, stopSequence: newToSeq },
          modifiedBy: userProfile.email,
        }),
      }).catch(() => {});

      toast.success(`Moved ${job?.customerName || "stop"} → ${toRoute.tech.name}`);
    } catch (e) {
      console.error("Move stop error:", e);
      setAllRoutes(previousRoutes);
      if (previousJob) setAllJobs(prev => ({ ...prev, [jobId]: previousJob }));
      toast.error("Failed to move stop");
    }
  }, [allJobs, allRoutes, allowCrossTechRouteEdits, calculateRouteMetrics, displayRoutes, leftPanelRouteId, rightPanelRouteId, userProfile?.companyId, userProfile?.email]);

  const handleAddPoolJobToRoute = useCallback(async (
    jobId: string,
    toRouteId: string,
    insertAfterJobId?: string,
  ) => {
    if (!userProfile?.companyId) return;
    const job = allJobs[jobId];
    const toRoute = allRoutes.find(r => r.route.id === toRouteId);
    if (!job || !toRoute) return;
    if ((toRoute.route.stopSequence || []).includes(jobId)) return;

    const assignedBlock = !allowCrossTechRouteEdits ? assignedTechBlockReason(job, toRoute.tech) : "";
    if (assignedBlock) {
      toast.error(`${job.customerName || "Job"} is ${assignedBlock}, not ${toRoute.tech.name}.`);
      return;
    }

    const scheduleBlock = jobScheduleBlockReason(job, toRoute.route.date);
    if (scheduleBlock) {
      toast.error(`${job.customerName || "Job"} cannot be scheduled on ${toRoute.route.date}: ${scheduleBlock}.`);
      return;
    }

    const bundleKey = routeAddressKey(job);
    const routeMonth = toRoute.route.date.slice(0, 7);
    const bundleHorizon = offsetDateString(toRoute.route.date, 14);
    const bundleJobs = Object.values(allJobs)
      .filter((candidate) => {
        if (candidate.id === jobId) return true;
        if (!bundleKey || routeAddressKey(candidate) !== bundleKey) return false;
        if (routedJobIds.has(candidate.id)) return false;
        const status = String(candidate.status || "pending").toLowerCase();
        if (status === "completed" || status === "cancelled") return false;
        if (candidate.serviceDueAlreadyCompleted || serviceDueAlreadyCompleted(candidate)) return false;
        const dueDate = String(candidate.scheduledDate || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;
        if (dueDate > bundleHorizon && dueDate.slice(0, 7) !== routeMonth) return false;
        if (!allowCrossTechRouteEdits && assignedTechBlockReason(candidate, toRoute.tech)) return false;
        if (jobScheduleBlockReason(candidate, toRoute.route.date)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.id === jobId) return -1;
        if (b.id === jobId) return 1;
        const dateDiff = String(a.scheduledDate || "").localeCompare(String(b.scheduledDate || ""));
        if (dateDiff !== 0) return dateDiff;
        return String(a.serviceType || a.id).localeCompare(String(b.serviceType || b.id));
      });
    const bundleJobIds = bundleJobs.map((candidate) => candidate.id);

    const oldSeq = toRoute.route.stopSequence || [];
    const newSeq = oldSeq.filter(id => !bundleJobIds.includes(id));
    const insertAfterIndex = insertAfterJobId ? newSeq.indexOf(insertAfterJobId) : -1;
    if (insertAfterIndex >= 0) {
      newSeq.splice(insertAfterIndex + 1, 0, ...bundleJobIds);
    } else {
      newSeq.push(...bundleJobIds);
    }

    const metrics = await calculateRouteMetrics(newSeq, toRoute.route.date);
    const previousRoutes = allRoutes;
    const previousJobs = Object.fromEntries(bundleJobs.map((bundleJob) => [bundleJob.id, bundleJob]));
    const now = new Date().toISOString();

    setAllRoutes(allRoutes.map(r =>
      r.route.id === toRouteId
        ? {
            ...r,
            route: applyMetricsToRoute({
              ...r.route,
              stopSequence: newSeq,
              generatedBy: "human" as const,
            }, metrics),
          }
        : r,
    ));
    setAllJobs(prev => ({
      ...prev,
      ...Object.fromEntries(
        bundleJobs.map((bundleJob) => [
          bundleJob.id,
          {
            ...prev[bundleJob.id],
            assignedTechId: toRoute.tech.id,
            status: "scheduled",
            updatedAt: now,
          },
        ]),
      ),
    }));

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, toRouteId), {
        stopSequence: newSeq,
        ...routeMetricUpdateFields(metrics),
        generatedBy: "human",
        updatedAt: now,
      });
      bundleJobs.forEach((bundleJob) => {
        batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, bundleJob.id), {
          assignedTechId: toRoute.tech.id,
          status: "scheduled",
          updatedAt: now,
        });
      });
      await batch.commit();

      pushEdit({
        type: "addStop",
        timestamp: Date.now(),
        description: "Added pool stop to route",
        before: [{ routeId: toRouteId, stopSequence: oldSeq, date: toRoute.route.date }],
        after: [{ routeId: toRouteId, stopSequence: newSeq, date: toRoute.route.date }],
      });
      fetch("/api/record-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId: toRouteId,
          originalRoute: toRoute.route,
          modifiedRoute: { ...toRoute.route, stopSequence: newSeq },
          modifiedBy: userProfile.email,
        }),
      }).catch(() => {});

      toast.success(
        bundleJobs.length > 1
          ? `Added ${bundleJobs.length} same-address jobs → ${toRoute.tech.name}`
          : `Added ${job.customerName || "job"} → ${toRoute.tech.name}`,
      );
    } catch (e) {
      console.error("Add pool job error:", e);
      setAllRoutes(previousRoutes);
      setAllJobs(prev => ({ ...prev, ...previousJobs }));
      toast.error("Failed to add job to route");
    }
  }, [allJobs, allRoutes, allowCrossTechRouteEdits, calculateRouteMetrics, pushEdit, routedJobIds, userProfile?.companyId, userProfile?.email]);

  const handleRemoveStop = useCallback(async (tr: TechRoute, jobId: string) => {
    if (!userProfile?.companyId) return;
    if (tr.route.approved) {
      toast.error("Approved routes must be undone or unscheduled before editing stops.");
      return;
    }

    const job = allJobs[jobId];
    const oldSeq = tr.route.stopSequence || [];
    if (!oldSeq.includes(jobId)) return;

    const newSeq = oldSeq.filter(id => id !== jobId);
    const metrics = await calculateRouteMetrics(newSeq, tr.route.date);
    const previousRoutes = allRoutes;
    const previousJob = job ? { ...job } : null;
    const now = new Date().toISOString();

    setAllRoutes(allRoutes.map(r =>
      r.route.id === tr.route.id
        ? {
            ...r,
            route: applyMetricsToRoute({
              ...r.route,
              stopSequence: newSeq,
              generatedBy: "human" as const,
            }, metrics),
          }
        : r,
    ));
    if (job) {
      setAllJobs(prev => ({
        ...prev,
        [jobId]: {
          ...prev[jobId],
          status: "pending",
          assignedTechId: "",
          updatedAt: now,
        },
      }));
    }

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id), {
        stopSequence: newSeq,
        ...routeMetricUpdateFields(metrics),
        generatedBy: "human",
        updatedAt: now,
      });
      batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, jobId), {
        status: "pending",
        assignedTechId: "",
        updatedAt: now,
      });
      await batch.commit();

      pushEdit({
        type: "removeStop",
        timestamp: Date.now(),
        description: "Removed stop from route",
        before: [{ routeId: tr.route.id, stopSequence: oldSeq, date: tr.route.date }],
        after: [{ routeId: tr.route.id, stopSequence: newSeq, date: tr.route.date }],
      });
      fetch("/api/record-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId: tr.route.id,
          originalRoute: tr.route,
          modifiedRoute: { ...tr.route, stopSequence: newSeq },
          modifiedBy: userProfile.email,
        }),
      }).catch(() => {});

      toast.success(`Removed ${job?.customerName || "stop"} - returned to pending`);
    } catch (e) {
      console.error("Remove stop error:", e);
      setAllRoutes(previousRoutes);
      if (previousJob) setAllJobs(prev => ({ ...prev, [jobId]: previousJob }));
      toast.error("Failed to remove stop");
    }
  }, [allJobs, allRoutes, calculateRouteMetrics, pushEdit, userProfile?.companyId, userProfile?.email]);

  const handlePanelDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!editMode || clickReorderRouteId || !over || active.id === over.id || !userProfile?.companyId) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const sourceRoute = allRoutes.find(r => (r.route.stopSequence || []).includes(activeId));
    if (!sourceRoute) return;

    const droppedRouteId = parseRouteDropId(overId);
    const targetRoute = droppedRouteId
      ? allRoutes.find(r => r.route.id === droppedRouteId)
      : allRoutes.find(r => (r.route.stopSequence || []).includes(overId));
    if (!targetRoute) return;

    if (sourceRoute.route.id !== targetRoute.route.id) {
      await handleMoveStop(
        activeId,
        sourceRoute.route.id,
        targetRoute.route.id,
        droppedRouteId ? undefined : overId,
      );
      return;
    }

    const oldSeq = sourceRoute.route.stopSequence;
    const oldIdx = oldSeq.indexOf(activeId);
    const newIdx = oldSeq.indexOf(overId);
    if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;

    const newSeq = arrayMove(oldSeq, oldIdx, newIdx);
    const metrics = await calculateRouteMetrics(newSeq, sourceRoute.route.date);
    const previousRoutes = allRoutes;

    setAllRoutes(allRoutes.map(r =>
      r.route.id === sourceRoute.route.id
        ? {
            ...r,
            route: applyMetricsToRoute({
              ...r.route,
              stopSequence: newSeq,
              generatedBy: "human" as const,
            }, metrics),
          }
        : r,
    ));

    try {
      await updateDoc(doc(db, `companies/${userProfile.companyId}/routes`, sourceRoute.route.id), {
        stopSequence: newSeq,
        ...routeMetricUpdateFields(metrics),
        generatedBy: "human",
        updatedAt: new Date().toISOString(),
      });
      pushEdit({
        type: "reorder",
        timestamp: Date.now(),
        description: "Reordered route stops",
        before: [{ routeId: sourceRoute.route.id, stopSequence: oldSeq, date: sourceRoute.route.date }],
        after: [{ routeId: sourceRoute.route.id, stopSequence: newSeq, date: sourceRoute.route.date }],
      });
      fetch("/api/record-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId: sourceRoute.route.id,
          originalRoute: sourceRoute.route,
          modifiedRoute: { ...sourceRoute.route, stopSequence: newSeq },
          modifiedBy: userProfile.email,
        }),
      }).catch(() => {});
    } catch (e) {
      console.error("Reorder route error:", e);
      setAllRoutes(previousRoutes);
      toast.error("Failed to reorder route");
    }
  }, [allRoutes, calculateRouteMetrics, clickReorderRouteId, editMode, handleMoveStop, pushEdit, userProfile?.companyId, userProfile?.email]);

  const startClickReorder = useCallback((routeId: string) => {
    setClickReorderRouteId(routeId);
    setClickReorderSequence([]);
    toast.info("Click stops or map dots in the order this route should run.");
  }, []);

  const cancelClickReorder = useCallback(() => {
    setClickReorderRouteId(null);
    setClickReorderSequence([]);
  }, []);

  const applyClickReorder = useCallback(async (
    routeId: string,
    pickedSequence = clickReorderSequence,
  ) => {
    if (!userProfile?.companyId) return;
    const tr = allRoutes.find((route) => route.route.id === routeId);
    if (!tr) return;

    const oldSeq = tr.route.stopSequence || [];
    const picked = pickedSequence.filter(
      (jobId, index) =>
        oldSeq.includes(jobId) && pickedSequence.indexOf(jobId) === index,
    );
    if (picked.length === 0) {
      toast.info("Click at least one stop to set the route order.");
      return;
    }

    const pickedSet = new Set(picked);
    const newSeq = [...picked, ...oldSeq.filter((jobId) => !pickedSet.has(jobId))];
    if (newSeq.join("|") === oldSeq.join("|")) {
      cancelClickReorder();
      toast.info("Route order unchanged.");
      return;
    }

    const metrics = await calculateRouteMetrics(newSeq, tr.route.date);
    const previousRoutes = allRoutes;
    setAllRoutes(allRoutes.map((route) =>
      route.route.id === routeId
        ? {
            ...route,
            route: applyMetricsToRoute({
              ...route.route,
              stopSequence: newSeq,
              generatedBy: "human" as const,
            }, metrics),
          }
        : route,
    ));

    try {
      await updateDoc(doc(db, `companies/${userProfile.companyId}/routes`, routeId), {
        stopSequence: newSeq,
        ...routeMetricUpdateFields(metrics),
        generatedBy: "human",
        updatedAt: new Date().toISOString(),
      });
      pushEdit({
        type: "reorder",
        timestamp: Date.now(),
        description: "Click-reordered route stops",
        before: [{ routeId, stopSequence: oldSeq, date: tr.route.date }],
        after: [{ routeId, stopSequence: newSeq, date: tr.route.date }],
      });
      fetch("/api/record-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId,
          originalRoute: tr.route,
          modifiedRoute: { ...tr.route, stopSequence: newSeq },
          modifiedBy: userProfile.email,
        }),
      }).catch(() => {});
      cancelClickReorder();
      toast.success("Route reordered");
    } catch (e) {
      console.error("Click reorder error:", e);
      setAllRoutes(previousRoutes);
      toast.error("Failed to reorder route");
    }
  }, [allRoutes, calculateRouteMetrics, cancelClickReorder, clickReorderSequence, pushEdit, userProfile?.companyId, userProfile?.email]);

  const handleClickOrderPick = useCallback((routeId: string, jobId: string) => {
    if (clickReorderRouteId !== routeId) return;
    const tr = allRoutes.find((route) => route.route.id === routeId);
    if (!tr || !(tr.route.stopSequence || []).includes(jobId)) return;

    const alreadyPicked = clickReorderSequence.includes(jobId);
    const next = alreadyPicked
      ? clickReorderSequence.filter((id) => id !== jobId)
      : [...clickReorderSequence, jobId];
    setClickReorderSequence(next);

    if (!alreadyPicked && next.length === tr.route.stopSequence.length) {
      void applyClickReorder(routeId, next);
    }
  }, [allRoutes, applyClickReorder, clickReorderRouteId, clickReorderSequence]);

  useEffect(() => {
    if (!editMode || !clickReorderRouteId) {
      if (!editMode) cancelClickReorder();
      return;
    }
    if (!allRoutes.some((route) => route.route.id === clickReorderRouteId)) {
      cancelClickReorder();
    }
  }, [allRoutes, cancelClickReorder, clickReorderRouteId, editMode]);

  // Undo/redo keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey && canUndo) {
        e.preventDefault();
        handleUndo();
      }
      if (((e.key === "z" && e.shiftKey) || e.key === "y") && canRedo) {
        e.preventDefault();
        handleRedo();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });

  const handleUndo = async () => {
    const op = undo();
    if (!op || !userProfile?.companyId) return;
    // Revert all routes in this operation to their "before" state
    for (const snap of op.before) {
      const metrics = await calculateRouteMetrics(snap.stopSequence, snap.date);
      try {
        await updateDoc(doc(db, `companies/${userProfile.companyId}/routes`, snap.routeId), {
          stopSequence: snap.stopSequence,
          ...routeMetricUpdateFields(metrics),
          ...(snap.date ? { date: snap.date } : {}),
          updatedAt: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }
    toast.info(`Undone: ${op.description}`);
  };

  const handleRedo = async () => {
    const op = redo();
    if (!op || !userProfile?.companyId) return;
    for (const snap of op.after) {
      const metrics = await calculateRouteMetrics(snap.stopSequence, snap.date);
      try {
        await updateDoc(doc(db, `companies/${userProfile.companyId}/routes`, snap.routeId), {
          stopSequence: snap.stopSequence,
          ...routeMetricUpdateFields(metrics),
          ...(snap.date ? { date: snap.date } : {}),
          updatedAt: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }
    toast.info(`Redone: ${op.description}`);
  };

  const loadJobsForRange = useCallback(async (companyId: string) => {
    try {
      const jobsCollection = collection(db, `companies/${companyId}/jobs`);
      const [dueSnap, fieldRoutesScheduledSnap] = await Promise.all([
        getDocs(query(
          jobsCollection,
          where("scheduledDate", ">=", startDate),
          where("scheduledDate", "<=", endDate),
        )),
        getDocs(query(
          jobsCollection,
          where("fieldRoutesScheduledDate", ">=", startDate),
          where("fieldRoutesScheduledDate", "<=", endDate),
        )),
      ]);
      const jobMap: { [id: string]: Job } = {};
      [...dueSnap.docs, ...fieldRoutesScheduledSnap.docs].forEach(d => { jobMap[d.id] = { id: d.id, ...d.data() } as Job; });
      setAllJobs(jobMap);
    } catch {
      setAllJobs({});
    }
  }, [endDate, startDate]);

  const loadRouteStopJobs = useCallback(async (companyId: string, stopIds: string[]) => {
    const uniqueStopIds = [...new Set(stopIds.filter(Boolean))];
    if (uniqueStopIds.length === 0) return;

    try {
      const loaded: { [id: string]: Job } = {};
      for (let i = 0; i < uniqueStopIds.length; i += 30) {
        const chunk = uniqueStopIds.slice(i, i + 30);
        const snap = await getDocs(query(
          collection(db, `companies/${companyId}/jobs`),
          where(documentId(), "in", chunk),
        ));
        snap.docs.forEach(d => { loaded[d.id] = { id: d.id, ...d.data() } as Job; });
      }
      if (Object.keys(loaded).length > 0) {
        setAllJobs(prev => ({ ...prev, ...loaded }));
      }
    } catch (error) {
      console.error("Load route stop jobs error:", error);
    }
  }, []);

  const loadJobPoolJobs = useCallback(async (companyId: string, dueStart: string, dueEnd: string) => {
    if (!dueStart || !dueEnd) return;
    try {
      const snap = await getDocs(query(
        collection(db, `companies/${companyId}/jobs`),
        where("scheduledDate", ">=", dueStart),
        where("scheduledDate", "<=", dueEnd),
      ));
      const jobMap: { [id: string]: Job } = {};
      snap.docs.forEach(d => { jobMap[d.id] = { id: d.id, ...d.data() } as Job; });
      setAllJobs(prev => ({ ...prev, ...jobMap }));
    } catch (error) {
      console.error("Load job pool jobs error:", error);
    }
  }, []);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadTechs(userProfile.companyId);
  }, [userProfile]);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    let cancelled = false;
    getDoc(doc(db, "companies", userProfile.companyId))
      .then((snap) => {
        if (cancelled || !snap.exists()) return;
        setAllowCrossTechRouteEdits(snap.data().allowCrossTechRouteEdits !== false);
      })
      .catch(() => {
        if (!cancelled) setAllowCrossTechRouteEdits(true);
      });
    return () => { cancelled = true; };
  }, [userProfile?.companyId]);

  useEffect(() => {
    if (!userProfile?.companyId || !startDate || !endDate) return;
    loadJobsForRange(userProfile.companyId);

    // Real-time listener for routes
    const routesQuery = query(
      collection(db, `companies/${userProfile.companyId}/routes`),
      where("date", ">=", startDate),
      where("date", "<=", endDate)
    );

    const unsubscribe = onSnapshot(routesQuery, async (snap) => {
      if (snap.empty) { setAllRoutes([]); return; }

      const techSnap = await getDocs(collection(db, `companies/${userProfile.companyId}/technicians`));
      const techMap: { [id: string]: Technician } = {};
      techSnap.docs.forEach(d => { techMap[d.id] = { id: d.id, ...d.data() } as Technician; });

      let colorIdx = 0;
      const routes = snap.docs.map((d) => {
        const routeData = d.data();
        const route = { id: d.id, ...routeData, stopSequence: Array.isArray(routeData.stopSequence) ? routeData.stopSequence : [] } as Route;
        const tech = techMap[route.techId] || {
          id: route.techId, name: routeData.techName || route.techId,
          employeeId: "", active: true, maxStopsPerDay: 20, companyId: userProfile.companyId!,
        };
        const color = TECH_COLORS[colorIdx % TECH_COLORS.length];
        colorIdx++;
        return { route, tech, jobs: [], color, expanded: true };
      });
      setAllRoutes(routes);
      const routeStopIds = routes.flatMap((tr) => tr.route.stopSequence || []);
      loadRouteStopJobs(userProfile.companyId!, routeStopIds);

      // Keep selected date pills aligned with the currently loaded range.
      const dates = [...new Set(routes.map((r) => r.route.date))].sort();
      setSelectedDates(prev => {
        const stillVisible = prev.filter((date) => dates.includes(date));
        return stillVisible.length > 0 ? stillVisible : dates;
      });
    }, () => {
      setAllRoutes([]);
      setSelectedDates([]);
    });

    return () => unsubscribe();
  }, [endDate, loadJobsForRange, loadRouteStopJobs, startDate, userProfile]);

  // Self-heal missing stop coordinates. A routed / FieldRoutes-scheduled stop that
  // has an address but no lat/lng breaks the road-path drawing ("…route has stops
  // missing coordinates…"). Whenever such stops appear, automatically geocode them
  // via /api/geocode-jobs and reload, so the path fixes itself. Each job is tried
  // at most once per session (attempted-set) and runs are serialized (in-flight
  // ref) so an unresolvable address can never loop.
  useEffect(() => {
    const companyId = userProfile?.companyId;
    if (!companyId || autoGeocodeInFlightRef.current) return;

    const needIds = new Set<string>();
    const consider = (job?: Job) => {
      if (!job) return;
      const hasCoord = typeof job.lat === "number" && typeof job.lng === "number";
      const address = String(job.address || (job as { addressRaw?: string }).addressRaw || "").trim();
      if (!hasCoord && address && !autoGeocodeAttemptedRef.current.has(job.id)) needIds.add(job.id);
    };
    displayRoutes.forEach((tr) => (tr.route.stopSequence || []).forEach((id) => consider(allJobs[id])));
    hiddenScheduledStops.forEach(({ job }) => consider(job));
    if (needIds.size === 0) return;

    const ids = Array.from(needIds);
    ids.forEach((id) => autoGeocodeAttemptedRef.current.add(id));
    autoGeocodeInFlightRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/geocode-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, jobIds: ids }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success && result.geocoded > 0) {
          toast.success(`Recovered coordinates for ${result.geocoded} stop${result.geocoded === 1 ? "" : "s"}`);
          await loadJobsForRange(companyId);
        }
      } catch {
        // Leave the ids attempted-marked so we don't loop; the manual
        // "geocode hidden stops" button remains as a fallback.
      } finally {
        autoGeocodeInFlightRef.current = false;
      }
    })();
  }, [userProfile, displayRoutes, hiddenScheduledStops, allJobs, loadJobsForRange]);

  useEffect(() => {
    if (!userProfile?.companyId || !showJobPoolLayer) return;
    loadJobPoolJobs(
      userProfile.companyId,
      jobPoolDueStart || startDate,
      jobPoolDueEnd || endDate,
    );
  }, [endDate, jobPoolDueEnd, jobPoolDueStart, loadJobPoolJobs, showJobPoolLayer, startDate, userProfile?.companyId]);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || key === "your-google-maps-api-key") {
      setMapError(true);
      return;
    }
    if (window.google?.maps) { setMapLoaded(true); return; }

    // Use the recommended async loading to avoid console warnings and key exposure
    const callback = `__gmapsInit_${Date.now()}`;
    (window as Record<string, unknown>)[callback] = () => {
      setMapLoaded(true);
      delete (window as Record<string, unknown>)[callback];
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry&loading=async&callback=${callback}`;
    script.async = true;
    script.onerror = () => setMapError(true);
    document.head.appendChild(script);
  }, []);

  // NW Arkansas anchor — always start here
  // Create map instance ONCE — anchored to NW Arkansas
  useEffect(() => {
    if (!mapLoaded || mapInstanceRef.current) return;
    const mapEl = document.getElementById("route-map");
    if (!mapEl || !window.google) return;

    mapInstanceRef.current = new window.google.maps.Map(mapEl, {
      center: NW_ARK,
      zoom: 11,
      mapTypeId: "roadmap",
      styles: [
        { elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
        { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
      ],
    });
    hasFittedBounds.current = false;
  }, [mapLoaded]);

  const markerOriginalColors = useRef<Map<string, string>>(new Map());

  // Direct DOM + Maps API hover — no React re-renders
  const setHoveredStop = useCallback((jobId: string | null) => {
    const prev = hoveredStopIdRef.current;
    if (prev === jobId) return;

    // Un-highlight previous sidebar stop
    if (prev) {
      const prevEl = document.querySelector(`[data-job-id="${prev}"]`);
      if (prevEl) prevEl.classList.remove("ring-2", "ring-blue-400/50", "bg-blue-500/10", "border-blue-500/30");

      // Restore previous map marker
      if (window.google) {
        const marker = mapMarkerByJobId.current.get(prev);
        const origColor = markerOriginalColors.current.get(prev) || "#3b82f6";
        if (marker) {
          marker.setIcon({
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: origColor, fillOpacity: 1,
            strokeColor: "white", strokeWeight: 2, scale: 14,
          });
          marker.setZIndex(0);
        }
      }
    }

    // Highlight new sidebar stop
    if (jobId) {
      const newEl = document.querySelector(`[data-job-id="${jobId}"]`);
      if (newEl) {
        newEl.classList.add("ring-2", "ring-blue-400/50", "bg-blue-500/10", "border-blue-500/30");
        newEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      // Highlight new map marker
      if (window.google) {
        const marker = mapMarkerByJobId.current.get(jobId);
        if (marker) {
          marker.setIcon({
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: "#facc15", fillOpacity: 1,
            strokeColor: "#facc15", strokeWeight: 3, scale: 20,
          });
          marker.setZIndex(9999);
        }
      }
    }

    hoveredStopIdRef.current = jobId;
  }, []);

  const findNearestRouteDropTarget = useCallback((
    droppedAt: { lat: number; lng: number },
    sourceRouteId: string,
    sourceJobId: string,
  ) => {
    const zoom = mapInstanceRef.current?.getZoom() ?? 11;
    const maxDropMiles = zoom >= 14 ? 0.35 : zoom >= 12 ? 0.75 : 1.5;
    let best: { routeId: string; jobId: string; techName: string; distance: number } | null = null;
    const sourceJob = allJobs[sourceJobId];

    for (const tr of visibleRoutes) {
      if (isFieldRoutesScheduledRoute(tr.route)) continue;
      if (tr.route.id === sourceRouteId) continue;
      if (!canAssignJobToRoute(sourceJob, tr)) continue;
      for (const targetJob of getJobsForRoute(tr)) {
        if (targetJob.id === sourceJobId || targetJob.lat === undefined || targetJob.lng === undefined) continue;
        const distance = distanceMiles(droppedAt, { lat: targetJob.lat, lng: targetJob.lng });
        if (!best || distance < best.distance) {
          best = {
            routeId: tr.route.id,
            jobId: targetJob.id,
            techName: tr.tech.name,
            distance,
          };
        }
      }
    }

    return best && best.distance <= maxDropMiles ? best : null;
  }, [allJobs, canAssignJobToRoute, getJobsForRoute, visibleRoutes]);

  // Update markers and polylines when routes/jobs change (without recreating the map)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !window.google) return;
    let cancelled = false;

    // Clear old overlays
    mapMarkersRef.current.forEach(m => m.setMap(null));
    mapPolylinesRef.current.forEach(p => p.setMap(null));
    openMapInfoWindowRef.current?.close();
    openMapInfoWindowRef.current = null;
    mapMarkersRef.current = [];
    mapPolylinesRef.current = [];
    mapMarkerByJobId.current.clear();

    const bounds = new window.google.maps.LatLngBounds();
    let hasCoords = false;

    visibleRoutes.forEach((tr) => {
      const color = tr.color;
      const routeReadOnly = isFieldRoutesScheduledRoute(tr.route);
      const path: google.maps.LatLng[] = [];
      const jobs = getJobsForRoute(tr);

      jobs.forEach((job, idx) => {
        if (!job.lat || !job.lng) return;
        const pos = new window.google.maps.LatLng(job.lat, job.lng);
        path.push(pos);
        bounds.extend(pos);
        hasCoords = true;
        const routeId = tr.route.id;
        const clickOrderRank =
          clickReorderRouteId === routeId
            ? clickReorderSequence.indexOf(job.id) + 1
            : 0;
        const clickOrderActive = clickReorderRouteId === routeId;
        const routeStats = getRouteDisplayMetrics(tr.route, allJobs);
        const stopProduction = calculateStopProductionValue(job);
        const lastServiced = getSubscriptionLastServiced(job);

        const marker = new window.google.maps.Marker({
          position: pos,
          map,
          draggable: editMode && !clickReorderRouteId,
          label: {
            text: String(clickOrderRank || idx + 1),
            color: "white",
            fontSize: "11px",
            fontWeight: "bold",
          },
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: clickOrderRank ? "#f59e0b" : color,
            fillOpacity: 1,
            strokeColor: clickOrderActive ? "#fbbf24" : "white",
            strokeWeight: clickOrderActive ? 3 : 2,
            scale: clickOrderActive ? 16 : 14,
          },
        });

        const infoContent = document.createElement("div");
        infoContent.style.cssText = "color:#111;padding:8px;max-width:270px";
        infoContent.innerHTML = `
          <div style="font-weight:700;margin-bottom:2px">${idx + 1}. ${escapeHtml(job.customerName)}</div>
          <div style="color:#666;font-size:12px;margin-bottom:6px">${escapeHtml(job.address)}</div>
          <div style="font-size:12px;margin-bottom:8px">
            ${job.serviceType ? `${escapeHtml(job.serviceType)} · ` : ""}${Number(job.duration || 25)} min at stop
          </div>
          <div style="border-top:1px solid #e5e7eb;padding-top:7px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">
            <div><div style="color:#777">Due</div><div style="font-weight:700">${escapeHtml(job.scheduledDate || "-")}</div></div>
            <div><div style="color:#777">Last serviced</div><div style="font-weight:700">${escapeHtml(lastServiced || "-")}</div></div>
            <div><div style="color:#777">Stop value</div><div style="font-weight:700">${formatCurrency(stopProduction.value)}</div></div>
            <div><div style="color:#777">Route value</div><div style="font-weight:700">${formatCurrency(routeStats.productionValue)}</div></div>
            <div><div style="color:#777">Route drive</div><div style="font-weight:700">${formatTime(routeStats.driveMinutes)}</div></div>
            <div><div style="color:#777">Full day</div><div style="font-weight:700">${formatTime(routeStats.workMinutes)}</div></div>
          </div>
          <div style="color:${color};font-weight:700;font-size:12px;margin-top:8px">${escapeHtml(tr.tech.name)} · ${escapeHtml(tr.route.date)}</div>
          ${routeReadOnly ? `<div style="color:#059669;font-weight:700;font-size:11px;margin-top:4px">Already scheduled in FieldRoutes</div>` : ""}
          <div style="color:#999;font-size:11px;margin-top:5px">L+click = left panel · R+click = right panel</div>
        `;
        if (editMode && !routeReadOnly) {
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.textContent = "Remove from route";
          removeButton.style.cssText = [
            "margin-top:10px",
            "width:100%",
            "border:1px solid #fecaca",
            "border-radius:6px",
            "background:#fef2f2",
            "color:#b91c1c",
            "font-size:12px",
            "font-weight:700",
            "padding:7px 8px",
            "cursor:pointer",
          ].join(";");
          removeButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openMapInfoWindowRef.current?.close();
            openMapInfoWindowRef.current = null;
            void handleRemoveStop(tr, job.id);
          });
          infoContent.appendChild(removeButton);
        }

        const infoWindow = new window.google.maps.InfoWindow({
          content: infoContent,
          disableAutoPan: true,
        });

        // Hover sync: map -> sidebar highlight only. Popups open on click.
        marker.addListener("mouseover", () => {
          setHoveredStop(job.id);
        });
        marker.addListener("mouseout", () => {
          setHoveredStop(null);
        });

        marker.addListener("dragstart", () => setHoveredStop(job.id));
        marker.addListener("dragend", async (event: google.maps.MapMouseEvent) => {
          marker.setPosition(pos);
          setHoveredStop(null);
          if (!editMode || !event.latLng) return;

          const target = findNearestRouteDropTarget(
            { lat: event.latLng.lat(), lng: event.latLng.lng() },
            routeId,
            job.id,
          );
          if (!target) {
            toast.info("Drop onto another route stop to move it.");
            return;
          }
          await handleMoveStop(job.id, routeId, target.routeId, target.jobId);
        });
        marker.addListener("click", () => {
          if (clickReorderRouteId) {
            if (clickReorderRouteId === routeId) {
              handleClickOrderPick(routeId, job.id);
              return;
            }
            toast.info("Click stops from the route currently in click-order mode.");
            return;
          }
          if (heldKeyRef.current === "l") {
            setLeftPanelRouteId(routeId);
            toast.info(`${tr.tech.name} → left panel`);
            return;
          }
          if (heldKeyRef.current === "r") {
            setRightPanelRouteId(routeId);
            toast.info(`${tr.tech.name} → right panel`);
            return;
          }
          openMapInfoWindowRef.current?.close();
          openMapInfoWindowRef.current = infoWindow;
          infoWindow.open({ map, anchor: marker, shouldFocus: false });
        });

        mapMarkersRef.current.push(marker);
        mapMarkerByJobId.current.set(job.id, marker);
        markerOriginalColors.current.set(job.id, color);
      });

      if (path.length > 1) {
        const polyline = new window.google.maps.Polyline({
          path: [],
          geodesic: false,
          strokeColor: color,
          strokeOpacity: 0.95,
          strokeWeight: 4,
          map,
        });
        const routeInfoWindow = new window.google.maps.InfoWindow({
          content: routeStatsHtml(tr, allJobs),
          disableAutoPan: true,
        });
        polyline.addListener("click", (event: google.maps.MapMouseEvent) => {
          if (heldKeyRef.current === "r") {
            setRightPanelRouteId(tr.route.id);
          } else {
            setLeftPanelRouteId(tr.route.id);
          }
          routeInfoWindow.setPosition(event.latLng || path[Math.floor(path.length / 2)]);
          openMapInfoWindowRef.current?.close();
          openMapInfoWindowRef.current = routeInfoWindow;
          routeInfoWindow.open({ map, shouldFocus: false });
        });
        mapPolylinesRef.current.push(polyline);

        const storedRoadPath = Array.isArray(tr.route.routePolyline)
          ? tr.route.routePolyline.filter(
              (point) =>
                typeof point.lat === "number" &&
                Number.isFinite(point.lat) &&
                typeof point.lng === "number" &&
                Number.isFinite(point.lng),
            )
          : [];

        if (tr.route.polylineSource === "routes_api_polyline" && storedRoadPath.length > 1) {
          polyline.setPath(storedRoadPath);
        } else {
          const roadJobs = getOrderedJobsWithCoordinates(tr.route.stopSequence, allJobs);
          if (roadJobs) {
            void getRoadRouteForJobs(roadJobs, tr.route.date).then((roadRoute) => {
              if (cancelled) return;
              if (
                roadRoute.path.length === 0 ||
                roadRoute.failedLegs > 0 ||
                roadRoute.polylineSource !== "routes_api_polyline"
              ) {
                polyline.setMap(null);
                warnRoadSnapFailure(
                  tr.route.id,
                  `Could not snap ${tr.tech.name}'s ${tr.route.date} route to roads (${roadRoute.status}). ${describeDirectionsStatus(roadRoute.status)}`,
                );
                return;
              }
              polyline.setPath(roadRoute.path);
            });
          } else {
            polyline.setMap(null);
            warnRoadSnapFailure(
              tr.route.id,
              `${tr.tech.name}'s ${tr.route.date} route has stops missing coordinates, so the road path could not be drawn.`,
            );
          }
        }
      }
    });

    if (showJobPoolLayer) {
      const hasEditableRoute = visibleRoutes.some((tr) => !isFieldRoutesScheduledRoute(tr.route));
      jobPoolJobs.forEach((job) => {
        if (typeof job.lat !== "number" || typeof job.lng !== "number") return;
        const pos = new window.google.maps.LatLng(job.lat, job.lng);
        bounds.extend(pos);
        hasCoords = true;

        const marker = new window.google.maps.Marker({
          position: pos,
          map,
          draggable: hasEditableRoute && !clickReorderRouteId,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: "#22d3ee",
            fillOpacity: 0.95,
            strokeColor: "#e0f2fe",
            strokeWeight: 2,
            scale: 9,
          },
          zIndex: 5,
        });
        const infoWindow = new window.google.maps.InfoWindow({
          content: poolJobHtml(job),
          disableAutoPan: true,
        });

        marker.addListener("click", () => {
          openMapInfoWindowRef.current?.close();
          openMapInfoWindowRef.current = infoWindow;
          infoWindow.open({ map, anchor: marker, shouldFocus: false });
        });
        marker.addListener("dragend", async (event: google.maps.MapMouseEvent) => {
          marker.setPosition(pos);
          if (!event.latLng) return;
          const target = findNearestRouteDropTarget(
            { lat: event.latLng.lat(), lng: event.latLng.lng() },
            "",
            job.id,
          );
          if (!target) {
            toast.info("Drop the pool job onto a route stop to add it.");
            return;
          }
          await handleAddPoolJobToRoute(job.id, target.routeId, target.jobId);
        });

        mapMarkersRef.current.push(marker);
      });
    }

    // Only fit bounds on FIRST data load — don't jump around after that
    if (hasCoords && !hasFittedBounds.current) {
      map.fitBounds(bounds, 50);
      hasFittedBounds.current = true;
    }
    return () => {
      cancelled = true;
    };
  }, [allJobs, clickReorderRouteId, clickReorderSequence, editMode, findNearestRouteDropTarget, getJobsForRoute, handleAddPoolJobToRoute, handleClickOrderPick, handleMoveStop, handleRemoveStop, jobPoolJobs, setHoveredStop, showJobPoolLayer, visibleRoutes, warnRoadSnapFailure]);

  async function loadTechs(companyId: string) {
    try {
      const snap = await getDocs(query(collection(db, `companies/${companyId}/technicians`), where("active", "==", true)));
      const techList = snap.docs.map(d => ({ id: d.id, ...d.data() } as Technician));
      setTechs(techList);
      setSelectedTechIds(techList.map(t => t.id));
    } catch {
      setTechs([]);
      setSelectedTechIds([]);
    }
  }

  // Routes are now loaded via onSnapshot listener in the useEffect above

  const generateRoutes = async () => {
    if (!userProfile?.companyId) return;
    setGenerating(true);
    setGenResult(null);
    setGenError(null);

    setGenStage("Fetching jobs and technicians...");

    // Progress stages on a timer to show activity
    const stages = [
      { delay: 2000, msg: "Validating job coordinates..." },
      { delay: 4000, msg: "Geocoding missing addresses..." },
      { delay: 7000, msg: "Snapping coordinates to roads..." },
      { delay: 10000, msg: "Clustering jobs into routes..." },
      { delay: 14000, msg: "Optimizing stop order (2-opt + or-opt)..." },
      { delay: 20000, msg: "Enriching with traffic-aware drive times..." },
      { delay: 30000, msg: "Saving routes to database..." },
      { delay: 45000, msg: "Still working — large job sets take longer..." },
      { delay: 60000, msg: "Almost there..." },
    ];
    const timers = stages.map(s => setTimeout(() => setGenStage(s.msg), s.delay));

    try {
      const res = await fetch("/api/generate-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          startDate,
          endDate,
          techIds: selectedTechIds,
          maxStops,
          maxDriveTime,
          requestedBy: userProfile.email,
        }),
      });
      timers.forEach(clearTimeout);
      const rawText = await res.text();
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(rawText); } catch { data = { _raw: rawText.slice(0, 500) }; }
      console.log(`[generate-routes] status=${res.status}`, data);
      if (!res.ok && data.debugStack) console.error(`[generate-routes] server stack:\n${data.debugStack}`);
      if (data.success) {
        setGenStage(`Done! ${data.routeCount} routes with ${data.stopCount} stops`);
        toast.success(`Generated ${data.routeCount} routes with ${data.stopCount} stops`);
        setGenResult(null);
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];
        warnings.forEach((w) => toast.warning(String(w), { duration: 8000 }));
        await loadJobsForRange(userProfile.companyId);
      } else {
        const errorText = String(data.error || "Route generation failed");
        setGenError(`[${res.status}] ${errorText}`);
        toast.error(errorText);
        setGenResult(null);
      }
    } catch (e) {
      timers.forEach(clearTimeout);
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Generate routes error:", msg);
      setGenError(`Network error: ${msg}`);
      toast.error("Failed to generate routes. Check connection.");
    } finally {
      setTimeout(() => { setGenerating(false); setGenStage(""); }, 1500);
    }
  };



  const formatApproveError = (data: { error?: string; details?: unknown }) => {
    const base = data.error || "Failed to approve route";
    const details = data.details as { errors?: Array<{ customerName?: string; reason?: string }> } | undefined;
    const stopErrors = Array.isArray(details?.errors) ? details.errors : [];
    if (stopErrors.length === 0) return base;
    const preview = stopErrors
      .slice(0, 3)
      .map((err) => `${err.customerName || "Stop"}: ${err.reason || "upload blocked"}`)
      .join("; ");
    return `${base}: ${preview}${stopErrors.length > 3 ? `; +${stopErrors.length - 3} more` : ""}`;
  };

  const approveRouteInFieldRoutes = async (tr: TechRoute) => {
    if (!userProfile?.companyId) throw new Error("Missing company profile");
    const res = await fetch("/api/approve-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: userProfile.companyId,
        routeId: tr.route.id,
        approvedBy: userProfile.email,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(formatApproveError(data));
    }
    return data as ApproveRouteUploadResult;
  };

  const deleteRouteFromFieldRoutes = async (tr: TechRoute) => {
    if (!userProfile?.companyId) throw new Error("Missing company profile");
    const loggedRouteId = tr.route.fieldRoutesSync?.routeId;
    if (!loggedRouteId) throw new Error("This route has no logged FieldRoutes route ID.");

    const res = await fetch("/api/delete-fieldroutes-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: userProfile.companyId,
        routeId: tr.route.id,
        requestedBy: userProfile.email,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const fieldRoutesDate = data.fieldRoutesRouteDate || data.fieldRoutesDateInputUsed;
      const frDetails = data.fieldRoutesRouteId
        ? ` FR route #${data.fieldRoutesRouteId}${fieldRoutesDate ? ` on ${fieldRoutesDate}` : ""}${data.fieldRoutesRouteTime ? ` ${data.fieldRoutesRouteTime}` : ""}${data.fieldRoutesAssignedTech ? `, employee ${data.fieldRoutesAssignedTech}` : ""}.`
        : "";
      throw new Error(`${data.error || "Failed to delete FieldRoutes route"}${frDetails}`);
    }
    return data as { fieldRoutesRouteId: string; deletedAt: string };
  };

  const handleDeleteFieldRoutesRoute = async (tr: TechRoute) => {
    if (!userProfile?.companyId) return;
    setApproving(tr.route.id);
    try {
      const result = await deleteRouteFromFieldRoutes(tr);
      setAllRoutes(prev => prev.map(item =>
        item.route.id === tr.route.id
          ? {
              ...item,
              route: {
                ...item.route,
                approved: false,
                approvedAt: undefined,
                approvedBy: undefined,
                fieldRoutesSync: undefined,
                updatedAt: result.deletedAt,
              } as RouteWithMetrics,
            }
          : item
      ));
      await loadJobsForRange(userProfile.companyId);
      toast.success(`Deleted FieldRoutes route ${result.fieldRoutesRouteId} and unscheduled this RouteIQ route`);
    } catch (error) {
      console.error("Delete FieldRoutes route error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete FieldRoutes route");
    } finally {
      setApproving(null);
    }
  };

  const handleGeocodeHiddenStops = async () => {
    if (!userProfile?.companyId || hiddenScheduledStops.length === 0) return;
    setGeocodingStops(true);
    try {
      const res = await fetch("/api/geocode-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          jobIds: hiddenScheduledStops.map((s) => s.job.id),
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        throw new Error(result.error || "Failed to geocode stops");
      }
      toast.success(result.message || "Coordinates updated");
      await loadJobsForRange(userProfile.companyId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to geocode stops");
    } finally {
      setGeocodingStops(false);
    }
  };

  const handleUnscheduleRouteIqRoute = async (tr: TechRoute) => {
    if (!userProfile?.companyId) return;
    setApproving(tr.route.id);
    try {
      const res = await fetch("/api/unschedule-routeiq-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId: tr.route.id,
          requestedBy: userProfile.email,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        throw new Error(result.error || "Failed to unschedule RouteIQ route");
      }
      setAllRoutes(prev => prev.map(item =>
        item.route.id === tr.route.id
          ? {
              ...item,
              route: {
                ...item.route,
                approved: false,
                approvedAt: undefined,
                approvedBy: undefined,
                fieldRoutesSync: undefined,
                updatedAt: result.unscheduledAt || new Date().toISOString(),
              } as RouteWithMetrics,
            }
          : item
      ));
      await loadJobsForRange(userProfile.companyId);
      toast.success(`Unscheduled ${result.stopCount || tr.route.stopSequence.length} stop(s) in RouteIQ. FieldRoutes was not changed.`);
    } catch (error) {
      console.error("Unschedule RouteIQ route error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to unschedule RouteIQ route");
    } finally {
      setApproving(null);
    }
  };

  const handleUndoFieldRoutesStops = async (tr: TechRoute) => {
    if (!userProfile?.companyId) return;
    setApproving(tr.route.id);
    try {
      const res = await fetch("/api/undo-fieldroutes-stops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          routeId: tr.route.id,
          requestedBy: userProfile.email,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        const preview = Array.isArray(result.errors) && result.errors.length > 0
          ? ` ${result.errors[0].customerName || result.errors[0].appointmentId}: ${result.errors[0].reason}`
          : "";
        throw new Error(`${result.error || "Failed to undo FieldRoutes stops"}${preview}`);
      }
      setAllRoutes(prev => prev.map(item =>
        item.route.id === tr.route.id
          ? {
              ...item,
              route: {
                ...item.route,
                approved: false,
                approvedAt: undefined,
                approvedBy: undefined,
                fieldRoutesSync: undefined,
                updatedAt: result.undoneAt || new Date().toISOString(),
              } as RouteWithMetrics,
            }
          : item
      ));
      await loadJobsForRange(userProfile.companyId);
      toast.success(`Undid ${result.undone?.length || 0} FieldRoutes appointment(s) and unscheduled the RouteIQ route`);
    } catch (error) {
      console.error("Undo FieldRoutes stops error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to undo FieldRoutes stops");
    } finally {
      setApproving(null);
    }
  };

  const handleApprove = async (techIndex: number, approved: boolean) => {
    if (!userProfile?.companyId) return;
    const visRoute = visibleRoutes[techIndex];
    const allIdx = allRoutes.findIndex((r) => r.route.id === visRoute.route.id);
    if (allIdx === -1) return;

    const tr = allRoutes[allIdx];
    setApproving(tr.route.id);

    try {
      const routeRef = doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id);

      if (!approved) {
        // Rejecting: delete the route and mark all its jobs back to pending
        const batch = writeBatch(db);
        for (const jobId of tr.route.stopSequence) {
          const jobRef = doc(db, `companies/${userProfile.companyId}/jobs`, jobId);
          const job = allJobs[jobId];
          batch.update(jobRef, {
            status: "pending",
            ...(shouldClearGeneratedAssignment(tr.route, job)
              ? { assignedTechId: "" }
              : {}),
            updatedAt: new Date().toISOString(),
          });
        }
        await batch.commit();
        await deleteDoc(routeRef);

        // Remove from local state
        setAllRoutes(allRoutes.filter((_, i) => i !== allIdx));
      } else {
        const approval = await approveRouteInFieldRoutes(tr);
        const now = new Date().toISOString();
        const approvedStopSequence = Array.isArray(approval.stopSequence) && approval.stopSequence.length > 0
          ? approval.stopSequence
          : tr.route.stopSequence;

        const updatedRoutes = [...allRoutes];
        updatedRoutes[allIdx] = {
          ...tr,
          route: {
            ...tr.route,
            stopSequence: approvedStopSequence,
            totalStops: approval.totalStops || approvedStopSequence.length,
            totalServiceMinutes: approval.totalServiceMinutes ?? tr.route.totalServiceMinutes,
            totalWorkMinutes: approval.totalWorkMinutes ?? tr.route.totalWorkMinutes,
            approved: true,
            updatedAt: now,
            fieldRoutesSync: approval.sync ? { uploadedAt: now, ...approval.sync } : undefined,
          } as RouteWithMetrics,
        };
        setAllRoutes(updatedRoutes);
        toast.success(`Approved and uploaded ${tr.tech.name}'s route to FieldRoutes`);
      }
    } catch (e) {
      console.error("Approve/reject error:", e);
      toast.error(e instanceof Error ? e.message : "Failed to approve route");
    } finally {
      setApproving(null);
    }
  };

  const handleBulkApprove = async () => {
    if (!userProfile?.companyId) return;
    const pending = visibleRoutes.filter(tr => !tr.route.approved);
    if (pending.length === 0) return;

    setApproving("bulk");
    try {
      const approvedIds = new Map<string, ApproveRouteUploadResult>();
      const errors: string[] = [];
      for (const tr of pending) {
        try {
          approvedIds.set(tr.route.id, await approveRouteInFieldRoutes(tr));
        } catch (error) {
          errors.push(`${tr.tech.name} ${tr.route.date}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const now = new Date().toISOString();
      const updatedRoutes = allRoutes.map(tr =>
        approvedIds.has(tr.route.id)
          ? (() => {
              const approval = approvedIds.get(tr.route.id);
              const approvedStopSequence =
                approval && Array.isArray(approval.stopSequence) && approval.stopSequence.length > 0
                  ? approval.stopSequence
                  : tr.route.stopSequence;
              return {
                ...tr,
                route: {
                  ...tr.route,
                  stopSequence: approvedStopSequence,
                  totalStops: approval?.totalStops || approvedStopSequence.length,
                  totalServiceMinutes: approval?.totalServiceMinutes ?? tr.route.totalServiceMinutes,
                  totalWorkMinutes: approval?.totalWorkMinutes ?? tr.route.totalWorkMinutes,
                  approved: true,
                  updatedAt: now,
                  fieldRoutesSync: approval?.sync
                    ? { uploadedAt: now, ...approval.sync }
                    : undefined,
                } as RouteWithMetrics,
              };
            })()
          : tr
      );
      setAllRoutes(updatedRoutes);
      if (approvedIds.size > 0) {
        toast.success(`Approved and uploaded ${approvedIds.size} route(s) to FieldRoutes`);
      }
      if (errors.length > 0) {
        toast.error(`Failed ${errors.length} route(s). ${errors[0]}`, { duration: 12000 });
      }
    } catch (e) {
      console.error("Bulk approve error:", e);
      toast.error("Failed to approve routes");
    } finally {
      setApproving(null);
    }
  };

  const handleBulkReject = async () => {
    if (!userProfile?.companyId) return;
    const pending = visibleRoutes.filter(tr => !tr.route.approved);
    if (pending.length === 0) return;

    setApproving("bulk");
    try {
      for (const tr of pending) {
        const routeRef = doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id);
        const batch = writeBatch(db);
        for (const jobId of tr.route.stopSequence) {
          const jobRef = doc(db, `companies/${userProfile.companyId}/jobs`, jobId);
          const job = allJobs[jobId];
          batch.update(jobRef, {
            status: "pending",
            ...(shouldClearGeneratedAssignment(tr.route, job)
              ? { assignedTechId: "" }
              : {}),
            updatedAt: new Date().toISOString(),
          });
        }
        await batch.commit();
        await deleteDoc(routeRef);
      }

      const rejectedIds = new Set(pending.map(p => p.route.id));
      setAllRoutes(allRoutes.filter(tr => !rejectedIds.has(tr.route.id)));
      toast.success(`Rejected ${pending.length} route(s) — jobs returned to pending`);
    } catch (e) {
      console.error("Bulk reject error:", e);
      toast.error("Failed to reject routes");
    } finally {
      setApproving(null);
    }
  };

  const handlePrint = (tr: TechRoute) => {
    const jobs = getJobsForRoute(tr);
    const stats = getRouteDisplayMetrics(tr.route, allJobs);
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Route - ${tr.tech.name} - ${tr.route.date}</title>
      <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;padding:32px;max-width:800px;margin:0 auto}.header{border-bottom:2px solid #2563eb;padding-bottom:16px;margin-bottom:24px}.header h1{font-size:24px;font-weight:700;color:#2563eb}.meta{display:flex;gap:24px;margin-top:8px;color:#6b7280;font-size:14px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}.stat{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px}.stat .label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af}.stat .value{font-size:20px;font-weight:700;margin-top:2px}.stop{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #e5e7eb}.stop:last-child{border-bottom:none}.stop-num{width:28px;height:28px;border-radius:50%;background:#2563eb;color:white;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}.stop-details{flex:1}.stop-name{font-weight:600;font-size:14px}.stop-address{color:#6b7280;font-size:13px;margin-top:2px}.stop-meta{color:#9ca3af;font-size:12px;margin-top:4px}.footer{margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;text-align:center}</style></head><body>
      <div class="header"><h1>RouteIQ</h1><div class="meta"><span><strong>Technician:</strong> ${tr.tech.name}</span><span><strong>Date:</strong> ${tr.route.date}</span><span><strong>Status:</strong> ${tr.route.approved ? "Approved" : "Pending"}</span></div></div>
      <div class="stats"><div class="stat"><div class="label">Total Stops</div><div class="value">${stats.stops}</div></div><div class="stat"><div class="label">Drive Time</div><div class="value">${formatTime(stats.driveMinutes)}</div></div><div class="stat"><div class="label">Working Day</div><div class="value">${formatTime(stats.workMinutes)}</div></div><div class="stat"><div class="label">Route Value</div><div class="value">${formatCurrency(stats.productionValue)}</div></div></div>
      <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">Stop Sequence</h2>
      ${jobs.map((job, i) => {
        const stopProduction = calculateStopProductionValue(job);
        return `<div class="stop"><div class="stop-num">${i + 1}</div><div class="stop-details"><div class="stop-name">${job.customerName}</div><div class="stop-address">${job.address}</div><div class="stop-meta">${job.serviceType || ""} ${job.duration ? `· ${job.duration} min` : ""} · ${formatCurrency(stopProduction.value)} stop value</div></div></div>`;
      }).join("")}
      <div class="footer">Generated by RouteIQ · ${new Date().toLocaleDateString()}</div></body></html>`);
    w.document.close();
    w.print();
  };

  const handleShare = async (tr: TechRoute) => {
    if (!userProfile?.companyId) return;
    const jobs = getJobsForRoute(tr);
    const stats = getRouteDisplayMetrics(tr.route, allJobs);
    const token = crypto.randomUUID();
    const expires = new Date();
    expires.setDate(expires.getDate() + 7);

    try {
      await setDoc(doc(db, "sharedRoutes", token), {
        companyId: userProfile.companyId,
        routeId: tr.route.id,
        techName: tr.tech.name,
        date: tr.route.date,
        expiresAt: expires.toISOString(),
        totalStops: tr.route.totalStops,
        totalDriveTimeMinutes: tr.route.totalDriveTimeMinutes,
        totalWorkMinutes: stats.workMinutes,
        productionValue: stats.productionValue,
        confidence: tr.route.confidence,
        approved: tr.route.approved,
        stops: jobs.map(j => ({
          customerName: j.customerName,
          address: j.address,
          serviceType: j.serviceType,
          duration: j.duration,
          productionValue: calculateStopProductionValue(j).value,
          billingFrequency: j.billingFrequency,
          recurringFrequency: j.recurringFrequency,
          recurringPrice: j.recurringPrice,
        })),
      });

      const shareUrl = `${window.location.origin}/share/${token}`;
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied to clipboard! Valid for 7 days.");
    } catch (e) {
      console.error("Share error:", e);
      toast.error("Failed to create share link.");
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      <TopBar title="Route Builder" />
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Controls bar */}
        <div className="p-3 lg:p-4 border-b border-border/60 flex flex-wrap gap-2.5 items-center bg-background/95 backdrop-blur-sm no-print">
          <div className="flex items-center gap-2">
            <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" className="h-9" />
            <span className="text-muted-foreground text-sm">to</span>
            <DatePicker value={endDate} onChange={setEndDate} placeholder="End date" className="h-9" />
          </div>
          <div className="flex items-center gap-3 border-l border-border/60 pl-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Target stops
              <Input
                type="number"
                min={1}
                max={30}
                value={maxStops}
                onChange={(e) => setMaxStops(Math.max(1, parseInt(e.target.value) || 16))}
                className="h-9 w-16 text-sm"
                title="Tuesday routes automatically target 3 fewer stops."
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Max drive (min)
              <Input
                type="number"
                min={30}
                max={600}
                step={15}
                value={maxDriveTime}
                onChange={(e) => setMaxDriveTime(Math.max(30, parseInt(e.target.value) || 240))}
                className="h-9 w-20 text-sm"
              />
            </label>
          </div>
          <MultiSelectDropdown
            label="Technicians"
            icon={<Users className="w-4 h-4 opacity-70 shrink-0" />}
            options={techs.map(t => ({ id: t.id, label: t.name }))}
            selectedIds={selectedTechIds}
            onChange={setSelectedTechIds}
            allLabel={`All (${techs.length})`}
          />
          <Button
            variant={showUnassigned ? "default" : "outline"}
            onClick={() => setShowUnassigned(prev => !prev)}
            className={cn(
              "h-9 text-sm",
              showUnassigned ? "bg-slate-400 hover:bg-slate-500 text-slate-950" : "text-muted-foreground",
            )}
            title="Show FieldRoutes appointments that aren't assigned to a tech yet"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: showUnassigned ? "#0f172a" : UNASSIGNED_ROUTE_COLOR }}
            />
            Unassigned ({unassignedRouteCount})
          </Button>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant={showJobPoolLayer ? "default" : "outline"}
              onClick={() => setShowJobPoolLayer(prev => !prev)}
              className={cn(
                "h-9 text-sm",
                showJobPoolLayer
                  ? "bg-cyan-500 hover:bg-cyan-600 text-slate-950"
                  : "text-muted-foreground",
              )}
              title={`Show unrouted jobs due ${jobPoolDueStart || "any time"} through ${jobPoolDueEnd || "any date"}`}
            >
              <Layers className="w-4 h-4" />
              Job Pool ({jobPoolJobs.length})
            </Button>
            <Button
              variant={editMode ? "default" : "outline"}
              onClick={() => setEditMode(!editMode)}
              className={cn(
                "h-9 text-sm",
                editMode
                  ? "bg-orange-500 hover:bg-orange-600 text-white"
                  : "text-muted-foreground"
              )}
            >
              <Pencil className="w-4 h-4" />
              {editMode ? "Editing" : "Edit Routes"}
            </Button>
            <Button
              onClick={generateRoutes}
              disabled={generating || selectedTechIds.length === 0}
              className="bg-blue-500 hover:bg-blue-600 text-white h-9 text-sm"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              Generate Routes
            </Button>
          </div>
        </div>

        {showJobPoolLayer && (
          <div className="px-3 lg:px-4 py-2 border-b border-cyan-500/20 bg-cyan-500/5 flex flex-wrap items-center gap-2 no-print">
            <span className="text-xs font-medium text-cyan-300 whitespace-nowrap">Job Pool Due</span>
            <DatePicker
              value={jobPoolDueStart}
              onChange={(value) => {
                setJobPoolFilterTouched(true);
                setJobPoolDueStart(value);
                if (jobPoolDueEnd && value > jobPoolDueEnd) setJobPoolDueEnd(value);
              }}
              placeholder="Due from"
              className="h-8 w-[150px] text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <DatePicker
              value={jobPoolDueEnd}
              onChange={(value) => {
                setJobPoolFilterTouched(true);
                setJobPoolDueEnd(value);
                if (jobPoolDueStart && value < jobPoolDueStart) setJobPoolDueStart(value);
              }}
              placeholder="Due through"
              className="h-8 w-[150px] text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs text-cyan-200 hover:text-cyan-100 hover:bg-cyan-500/10"
              onClick={() => {
                setJobPoolFilterTouched(false);
                setJobPoolDueStart(startDate);
                setJobPoolDueEnd(endDate);
              }}
            >
              Reset
            </Button>
            <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
              {jobPoolJobs.length} jobs shown
            </span>
          </div>
        )}

        {genError && (
          <div className="px-4 py-3 border-b border-red-500/20 bg-red-500/8 flex items-center gap-3 no-print animate-scale-in">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-sm text-red-400 flex-1">{genError}</p>
            <button
              className="text-red-400/60 hover:text-red-400 transition-colors"
              onClick={() => setGenError(null)}
            >
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Generation result */}
        {genResult && (
          <div className={`mx-4 mt-2 text-sm px-3 py-2 rounded-lg border animate-scale-in ${genResult.startsWith("Error") || genResult.startsWith("Failed") ? "bg-red-500/8 border-red-500/15 text-red-400" : "bg-emerald-500/8 border-emerald-500/15 text-emerald-400"}`}>
            {genResult}
          </div>
        )}

        {/* Date filter pills + bulk actions */}
        {routeDates.length > 0 && (
          <div className="px-4 pt-3 pb-2 border-b border-border/50 space-y-2">
            <div className="flex items-center gap-2">
              <MultiSelectDropdown
                label="Dates"
                icon={<Calendar className="w-4 h-4 opacity-70 shrink-0" />}
                options={routeDates.map((d) => ({
                  id: d,
                  label: d,
                  hint: String(allRoutes.filter((r) => r.route.date === d).length),
                }))}
                selectedIds={selectedDates}
                onChange={setSelectedDates}
                allLabel={`All days (${routeDates.length})`}
              />
              <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap pl-4">
                {visibleRoutes.length} routes · {visibleRoutes.reduce((s, r) => s + r.route.totalStops, 0)} stops · {formatCurrency(visibleRoutes.reduce((total, r) => total + getRouteProductionValue(r.route.stopSequence, allJobs), 0))}
              </span>
            </div>

            {hiddenScheduledStops.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">
                    {hiddenScheduledStops.length} scheduled stop{hiddenScheduledStops.length === 1 ? "" : "s"} hidden from the map
                  </div>
                  <Button
                    size="sm"
                    className="h-6 text-[10px] px-2 bg-amber-500/20 text-amber-200 border border-amber-500/30 hover:bg-amber-500/30"
                    onClick={handleGeocodeHiddenStops}
                    disabled={geocodingStops}
                  >
                    {geocodingStops ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    Fix coordinates
                  </Button>
                </div>
                <ul className="mt-1 space-y-0.5 text-amber-200/80">
                  {hiddenScheduledStops.slice(0, 8).map(({ job, techName, date, reason }) => (
                    <li key={job.id}>
                      {job.customerName || job.address || job.id} — {techName}, {date}: {reason}
                    </li>
                  ))}
                  {hiddenScheduledStops.length > 8 && (
                    <li>…and {hiddenScheduledStops.length - 8} more</li>
                  )}
                </ul>
              </div>
            )}

            {/* Editing toolbar — undo/redo + bulk actions */}
            <div className="flex items-center gap-2">
              {/* Undo/Redo */}
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground/50" onClick={handleUndo} disabled={!canUndo} title="Undo (Cmd+Z)">
                <Undo2 className="w-3.5 h-3.5" /> Undo
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground/50" onClick={handleRedo} disabled={!canRedo} title="Redo (Cmd+Shift+Z)">
                <Redo2 className="w-3.5 h-3.5" /> Redo
              </Button>

              {pendingVisibleRoutes.length > 0 && (
                <>
                  <div className="w-px h-4 bg-border/50 mx-1" />
                  <span className="text-xs text-muted-foreground">
                    {pendingVisibleRoutes.length} pending:
                  </span>
                <Button
                  size="sm"
                  className="h-7 text-xs px-3 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20"
                  onClick={handleBulkApprove}
                  disabled={approving === "bulk"}
                >
                  {approving === "bulk" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                  Approve All ({pendingVisibleRoutes.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs px-3 text-red-400 border-red-500/20 hover:bg-red-500/10"
                  onClick={handleBulkReject}
                  disabled={approving === "bulk"}
                >
                  {approving === "bulk" ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                  Reject All ({pendingVisibleRoutes.length})
                </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Main content: left panel + map + right panel */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handlePanelDragEnd}>
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* LEFT PANEL — shows route assigned via click or L+click */}
          {leftPanelRouteId && (() => {
            const tr = visibleRoutes.find(r => r.route.id === leftPanelRouteId);
            if (!tr) return null;
            const routeReadOnly = isFieldRoutesScheduledRoute(tr.route);
            const panelJobs = getJobsForRoute(tr);
            return (
              <div className="w-72 shrink-0 border-r border-border/60 overflow-y-auto bg-background animate-fade-in">
                <div className="flex items-center justify-between p-2 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: tr.color }} />
                    <span className="text-xs font-semibold text-foreground truncate">{tr.tech.name}</span>
                    <span className="text-[10px] text-muted-foreground/50">{tr.route.date}</span>
                  </div>
                  <button onClick={() => setLeftPanelRouteId(null)} className="p-1 hover:bg-accent/50 rounded text-muted-foreground/40 hover:text-foreground transition-colors">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
                {editMode && (
                  <div className="px-2 py-1.5 bg-orange-500/10 border-b border-orange-500/20 text-orange-400 text-[10px] flex items-center gap-1.5">
                    <Pencil className="w-2.5 h-2.5" /> Edit mode active
                  </div>
                )}
                {routeReadOnly && (
                  <div className="px-2 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-[10px] flex items-center gap-1.5">
                    <Calendar className="w-2.5 h-2.5" /> Already scheduled in FieldRoutes
                  </div>
                )}
                <RoutePanelStats route={tr.route} jobsById={allJobs} />
                <DroppableStopList routeId={tr.route.id} enabled={editMode && !routeReadOnly}>
                  <SortableContext items={tr.route.stopSequence} strategy={verticalListSortingStrategy}>
                    {panelJobs.map((job, idx) => {
                      const clickOrderRank =
                        clickReorderRouteId === tr.route.id
                          ? clickReorderSequence.indexOf(job.id) + 1
                          : 0;
                      return (
                        <SortableStop
                          key={job.id} job={job} index={idx} color={tr.color}
                          dragDisabled={!editMode || routeReadOnly || clickReorderRouteId === tr.route.id}
                          clickOrderActive={clickReorderRouteId === tr.route.id}
                          clickOrderRank={clickOrderRank || undefined}
                          onClick={!routeReadOnly && clickReorderRouteId === tr.route.id ? () => handleClickOrderPick(tr.route.id, job.id) : undefined}
                          onHoverStart={() => setHoveredStop(job.id)}
                          onHoverEnd={() => setHoveredStop(null)}
                          onRemove={editMode && !routeReadOnly ? () => handleRemoveStop(tr, job.id) : undefined}
                          moveTargets={editMode && !routeReadOnly ? visibleRoutes.filter(o => o.route.id !== tr.route.id && !isFieldRoutesScheduledRoute(o.route) && canAssignJobToRoute(job, o)).map(o => ({ routeId: o.route.id, techName: o.tech.name, color: o.color, date: o.route.date })) : undefined}
                          onMoveTo={editMode && !routeReadOnly ? (tid) => handleMoveStop(job.id, tr.route.id, tid) : undefined}
                        />
                      );
                    })}
                  </SortableContext>
                  {panelJobs.length === 0 && <p className="text-xs text-muted-foreground/50 text-center py-4">{tr.route.stopSequence.length} stops</p>}
                </DroppableStopList>
                {/* Route actions */}
                <div className="p-2 border-t border-border/40 flex flex-wrap gap-1">
                  {editMode && !routeReadOnly && (
                    clickReorderRouteId === tr.route.id ? (
                      <>
                        <Button size="sm" className="h-6 text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20" onClick={() => applyClickReorder(tr.route.id)}><CheckCircle className="w-3 h-3" /> Apply ({clickReorderSequence.length}/{tr.route.stopSequence.length})</Button>
                        <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={cancelClickReorder}><XCircle className="w-3 h-3" /> Cancel</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="h-6 text-[10px] text-amber-300 border-amber-500/20 hover:bg-amber-500/10" onClick={() => startClickReorder(tr.route.id)}><MousePointerClick className="w-3 h-3" /> Click Order</Button>
                    )
                  )}
                  {!editMode && (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handlePrint(tr)}><Printer className="w-3 h-3" /> Print</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handleShare(tr)}><Share2 className="w-3 h-3" /> Share</Button>
                    </>
                  )}
                  {!tr.route.approved && (
                    <>
                      <Button size="sm" className="h-6 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, true); }} disabled={approving === tr.route.id}><CheckCircle className="w-3 h-3" /> Approve</Button>
                      <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, false); }} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Reject</Button>
                    </>
                  )}
                  {tr.route.approved && tr.route.fieldRoutesSync?.routeId && tr.route.fieldRoutesSync.routeStatus === "created" && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => handleDeleteFieldRoutesRoute(tr)} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Delete FR Route</Button>
                  )}
                  {tr.route.approved && (tr.route.fieldRoutesSync?.uploadedAppointments?.length || 0) > 0 && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => handleUndoFieldRoutesStops(tr)} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Undo FR Stops</Button>
                  )}
                  {tr.route.approved && !routeReadOnly && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] text-amber-300 border-amber-500/20 hover:bg-amber-500/10" onClick={() => handleUnscheduleRouteIqRoute(tr)} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Unschedule RouteIQ</Button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* If no panels open, show a hint */}
          {!leftPanelRouteId && !rightPanelRouteId && visibleRoutes.length > 0 && (
            <div className="w-48 shrink-0 border-r border-border/60 flex flex-col items-center justify-center text-center p-4 bg-background/50">
              <p className="text-xs text-muted-foreground/40 leading-relaxed">
                Click a route on the map to view it here.
              </p>
              <p className="text-[10px] text-muted-foreground/30 mt-2">
                Hold <kbd className="bg-accent/50 px-1 rounded border border-border/30">L</kbd> + click → left panel<br/>
                Hold <kbd className="bg-accent/50 px-1 rounded border border-border/30">R</kbd> + click → right panel
              </p>
            </div>
          )}
          {/* MAP — center, fill all remaining space */}
          <div className="flex-1 relative bg-accent/5 min-h-0 min-w-0">
            {/* Generation progress overlay */}
            {generating && (
              <div className="absolute inset-0 z-20 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center animate-fade-in">
                <div className="bg-card border border-border/60 rounded-xl shadow-2xl shadow-black/30 p-8 max-w-sm w-full mx-4 text-center">
                  <div className="w-12 h-12 mx-auto mb-4 relative">
                    <div className="absolute inset-0 border-2 border-blue-500/20 rounded-full" />
                    <div className="absolute inset-0 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <Wand2 className="w-5 h-5 text-blue-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                  </div>
                  <p className="text-sm font-semibold text-foreground mb-2">Generating Routes</p>
                  <p className="text-xs text-blue-400 animate-pulse min-h-[1.25rem]">{genStage}</p>
                  <div className="mt-4 flex items-center gap-1 justify-center">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: "300ms" }} />
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: "600ms" }} />
                  </div>
                </div>
              </div>
            )}

            {mapError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center mb-4">
                  <AlertTriangle className="w-5 h-5 text-yellow-400" />
                </div>
                <p className="font-medium text-sm">Google Maps not configured</p>
                <p className="text-sm text-muted-foreground/60 mt-1.5 max-w-xs">
                  Add <code className="bg-accent/50 px-1.5 py-0.5 rounded text-xs">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to .env.local
                </p>
              </div>
            ) : (
              <div id="route-map" className="absolute inset-0" />
            )}
          </div>

          {/* RIGHT PANEL — shows route assigned via R+click */}
          {rightPanelRouteId && (() => {
            const tr = visibleRoutes.find(r => r.route.id === rightPanelRouteId);
            if (!tr) return null;
            const routeReadOnly = isFieldRoutesScheduledRoute(tr.route);
            const panelJobs = getJobsForRoute(tr);
            return (
              <div className="w-72 shrink-0 border-l border-border/60 overflow-y-auto bg-background animate-fade-in">
                <div className="flex items-center justify-between p-2 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: tr.color }} />
                    <span className="text-xs font-semibold text-foreground truncate">{tr.tech.name}</span>
                    <span className="text-[10px] text-muted-foreground/50">{tr.route.date}</span>
                  </div>
                  <button onClick={() => setRightPanelRouteId(null)} className="p-1 hover:bg-accent/50 rounded text-muted-foreground/40 hover:text-foreground transition-colors">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
                {editMode && (
                  <div className="px-2 py-1.5 bg-orange-500/10 border-b border-orange-500/20 text-orange-400 text-[10px] flex items-center gap-1.5">
                    <Pencil className="w-2.5 h-2.5" /> Edit mode active
                  </div>
                )}
                {routeReadOnly && (
                  <div className="px-2 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-[10px] flex items-center gap-1.5">
                    <Calendar className="w-2.5 h-2.5" /> Already scheduled in FieldRoutes
                  </div>
                )}
                <RoutePanelStats route={tr.route} jobsById={allJobs} />
                <DroppableStopList routeId={tr.route.id} enabled={editMode && !routeReadOnly}>
                  <SortableContext items={tr.route.stopSequence} strategy={verticalListSortingStrategy}>
                    {panelJobs.map((job, idx) => {
                      const clickOrderRank =
                        clickReorderRouteId === tr.route.id
                          ? clickReorderSequence.indexOf(job.id) + 1
                          : 0;
                      return (
                        <SortableStop
                          key={job.id} job={job} index={idx} color={tr.color}
                          dragDisabled={!editMode || routeReadOnly || clickReorderRouteId === tr.route.id}
                          clickOrderActive={clickReorderRouteId === tr.route.id}
                          clickOrderRank={clickOrderRank || undefined}
                          onClick={!routeReadOnly && clickReorderRouteId === tr.route.id ? () => handleClickOrderPick(tr.route.id, job.id) : undefined}
                          onHoverStart={() => setHoveredStop(job.id)}
                          onHoverEnd={() => setHoveredStop(null)}
                          onRemove={editMode && !routeReadOnly ? () => handleRemoveStop(tr, job.id) : undefined}
                          moveTargets={editMode && !routeReadOnly ? visibleRoutes.filter(o => o.route.id !== tr.route.id && !isFieldRoutesScheduledRoute(o.route) && canAssignJobToRoute(job, o)).map(o => ({ routeId: o.route.id, techName: o.tech.name, color: o.color, date: o.route.date })) : undefined}
                          onMoveTo={editMode && !routeReadOnly ? (tid) => handleMoveStop(job.id, tr.route.id, tid) : undefined}
                        />
                      );
                    })}
                  </SortableContext>
                  {panelJobs.length === 0 && <p className="text-xs text-muted-foreground/50 text-center py-4">{tr.route.stopSequence.length} stops</p>}
                </DroppableStopList>
                <div className="p-2 border-t border-border/40 flex flex-wrap gap-1">
                  {editMode && !routeReadOnly && (
                    clickReorderRouteId === tr.route.id ? (
                      <>
                        <Button size="sm" className="h-6 text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20" onClick={() => applyClickReorder(tr.route.id)}><CheckCircle className="w-3 h-3" /> Apply ({clickReorderSequence.length}/{tr.route.stopSequence.length})</Button>
                        <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={cancelClickReorder}><XCircle className="w-3 h-3" /> Cancel</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="h-6 text-[10px] text-amber-300 border-amber-500/20 hover:bg-amber-500/10" onClick={() => startClickReorder(tr.route.id)}><MousePointerClick className="w-3 h-3" /> Click Order</Button>
                    )
                  )}
                  {!editMode && (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handlePrint(tr)}><Printer className="w-3 h-3" /> Print</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handleShare(tr)}><Share2 className="w-3 h-3" /> Share</Button>
                    </>
                  )}
                  {!tr.route.approved && (
                    <>
                      <Button size="sm" className="h-6 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, true); }} disabled={approving === tr.route.id}><CheckCircle className="w-3 h-3" /> Approve</Button>
                      <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, false); }} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Reject</Button>
                    </>
                  )}
                  {tr.route.approved && tr.route.fieldRoutesSync?.routeId && tr.route.fieldRoutesSync.routeStatus === "created" && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => handleDeleteFieldRoutesRoute(tr)} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Delete FR Route</Button>
                  )}
                  {tr.route.approved && (tr.route.fieldRoutesSync?.uploadedAppointments?.length || 0) > 0 && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => handleUndoFieldRoutesStops(tr)} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Undo FR Stops</Button>
                  )}
                  {tr.route.approved && !routeReadOnly && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] text-amber-300 border-amber-500/20 hover:bg-amber-500/10" onClick={() => handleUnscheduleRouteIqRoute(tr)} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Unschedule RouteIQ</Button>
                  )}
                </div>
              </div>
            );
          })()}

        </div>
        </DndContext>
      </div>
    </div>
  );
}
