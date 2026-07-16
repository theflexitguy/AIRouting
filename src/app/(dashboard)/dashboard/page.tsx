"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonChart } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/ui/date-picker";
import { MultiSelect } from "@/components/ui/multi-select";
import { formatTime } from "@/lib/utils";
import { formatCurrency, calculateStopProductionValue } from "@/lib/production-value";
import { deriveServiceLine } from "@/lib/routing/service-line";
import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import {
  stopsPerRoute,
  stopsPerHour,
  avgDriveTime,
  monthlyServiced,
  weeklyPace,
  monthlyTargetsByLine,
  isTrackedServiceLine,
  scheduledCountByLine,
  scheduledTrackedTotal,
  targetsByLineForMonths,
  monthKeysForPeriod,
  trailingMonthKeys,
  technicianForecast,
  deriveForecastGrowth,
  TECH_CATEGORIES,
  type MonthlyDoneLike,
  DASHBOARD_PERIODS,
  TARGET_SERVICE_LINES,
  TARGET_SERVICE_LINE_LABELS,
  type DashboardPeriod,
  type LineTarget,
  MONTH_WORKING_DAYS,
  meetsTarget,
  STOPS_PER_ROUTE_TARGET,
  STOPS_PER_HOUR_TARGET,
  DRIVE_TIME_TARGET,
  type RouteLike,
  type JobLike,
  type MonthlyPace,
} from "@/lib/metrics/operational";
import { canonicalRouteGroup } from "@/lib/route-groups";
import {
  Route,
  Briefcase,
  Clock,
  AlertTriangle,
  Target,
  Gauge,
  DollarSign,
  TrendingUp,
  Activity,
  CalendarDays,
  CheckCircle2,
  ListTodo,
  RotateCcw,
  Repeat,
  UserPlus,
  FilePlus2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  format,
  addDays,
  parseISO,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  subWeeks,
} from "date-fns";

interface WeekKpis {
  stopsPerRoute: number | null;
  stopsPerHour: number | null;
  avgDriveTime: number | null;
  routeCount: number;
}

interface TrendRow {
  label: string; // week start, e.g. "Jun 1"
  routeCount: number;
  stopsPerRoute: number | null;
  avgDriveTime: number | null;
  stopsPerHour: number | null;
}

interface DashboardStats {
  todayRoutes: number;
  totalStops: number;
  completedToday: number;
  completedInScope: number;
  stopsLeftToday: number;
  estimatedDriveTime: number;
  totalRouteValue: number;
  avgRouteValue: number;
  todayStopsPerHour: number | null;
  overdueStops: number;
  weekKpis: WeekKpis;
  weekStopsBooked: number;
  stopsLeftWeek: number;
  lineTargets: LineTarget[];
  monthScheduledByLine: Record<string, number>;
  monthScheduledTotal: number;
  weekScheduled: number;
  todayScheduled: number;
  monthlyTarget: number;
  weeklyTarget: number;
  dailyTarget: number;
  pace: MonthlyPace;
  weekPace: MonthlyPace;
  trend: TrendRow[];
  jobsDueThisWeek: Array<{ date: string; count: number }>;
}

// Raw doc shapes the dashboard fetches once, then filters/derives client-side.
interface RouteStopDetail {
  id: string;
  customerName?: string;
  value?: number;
  completed?: boolean; // stamped by the historical reconcile (appointment status 1)
}
interface RouteRec extends RouteLike {
  date: string;
  techId?: string;
  techName?: string;
  routeGroupTitle?: string;
  routeTemplateTitle?: string; // FieldRoutes route template ("Regular", "Rain Day", …)
  routeValue?: number;
  completedStops?: number; // stamped by the historical reconcile (appointment status 1)
  stopSequence?: string[];
  stops?: RouteStopDetail[]; // light per-stop detail persisted by the sync/reconcile
  driveTimeSource?: string; // "routes_api_matrix" = real Google drive time, else straight-line estimate
}
interface JobRec extends JobLike {
  docId?: string; // Firestore doc id (sub_<subscriptionId>), stamped at load
  status?: string;
  overdueActionable?: boolean;
  serviceType?: string;
  fieldRoutesRouteGroup?: string;
  fieldRoutesRouteTemplate?: string;
  scheduledTech?: string; // FieldRoutes tech name on the booked appointment
  customerName?: string;
  address?: string;
  duration?: number; // service minutes for the stop
  // Billing fields feeding calculateStopProductionValue (per-stop route value
  // fallback when a route doc's stops detail predates the value field).
  recurringPrice?: string;
  billingPrice?: string;
  billingFrequency?: string;
  revenue?: number | string;
  productionValue?: number | string;
}
interface TechOption {
  id: string;
  name: string;
  employeeId?: string;
  fieldRoutesEmployeeId?: string;
  fieldRoutesTechId?: string;
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Saturday/Sunday check for a YYYY-MM-DD date string. */
const isWeekendISO = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

// Lines shown in the Initials breakdown (new-signup first services).
const INITIAL_LINE_LABELS: Array<{ key: string; label: string }> = [
  { key: "general", label: "GP" },
  { key: "mosquito", label: "Mosq" },
  { key: "termite", label: "Term" },
  { key: "commercial", label: "Comm" },
];

// Does a route belong to the selected technician? Routes carry techId/techName;
// match against any of the tech's known identifiers.
function routeMatchesTech(r: RouteRec, keys: Set<string>): boolean {
  if (keys.size === 0) return true;
  return [r.techId, r.techName].map(norm).filter(Boolean).some((k) => keys.has(k));
}

export default function DashboardPage() {
  const { userProfile } = useAuth();
  const [loading, setLoading] = useState(true);

  // Raw data, fetched once. All displayed metrics derive from these via useMemo
  // so the date / technician / route-group filters recompute without re-fetching.
  const today = useMemo(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }), []);
  const [rawRoutes, setRawRoutes] = useState<RouteRec[]>([]); // [trendStart, weekEnd]
  const [rawJobs, setRawJobs] = useState<JobRec[]>([]); // inScope subscriptions
  const [techs, setTechs] = useState<TechOption[]>([]);
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  const [monthlyDone, setMonthlyDone] = useState<MonthlyDone | null>(null);
  // Technicians Needed forecast inputs: last <=3 cached monthly aggregates (for
  // one-time run rates) + the persisted monthly growth %.
  const [recentDone, setRecentDone] = useState<MonthlyDoneLike[]>([]);
  const [growthPct, setGrowthPct] = useState("0");
  const [savingGrowth, setSavingGrowth] = useState(false);

  // History selector: targets vs actuals over a past range. "this_month" keeps
  // the live current-month cards; any other period loads cached per-month
  // aggregates + a rate-based target baseline.
  const [period, setPeriod] = useState<DashboardPeriod>("this_month");
  const [rangeDone, setRangeDone] = useState<{
    byLine: Record<string, number>;
    initials: number;
    initialsByLine: Record<string, number>;
    reservices: number;
    followups: number;
    specialty: number;
    wildlife: number;
    newCustomers: number;
    newSubscriptions: number;
    completedAppointments: number;
    monthsAvailable: number;
    monthsTotal: number;
  } | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeRefreshing, setRangeRefreshing] = useState(false);

  // Filters
  const [dateFilterEnabled, setDateFilterEnabled] = useState(false);
  const [dateFrom, setDateFrom] = useState(() => format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(today);
  // Multi-select filters: empty array = no filter ("all").
  const [filterTechs, setFilterTechs] = useState<string[]>([]);
  const [filterGroups, setFilterGroups] = useState<string[]>([]);
  const [filterTemplates, setFilterTemplates] = useState<string[]>([]);
  const [filterSubTypes, setFilterSubTypes] = useState<string[]>([]);
  const [rangeRoutes, setRangeRoutes] = useState<RouteRec[] | null>(null);
  // Custom-range extras: bump to re-fetch after a live FieldRoutes verification,
  // in-flight indicator for that verification, and the skip-weekends toggle.
  const [rangeSyncTick, setRangeSyncTick] = useState(0);
  const [rangeVerifying, setRangeVerifying] = useState(false);
  const [excludeWeekends, setExcludeWeekends] = useState(false);

  // Calendar boundaries (compared as YYYY-MM-DD strings).
  const bounds = useMemo(() => {
    const d = parseISO(today);
    return {
      weekStart: format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      weekEnd: format(endOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      monthStart: format(startOfMonth(d), "yyyy-MM-dd"),
      monthEnd: format(endOfMonth(d), "yyyy-MM-dd"),
      monthIndex: Number(today.slice(5, 7)),
      trendStart: format(startOfWeek(subWeeks(d, 7), { weekStartsOn: 1 }), "yyyy-MM-dd"),
    };
  }, [today]);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadDashboardData(userProfile.companyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile]);

  async function loadDashboardData(companyId: string) {
    try {
      // One routes read covering the 8-week trend through end of this week (which
      // includes today + this week); one inScope jobs read for overdue + targets.
      const routesSnap = await getDocs(
        query(
          collection(db, `companies/${companyId}/routes`),
          where("date", ">=", bounds.trendStart),
          where("date", "<=", bounds.weekEnd)
        )
      );
      setRawRoutes(routesSnap.docs.map(d => d.data() as RouteRec));

      const jobsSnap = await getDocs(
        query(collection(db, `companies/${companyId}/jobs`), where("inScope", "==", true))
      );
      // Derive serviceLine on the fly when a doc predates the Phase-1 stamping, so
      // the per-line targets populate without waiting on a full re-sync.
      setRawJobs(jobsSnap.docs.map(d => {
        const data = d.data() as JobRec;
        data.docId = d.id; // lets drill-downs join route stopSequence ids back to jobs
        if (!data.serviceLine) {
          data.serviceLine = deriveServiceLine(data.serviceType, data.fieldRoutesRouteGroup);
        }
        return data;
      }));

      // Cached completed-this-month aggregate (Initials / Specialty / Wildlife).
      // Ignore a doc left over from a previous month — showing last month's
      // numbers under "Completed This Month" would be misleading on the 1st.
      const mdSnap = await getDoc(doc(db, `companies/${companyId}/fieldRoutesState/monthlyDone`));
      const md = mdSnap.exists() ? (mdSnap.data() as MonthlyDone) : null;
      setMonthlyDone(md && md.month === today.slice(0, 7) ? md : null);

      const techSnap = await getDocs(collection(db, `companies/${companyId}/technicians`));
      setTechs(techSnap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          name: String(data.name || d.id),
          employeeId: data.employeeId ? String(data.employeeId) : undefined,
          fieldRoutesEmployeeId: data.fieldRoutesEmployeeId ? String(data.fieldRoutesEmployeeId) : undefined,
          fieldRoutesTechId: data.fieldRoutesTechId ? String(data.fieldRoutesTechId) : undefined,
        };
      }));

      const companySnap = await getDoc(doc(db, "companies", companyId));
      const saved = companySnap.exists() ? companySnap.data().fieldRoutesRouteGroups : undefined;
      setGroupOptions(Array.isArray(saved) ? saved.map((t: unknown) => String(t)).filter(Boolean) : []);
      const g = companySnap.exists() ? Number(companySnap.data().forecastMonthlyGrowthPct) : 0;
      setGrowthPct(Number.isFinite(g) && g !== 0 ? String(g) : "0");

      // Trailing 15 months of cached completed-appointment aggregates — the
      // Technicians Needed forecast reads them two ways: recent run rates AND
      // year-over-year seasonality (same calendar month a year ago for each of
      // the next 12 forecast months, plus the year-ago comparison for the recent
      // trend). Missing docs just mean a fallback to flat recent-3mo until the
      // history is backfilled via Refresh.
      const histKeys = trailingMonthKeys(today, 15);
      const doneSnaps = await Promise.all(
        histKeys.map((mk) => getDoc(doc(db, `companies/${companyId}/monthlyDone/${mk}`)))
      );
      setRecentDone(doneSnaps.filter((s2) => s2.exists()).map((s2) => s2.data() as MonthlyDoneLike));
    } catch (error) {
      console.error("Dashboard data error:", error);
      setRawRoutes([]);
      setRawJobs([]);
    } finally {
      setLoading(false);
    }
  }

  // Load cached per-month "done" aggregates for the selected history period and
  // sum them per line. Only runs for non-current periods (this_month uses the
  // live cards). Re-runs when `period` or a refresh bumps `rangeRefreshing`.
  const loadRangeDone = useCallback(async () => {
    const companyId = userProfile?.companyId;
    if (!companyId || period === "this_month") { setRangeDone(null); return; }
    setRangeLoading(true);
    try {
      const months = monthKeysForPeriod(period, today);
      const snaps = await Promise.all(
        months.map((mk) => getDoc(doc(db, `companies/${companyId}/monthlyDone/${mk}`))),
      );
      const byLine: Record<string, number> = {};
      const initialsByLine: Record<string, number> = {};
      for (const l of TARGET_SERVICE_LINES) { byLine[l] = 0; initialsByLine[l] = 0; }
      let initials = 0, reservices = 0, followups = 0, specialty = 0, wildlife = 0;
      let newCustomers = 0, newSubscriptions = 0, completedAppointments = 0, monthsAvailable = 0;
      for (const s of snaps) {
        if (!s.exists()) continue;
        monthsAvailable++;
        const d = s.data() as MonthlyDone;
        for (const l of TARGET_SERVICE_LINES) byLine[l] += Number(d.recurringDoneByLine?.[l] || 0);
        for (const k of Object.keys(d.initialsByLine || {})) initialsByLine[k] = (initialsByLine[k] || 0) + Number(d.initialsByLine[k] || 0);
        initials += Number(d.initialsTotal || 0);
        reservices += Number(d.reserviceDone || 0);
        followups += Number(d.followupDone || 0);
        specialty += Number(d.specialtyDone || 0);
        wildlife += Number(d.wildlifeDone || 0);
        newCustomers += Number(d.newCustomers || 0);
        newSubscriptions += Number(d.newSubscriptions || 0);
        completedAppointments += Number(d.completedAppointments || 0);
      }
      setRangeDone({ byLine, initials, initialsByLine, reservices, followups, specialty, wildlife, newCustomers, newSubscriptions, completedAppointments, monthsAvailable, monthsTotal: months.length });
    } catch (e) {
      console.error("Range done load error:", e);
      setRangeDone(null);
    } finally {
      setRangeLoading(false);
    }
  }, [userProfile?.companyId, period, today]);

  useEffect(() => { loadRangeDone(); }, [loadRangeDone]);

  // Backfill any missing months for the selected period via the aggregate
  // endpoint, then reload from cache.
  const refreshRange = useCallback(async () => {
    const companyId = userProfile?.companyId;
    if (!companyId) return;
    setRangeRefreshing(true);
    try {
      const months = monthKeysForPeriod(period, today).length;
      const res = await fetch("/api/fieldroutes/monthly-done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, months }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Couldn't refresh history — check API budget.");
      } else {
        await loadRangeDone();
        toast.success("History refreshed");
      }
    } catch {
      toast.error("Couldn't refresh history.");
    } finally {
      setRangeRefreshing(false);
    }
  }, [userProfile?.companyId, period, today, loadRangeDone]);

  // Fetch routes for a custom date range only while that filter is enabled.
  // rangeSyncTick re-runs the fetch after a live FieldRoutes verification.
  useEffect(() => {
    const companyId = userProfile?.companyId;
    if (!companyId || !dateFilterEnabled) { setRangeRoutes(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, `companies/${companyId}/routes`),
            where("date", ">=", dateFrom),
            where("date", "<=", dateTo)
          )
        );
        if (!cancelled) setRangeRoutes(snap.docs.map(d => d.data() as RouteRec));
      } catch (e) {
        console.error("Range routes error:", e);
        if (!cancelled) setRangeRoutes([]);
      }
    })();
    return () => { cancelled = true; };
  }, [userProfile, dateFilterEnabled, dateFrom, dateTo, rangeSyncTick]);

  // Live-verify a custom range: rebuild the PAST days of the range from actual
  // FieldRoutes appointments (cancellations/reschedules drop off, emptied routes
  // disappear), then re-pull the range routes. Debounced so dragging the date
  // pickers doesn't fire repeatedly; the server also TTL-caches repeat requests
  // for the same range so API budget isn't spent twice.
  useEffect(() => {
    const companyId = userProfile?.companyId;
    if (!companyId || !dateFilterEnabled || !dateFrom || !dateTo) return;
    if (dateFrom >= today) return; // nothing in the past to verify
    let cancelled = false;
    const timer = setTimeout(async () => {
      setRangeVerifying(true);
      try {
        const res = await fetch("/api/fieldroutes/reconcile-range", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startDate: dateFrom, endDate: dateTo }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.warn("Range verification failed:", d);
        } else if (!cancelled && !d.cached && (Number(d.routesWritten) > 0 || Number(d.routesDeleted) > 0)) {
          setRangeSyncTick((v) => v + 1);
        }
      } catch (e) {
        console.warn("Range verification error:", e);
      } finally {
        if (!cancelled) setRangeVerifying(false);
      }
    }, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [userProfile?.companyId, dateFilterEnabled, dateFrom, dateTo, today]);

  // Identifier set for the selected technicians (matched against route/job
  // fields). Union across every selected tech — a route/job matching ANY of
  // them passes the filter.
  const techKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const id of filterTechs) {
      const t = techs.find(x => x.id === id);
      for (const k of [t?.id, t?.name, t?.employeeId, t?.fieldRoutesEmployeeId, t?.fieldRoutesTechId]) {
        const v = norm(k);
        if (v) keys.add(v);
      }
    }
    return keys;
  }, [filterTechs, techs]);

  const filtersActive = dateFilterEnabled || filterTechs.length > 0 || filterGroups.length > 0 || filterTemplates.length > 0 || filterSubTypes.length > 0;

  // Route Template options: distinct template titles across every route loaded
  // (8-week window + custom range), synced from FieldRoutes route.title —
  // "Regular", "Rain Day", "Early Release", "Requested Off", "Call In", ….
  const templateOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of [...rawRoutes, ...(rangeRoutes ?? [])]) {
      const t = String(r.routeTemplateTitle || "").trim();
      if (t) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rawRoutes, rangeRoutes]);

  // Subscription Type options: distinct FieldRoutes service types across the
  // synced subscriptions ("General Pest Control", "Mosquito", "Termite", …).
  const subTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const j of rawJobs) {
      const t = String(j.serviceType || "").trim();
      if (t) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rawJobs]);

  // Join route stopSequence ids (sub_<subscriptionId> / appt_<id>) back to job
  // docs for customer id / service type / today's completion state.
  const jobsByDocId = useMemo(() => {
    const m = new Map<string, JobRec>();
    for (const j of rawJobs) if (j.docId) m.set(j.docId, j);
    return m;
  }, [rawJobs]);

  // Apply technician + route-group + route-template + subscription-type filters
  // to a set of routes. Each filter is a multi-select: empty = all, otherwise
  // match ANY selection. Tech/group/template include or exclude WHOLE routes;
  // subscription type is a STOP-level filter — routes mix types, so each route
  // is rewritten to just its matching stops (stop count, completions, value,
  // service minutes) and every downstream metric reads the rewritten numbers.
  const filterRoutes = useMemo(() => {
    const stopMatchesSubType = (id: string) => {
      const t = String(jobsByDocId.get(id)?.serviceType || "").trim();
      return t !== "" && filterSubTypes.includes(t);
    };
    return (routes: RouteRec[]) => {
      const base = routes.filter(r => {
        // A route with no stops is a phantom (its underlying job docs were purged
        // out from under it) — never count or display it as a route.
        if ((r.totalStops || 0) <= 0) return false;
        // Match on the canonical bucket so every FieldRoutes spelling variant of a
        // group (GPC/gpc, Wildlife/WILD LIFE, …) is included under one selection.
        if (filterGroups.length > 0 && !filterGroups.includes(canonicalRouteGroup(String(r.routeGroupTitle || "")))) return false;
        if (filterTemplates.length > 0 && !filterTemplates.includes(String(r.routeTemplateTitle || "").trim())) return false;
        if (!routeMatchesTech(r, techKeys)) return false;
        return true;
      });
      if (filterSubTypes.length === 0) return base;
      const rewritten: RouteRec[] = [];
      for (const r of base) {
        const seq = Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : [];
        const keep = seq.filter(stopMatchesSubType);
        if (keep.length === 0) continue;
        const keepSet = new Set(keep);
        const detail = (Array.isArray(r.stops) ? r.stops : []).filter(s => keepSet.has(String(s.id)));
        const detailById = new Map(detail.map(s => [String(s.id), s]));
        // Per-stop value: the reconcile-stamped stop value, falling back to the
        // job's production value for docs that predate the stops detail.
        const routeValue = keep.reduce((sum, id) => {
          const d = detailById.get(id);
          if (d && Number.isFinite(Number(d.value))) return sum + Number(d.value);
          const j = jobsByDocId.get(id);
          return sum + (j ? calculateStopProductionValue(j).value || 0 : 0);
        }, 0);
        const totalServiceMinutes = keep.reduce(
          (sum, id) => sum + (Number(jobsByDocId.get(id)?.duration) || 25), 0
        );
        rewritten.push({
          ...r,
          stopSequence: keep,
          stops: detail,
          totalStops: keep.length,
          completedStops: detail.filter(s => s.completed).length,
          routeValue,
          totalServiceMinutes,
          // Drive time stays the whole route's (a drive isn't attributable to a
          // single stop); work minutes pair it with the filtered service time.
          totalWorkMinutes: (Number(r.totalDriveTimeMinutes) || 0) + totalServiceMinutes,
        });
      }
      return rewritten;
    };
  }, [filterGroups, filterTemplates, filterSubTypes, techKeys, jobsByDocId]);

  // Route set for the "Today" cards: the custom range when the date filter is
  // on, otherwise today's routes. Shared with the metric drill-downs so a
  // card's number and its detail list always come from the same route set.
  // Custom range with "skip weekends" on: Sat/Sun routes drop out of every
  // range-derived number (stops, drive, value, KPIs).
  const scopedRoutes = useMemo(() => {
    const rangeSet = dateFilterEnabled
      ? (excludeWeekends ? (rangeRoutes ?? []).filter(r => !isWeekendISO(String(r.date))) : (rangeRoutes ?? []))
      : null;
    return filterRoutes(rangeSet ?? rawRoutes.filter(r => r.date === today));
  }, [dateFilterEnabled, excludeWeekends, rangeRoutes, rawRoutes, filterRoutes, today]);

  const stats: DashboardStats = useMemo(() => {
    // KPIs use this week's routes (or the custom range).
    const rangeSet = dateFilterEnabled
      ? (excludeWeekends ? (rangeRoutes ?? []).filter(r => !isWeekendISO(String(r.date))) : (rangeRoutes ?? []))
      : null;
    const todaySet = scopedRoutes;
    const kpiSet = filterRoutes(
      rangeSet ?? rawRoutes.filter(r => r.date >= bounds.weekStart && r.date <= bounds.weekEnd)
    );

    const totalStops = todaySet.reduce((s, r) => s + (r.totalStops || 0), 0);
    const estimatedDriveTime = todaySet.reduce((s, r) => s + (r.totalDriveTimeMinutes || 0), 0);
    const totalRouteValue = todaySet.reduce((s, r) => s + (Number(r.routeValue) || 0), 0);
    const avgRouteValue = todaySet.length > 0 ? totalRouteValue / todaySet.length : 0;

    // Jobs completed today within the tech/group filter scope (jobs carry the
    // scheduled tech name + route group). Freshness is bounded by the last sync.
    const jobInFilterScope = (j: JobRec) => {
      if (filterGroups.length > 0 && !filterGroups.includes(canonicalRouteGroup(String(j.fieldRoutesRouteGroup || "")))) return false;
      if (filterTemplates.length > 0 && !filterTemplates.includes(String(j.fieldRoutesRouteTemplate || "").trim())) return false;
      if (filterSubTypes.length > 0 && !filterSubTypes.includes(String(j.serviceType || "").trim())) return false;
      if (techKeys.size > 0 && !techKeys.has(norm(j.scheduledTech))) return false;
      return true;
    };
    // Completed stops on a route: the reconcile stamps completedStops from
    // actual appointment statuses on past AND today's docs. Docs that predate
    // the field (or non-FieldRoutes routes) fall back to counting stops whose
    // job doc completed on the route's date, filtered like everything else.
    const completedOnRoute = (r: RouteRec): number => {
      if (typeof r.completedStops === "number") return r.completedStops;
      const seq = Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : [];
      return seq.filter(id => {
        const j = jobsByDocId.get(id);
        return j && j.subscriptionLastCompletedDate === r.date && jobInFilterScope(j);
      }).length;
    };
    const completedToday = todaySet
      .filter(r => r.date === today)
      .reduce((s, r) => s + completedOnRoute(r), 0);
    // "Completed" card: with a custom range, completions across the whole range;
    // otherwise today's routes — both from the same per-route appointment truth.
    const completedInScope = dateFilterEnabled
      ? todaySet.reduce((s, r) => s + completedOnRoute(r), 0)
      : completedToday;

    // Work still sitting on routes: future days count whole; today and past
    // days count each route's booked-minus-completed remainder (appointment
    // truth as of the last sync) — a 68-stop day with 65 done shows 3
    // remaining, not 0, and today's count no longer shrinks as work completes.
    const stopsStillToDo = (routes: RouteRec[]): number => {
      let left = 0;
      for (const r of routes) {
        if (r.date > today) left += r.totalStops || 0;
        else left += Math.max(0, (r.totalStops || 0) - completedOnRoute(r));
      }
      return left;
    };
    const stopsLeftToday = stopsStillToDo(todaySet);
    const stopsLeftWeek = stopsStillToDo(kpiSet);
    const weekStopsBooked = kpiSet.reduce((s, r) => s + (r.totalStops || 0), 0);

    // Already-booked FieldRoutes appointments (the schedule as it stands) — the
    // forward half of pace: done + booked vs target says whether the current
    // schedule is enough to stay on track or the books need more.
    const monthScheduledByLine = scheduledCountByLine(rawJobs, today, bounds.monthEnd);
    const monthScheduledTotal = scheduledTrackedTotal(monthScheduledByLine);
    const weekScheduled = scheduledTrackedTotal(scheduledCountByLine(rawJobs, today, bounds.weekEnd));
    // "Booked today" answers "did we put enough on today's schedule?" — so an
    // appointment completed earlier today still counts (unlike the month/week
    // projections, which exclude completed appts to avoid double-counting done).
    const todayScheduled = rawJobs.filter(
      j => j.alreadyScheduled === true &&
        j.fieldRoutesScheduledDate === today &&
        isTrackedServiceLine(String(j.serviceLine ?? ""))
    ).length;

    // Overdue + targets stay company-wide (subscriptions aren't tied to a route
    // group, and overdue subs are typically unassigned).
    const overdueStops = new Set(
      rawJobs.filter(j => j.overdueActionable).map(j => String(j.customerId))
    ).size;

    // Per-service-line monthly targets (General Pest / Mosquito / Lawn / Termite /
    // Commercial) plus a combined Total. GR + Wildlife are excluded (one-time /
    // auto-scheduled). Weekly + Daily derive from the tracked-line Total.
    const lineTargets = monthlyTargetsByLine(rawJobs, bounds.monthIndex, bounds.monthStart, bounds.monthEnd, today);
    const totalRow = lineTargets[lineTargets.length - 1];
    const monthlyTarget = totalRow.target;
    const pace = totalRow.pace;
    const weeklyTarget = Math.round(monthlyTarget / 4);
    const dailyTarget = Math.round(monthlyTarget / MONTH_WORKING_DAYS);
    const trackedJobs = rawJobs.filter(j => isTrackedServiceLine(String(j.serviceLine ?? "")));
    const weeklyDone = monthlyServiced(trackedJobs, bounds.weekStart, today);
    const weekPace = weeklyPace(weeklyTarget, weeklyDone, bounds.weekStart, today);

    const weekKpis: WeekKpis = {
      stopsPerRoute: stopsPerRoute(kpiSet),
      stopsPerHour: stopsPerHour(kpiSet),
      avgDriveTime: avgDriveTime(kpiSet),
      routeCount: kpiSet.length,
    };

    // 8-week trend: always the last 8 weeks of routes, with tech/group filters
    // applied (but not the date-range filter).
    const trendSet = filterRoutes(rawRoutes);
    const trend: TrendRow[] = [];
    const d0 = parseISO(today);
    for (let w = 7; w >= 0; w--) {
      const wkStartDate = startOfWeek(subWeeks(d0, w), { weekStartsOn: 1 });
      const wkStart = format(wkStartDate, "yyyy-MM-dd");
      const wkEnd = format(endOfWeek(wkStartDate, { weekStartsOn: 1 }), "yyyy-MM-dd");
      const wk = trendSet.filter(r => r.date >= wkStart && r.date <= wkEnd);
      trend.push({
        label: format(wkStartDate, "MMM d"),
        routeCount: wk.length,
        stopsPerRoute: stopsPerRoute(wk),
        avgDriveTime: avgDriveTime(wk),
        stopsPerHour: stopsPerHour(wk),
      });
    }

    // Jobs due over the next 7 days (company-wide).
    const jobsDueThisWeek = Array.from({ length: 7 }, (_, i) => {
      const dd = format(addDays(parseISO(today), i), "yyyy-MM-dd");
      const count = rawJobs.filter(j =>
        j.scheduledDate === dd && (j.status === "pending" || j.status === "scheduled")
      ).length;
      return { date: format(addDays(parseISO(today), i), "EEE"), count };
    });

    return {
      todayRoutes: todaySet.length,
      totalStops,
      completedToday,
      completedInScope,
      stopsLeftToday,
      estimatedDriveTime,
      totalRouteValue,
      avgRouteValue,
      todayStopsPerHour: stopsPerHour(todaySet),
      overdueStops,
      weekKpis,
      weekStopsBooked,
      stopsLeftWeek,
      lineTargets,
      monthScheduledByLine,
      monthScheduledTotal,
      weekScheduled,
      todayScheduled,
      monthlyTarget,
      weeklyTarget,
      dailyTarget,
      pace,
      weekPace,
      trend,
      jobsDueThisWeek,
    };
  }, [rawRoutes, rawJobs, rangeRoutes, dateFilterEnabled, excludeWeekends, filterRoutes, filterGroups, filterTemplates, filterSubTypes, techKeys, bounds, today, scopedRoutes, jobsByDocId]);

  // ── Metric drill-downs ──────────────────────────────────────────────────
  // Clicking Routes / Total Stops / Completed / Stops Remaining opens an audit
  // view of the exact routes/stops behind that number.
  const [drill, setDrill] = useState<"routes" | "stops" | "completed" | "remaining" | null>(null);

  const drillData = useMemo(() => {
    const routes = [...scopedRoutes].sort(
      (a, b) => a.date.localeCompare(b.date) || String(a.techName || "").localeCompare(String(b.techName || ""))
    );

    interface StopRow {
      key: string;
      customerId: string;
      customerName: string;
      techName: string;
      date: string;
      template: string;
      group: string;
      serviceType: string;
      address: string;
      status: "completed" | "pending" | "scheduled" | "unknown";
    }
    const stopRows: StopRow[] = [];
    const routeRows = routes.map((r) => {
      const seq: string[] = Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : [];
      const detailById = new Map((Array.isArray(r.stops) ? r.stops : []).map((s) => [String(s.id), s]));
      let liveCompleted = 0;
      for (const id of seq) {
        const detail = detailById.get(id);
        const job = jobsByDocId.get(id);
        let status: StopRow["status"];
        if (r.date > today) status = "scheduled";
        else if (detail && typeof detail.completed === "boolean") {
          // Per-stop appointment truth stamped by the reconcile — covers past
          // days AND today (as of the last sync).
          status = detail.completed ? "completed" : "pending";
        } else if (r.date === today) {
          // Today's docs that predate the appointment rebuild: job-doc fallback.
          status = job?.subscriptionLastCompletedDate === today ? "completed" : "pending";
        } else {
          // Past day, doc predates the stops array — unknown until re-verified.
          status = "unknown";
        }
        if (status === "completed") liveCompleted++;
        stopRows.push({
          key: `${r.date}-${String(r.techId || r.techName)}-${id}`,
          customerId: String(job?.customerId || ""),
          customerName: String(detail?.customerName || job?.customerName || id),
          techName: String(r.techName || r.techId || "—"),
          date: r.date,
          template: String(r.routeTemplateTitle || "").trim(),
          group: String(r.routeGroupTitle || "").trim(),
          serviceType: String(job?.serviceType || ""),
          address: String(job?.address || ""),
          status,
        });
      }
      // Completed on the route card: trust the reconcile-stamped count when
      // present (past days and today alike); docs that predate the field use
      // the per-stop tally above.
      const completed = typeof r.completedStops === "number" ? r.completedStops : liveCompleted;
      return {
        key: `${r.date}-${String(r.techId || r.techName)}`,
        date: r.date,
        techName: String(r.techName || r.techId || "—"),
        template: String(r.routeTemplateTitle || "").trim(),
        group: String(r.routeGroupTitle || "").trim(),
        totalStops: r.totalStops || 0,
        completed,
        driveMinutes: Number(r.totalDriveTimeMinutes) || 0,
        driveEstimated: String(r.driveTimeSource || "") !== "routes_api_matrix",
        routeValue: Number(r.routeValue) || 0,
      };
    });

    return {
      routeRows,
      stopRows,
      completedRows: stopRows.filter((s) => s.status === "completed"),
      remainingRows: stopRows.filter((s) => s.status === "pending" || s.status === "scheduled"),
      hasUnknown: stopRows.some((s) => s.status === "unknown"),
      hasEstimatedDrive: routeRows.some((r) => r.driveEstimated),
    };
  }, [scopedRoutes, jobsByDocId, today]);

  // Historical period view (null for the current month, which uses the live cards).
  const periodView = useMemo(() => {
    if (period === "this_month") return null;
    const months = monthKeysForPeriod(period, today);
    const targets = targetsByLineForMonths(rawJobs, months);
    const rows = TARGET_SERVICE_LINES.map((line) => ({
      line,
      label: TARGET_SERVICE_LINE_LABELS[line],
      target: targets[line] || 0,
      done: rangeDone?.byLine?.[line] || 0,
    }));
    const total = {
      target: rows.reduce((s, r) => s + r.target, 0),
      done: rows.reduce((s, r) => s + r.done, 0),
    };
    const label = DASHBOARD_PERIODS.find((p) => p.value === period)?.label || "";
    return { months, rows, total, label };
  }, [period, today, rawJobs, rangeDone]);

  // Technicians Needed: 12-month forecast. `recentDone` holds the trailing 15
  // months of aggregates, used for both YoY seasonality and the recent trend.
  const techForecast = useMemo(() => {
    if (rawJobs.length === 0) return [];
    return technicianForecast(rawJobs, recentDone, today, Number(growthPct) || 0);
  }, [rawJobs, recentDone, today, growthPct]);

  // Resolved growth driver for display: "auto" (from new-subscription YoY trend)
  // or "manual" (the growth % input) when there's not enough history.
  const forecastGrowth = useMemo(
    () => deriveForecastGrowth(recentDone, today, Number(growthPct) || 0),
    [recentDone, today, growthPct],
  );

  const saveGrowthPct = useCallback(async () => {
    const companyId = userProfile?.companyId;
    if (!companyId) return;
    const g = Number(growthPct);
    if (!Number.isFinite(g) || g < -50 || g > 50) {
      toast.error("Growth % must be between -50 and 50.");
      return;
    }
    setSavingGrowth(true);
    try {
      const { setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "companies", companyId), { forecastMonthlyGrowthPct: g }, { merge: true });
      toast.success(`Forecast growth set to ${g}%/month`);
    } catch {
      toast.error("Couldn't save growth %.");
    } finally {
      setSavingGrowth(false);
    }
  }, [userProfile?.companyId, growthPct]);

  const routeWindowLabel = dateFilterEnabled ? "Selected range" : "Today";
  const kpiWindowLabel = dateFilterEnabled ? "Selected range" : "This Week";
  const fmt1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));

  // TODAY cards (route-derived; respect the filters). Cards with a `drill` key
  // open an audit view of the routes/stops behind the number.
  const todayCards: Array<{
    title: string; value: string; subtitle: string;
    icon: typeof Route; color: string; bgColor: string;
    drill?: "routes" | "stops" | "completed" | "remaining";
  }> = [
    { title: "Routes", value: String(stats.todayRoutes), subtitle: `${routeWindowLabel} · active routes`, icon: Route, color: "text-blue-400", bgColor: "bg-blue-500/10", drill: "routes" },
    { title: "Total Stops", value: String(stats.totalStops), subtitle: `${routeWindowLabel} · all techs`, icon: Briefcase, color: "text-purple-400", bgColor: "bg-purple-500/10", drill: "stops" },
    { title: "Completed", value: String(stats.completedInScope), subtitle: dateFilterEnabled ? `${routeWindowLabel} · completed stops` : "today · as of last sync", icon: CheckCircle2, color: "text-emerald-400", bgColor: "bg-emerald-500/10", drill: "completed" },
    { title: "Stops Remaining", value: String(stats.stopsLeftToday), subtitle: `${routeWindowLabel} · still on routes`, icon: ListTodo, color: "text-sky-400", bgColor: "bg-sky-500/10", drill: "remaining" },
    { title: "Drive Time", value: formatTime(stats.estimatedDriveTime), subtitle: `${routeWindowLabel} · total`, icon: Clock, color: "text-orange-400", bgColor: "bg-orange-500/10" },
    { title: "Total Route Value", value: formatCurrency(stats.totalRouteValue), subtitle: `${routeWindowLabel} · all routes`, icon: DollarSign, color: "text-emerald-400", bgColor: "bg-emerald-500/10" },
    { title: "Avg Route Value", value: formatCurrency(stats.avgRouteValue), subtitle: `${routeWindowLabel} · per route`, icon: TrendingUp, color: "text-teal-400", bgColor: "bg-teal-500/10" },
    { title: "Stops / Hour", value: fmt1(stats.todayStopsPerHour), subtitle: `${routeWindowLabel} · per working hour`, icon: Activity, color: "text-yellow-400", bgColor: "bg-yellow-500/10" },
  ];

  // THIS WEEK efficiency KPIs vs targets, plus the concrete work remaining.
  const weekCards = [
    { title: "Stops Left on Routes", value: String(stats.stopsLeftWeek), target: null as string | null, subtitle: `of ${stats.weekStopsBooked.toLocaleString()} booked this week`, ok: null as boolean | null },
    { title: "Stops / Route", value: fmt1(stats.weekKpis.stopsPerRoute), target: `≥ ${STOPS_PER_ROUTE_TARGET}`, subtitle: "", ok: meetsTarget(stats.weekKpis.stopsPerRoute, STOPS_PER_ROUTE_TARGET) },
    { title: "Stops / Hour", value: fmt1(stats.weekKpis.stopsPerHour), target: `≥ ${STOPS_PER_HOUR_TARGET.toFixed(1)}`, subtitle: "", ok: meetsTarget(stats.weekKpis.stopsPerHour, STOPS_PER_HOUR_TARGET) },
    { title: "Avg Drive Time", value: stats.weekKpis.avgDriveTime === null ? "—" : `${Math.round(stats.weekKpis.avgDriveTime)}m`, target: `< ${DRIVE_TIME_TARGET}m`, subtitle: "", ok: meetsTarget(stats.weekKpis.avgDriveTime, DRIVE_TIME_TARGET, true) },
  ];

  const weekDonePct = Math.round(stats.weekPace.donePct * 100);
  const weekProgressPct = Math.round(stats.weekPace.progressPct * 100);

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Dashboard" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonCard key={i} className={`animate-fade-in stagger-${i + 1}`} />
              ))}
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <SkeletonChart className="animate-fade-in stagger-5" />
              <SkeletonChart className="animate-fade-in stagger-6" />
            </div>
          </div>
        ) : (
          <>
            {/* Filter bar — date range / technician / route group */}
            <div className="flex flex-col gap-2.5 rounded-lg border border-border/40 bg-card/40 p-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="flex items-center gap-2">
                  <Switch id="dash-date" checked={dateFilterEnabled} onCheckedChange={setDateFilterEnabled} />
                  <label htmlFor="dash-date" className="text-sm text-muted-foreground cursor-pointer">Date range</label>
                </div>
                {dateFilterEnabled && (
                  <>
                    <DatePicker value={dateFrom} onChange={setDateFrom} className="h-8 text-xs" />
                    <span className="text-muted-foreground text-sm">to</span>
                    <DatePicker value={dateTo} onChange={setDateTo} className="h-8 text-xs" />
                    <div className="flex items-center gap-2">
                      <Switch id="dash-weekends" checked={excludeWeekends} onCheckedChange={setExcludeWeekends} />
                      <label htmlFor="dash-weekends" className="text-sm text-muted-foreground cursor-pointer whitespace-nowrap">Skip weekends</label>
                    </div>
                    {rangeVerifying && (
                      <span className="text-xs text-blue-300/80 animate-pulse whitespace-nowrap">Verifying range with FieldRoutes…</span>
                    )}
                  </>
                )}
                <MultiSelect
                  options={techs.map(t => ({ value: t.id, label: t.name }))}
                  selected={filterTechs}
                  onChange={setFilterTechs}
                  allLabel="All Technicians"
                  className="w-full sm:w-44 h-8 text-xs"
                />
                <MultiSelect
                  options={groupOptions.map(g => ({ value: g, label: g }))}
                  selected={filterGroups}
                  onChange={setFilterGroups}
                  allLabel="All Route Groups"
                  className="w-full sm:w-44 h-8 text-xs"
                />
                <MultiSelect
                  options={templateOptions.map(t => ({ value: t, label: t }))}
                  selected={filterTemplates}
                  onChange={setFilterTemplates}
                  allLabel="All Route Templates"
                  className="w-full sm:w-44 h-8 text-xs"
                />
                <MultiSelect
                  options={subTypeOptions.map(t => ({ value: t, label: t }))}
                  selected={filterSubTypes}
                  onChange={setFilterSubTypes}
                  allLabel="All Subscription Types"
                  className="w-full sm:w-48 h-8 text-xs"
                />
                {filtersActive && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground/60 hover:text-foreground underline underline-offset-2 ml-auto"
                    onClick={() => { setDateFilterEnabled(false); setExcludeWeekends(false); setFilterTechs([]); setFilterGroups([]); setFilterTemplates([]); setFilterSubTypes([]); }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
              {groupOptions.length === 0 && (
                <p className="text-xs text-muted-foreground/50">
                  Tip: pull and select your route groups in Settings to filter by GPC / Specialty / Wildlife / Lawn.
                </p>
              )}
            </div>

            {/* TODAY — operational snapshot (route-derived; respects filters) */}
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{routeWindowLabel}</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {todayCards.map((stat, i) => {
                const Icon = stat.icon;
                return (
                  <Card
                    key={stat.title}
                    className={`border-border/40 animate-fade-in stagger-${i + 1} ${stat.drill ? "cursor-pointer transition-colors hover:border-blue-500/40 hover:bg-accent/20" : ""}`}
                    onClick={stat.drill ? () => setDrill(stat.drill!) : undefined}
                    role={stat.drill ? "button" : undefined}
                    tabIndex={stat.drill ? 0 : undefined}
                    onKeyDown={stat.drill ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrill(stat.drill!); } } : undefined}
                  >
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <p className="text-[13px] text-muted-foreground font-medium">{stat.title}</p>
                          <p className="text-2xl font-bold text-foreground tracking-tight">{stat.value}</p>
                          <p className="text-xs text-muted-foreground/70">{stat.subtitle}{stat.drill ? " · click to audit" : ""}</p>
                        </div>
                        <div className={`p-2 rounded-lg ${stat.bgColor} ${stat.color}`}>
                          <Icon className="w-4 h-4" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* METRIC DRILL-DOWN — audit view of the routes/stops behind a card */}
            <Dialog open={drill !== null} onOpenChange={(open) => { if (!open) setDrill(null); }}>
              <DialogContent className="max-w-5xl">
                <DialogHeader>
                  <DialogTitle>
                    {drill === "routes" && `Routes (${drillData.routeRows.length})`}
                    {drill === "stops" && `Total Stops (${drillData.stopRows.length})`}
                    {drill === "completed" && `Completed Stops (${drillData.completedRows.length})`}
                    {drill === "remaining" && `Stops Remaining (${drillData.remainingRows.length})`}
                  </DialogTitle>
                  <DialogDescription>
                    {routeWindowLabel}
                    {dateFilterEnabled ? ` · ${dateFrom} to ${dateTo}` : ` · ${today}`}
                    {filterTechs.length > 0 ? ` · ${filterTechs.map(id => techs.find(t => t.id === id)?.name || id).join(", ")}` : ""}
                    {filterGroups.length > 0 ? ` · ${filterGroups.join(", ")}` : ""}
                    {filterTemplates.length > 0 ? ` · ${filterTemplates.join(", ")}` : ""}
                    {filterSubTypes.length > 0 ? ` · ${filterSubTypes.join(", ")}` : ""}
                  </DialogDescription>
                </DialogHeader>
                <div className="max-h-[65vh] overflow-y-auto">
                  {drill === "routes" ? (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-background">
                        <tr className="text-left text-xs text-muted-foreground/60 border-b border-border/40">
                          <th className="py-2 pr-4 font-medium">Date</th>
                          <th className="py-2 pr-4 font-medium">Technician</th>
                          <th className="py-2 pr-4 font-medium">Template</th>
                          <th className="py-2 pr-4 font-medium">Group</th>
                          <th className="py-2 pr-4 font-medium text-right">Completed</th>
                          <th className="py-2 pr-4 font-medium text-right">Stops</th>
                          <th className="py-2 pr-4 font-medium text-right">Drive</th>
                          <th className="py-2 font-medium text-right">Route Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {drillData.routeRows.map((r) => (
                          <tr key={r.key} className="border-b border-border/20 last:border-0">
                            <td className="py-2 pr-4 text-foreground whitespace-nowrap">{r.date}</td>
                            <td className="py-2 pr-4 text-foreground">{r.techName}</td>
                            <td className="py-2 pr-4">
                              {r.template
                                ? <Badge variant="secondary" className="font-medium">{r.template}</Badge>
                                : <span className="text-muted-foreground/40">—</span>}
                            </td>
                            <td className="py-2 pr-4 text-muted-foreground">{r.group || "—"}</td>
                            <td className={`py-2 pr-4 text-right tabular-nums ${r.completed >= r.totalStops ? "text-emerald-400" : "text-foreground"}`}>{r.completed}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">{r.totalStops}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                              {r.driveEstimated ? "~" : ""}{formatTime(r.driveMinutes)}
                              {r.driveEstimated && <span className="ml-1 text-[10px] text-amber-400/80 align-middle" title="Straight-line estimate — real Google drive time lands on the next sync">est</span>}
                            </td>
                            <td className="py-2 text-right tabular-nums text-foreground">{formatCurrency(r.routeValue)}</td>
                          </tr>
                        ))}
                        {drillData.routeRows.length === 0 && (
                          <tr><td colSpan={8} className="py-6 text-center text-muted-foreground/60 text-sm">No routes in this view.</td></tr>
                        )}
                      </tbody>
                    </table>
                  ) : (
                    (() => {
                      const rows = drill === "completed" ? drillData.completedRows
                        : drill === "remaining" ? drillData.remainingRows
                        : drillData.stopRows;
                      return (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-background">
                            <tr className="text-left text-xs text-muted-foreground/60 border-b border-border/40">
                              <th className="py-2 pr-4 font-medium">Customer ID</th>
                              <th className="py-2 pr-4 font-medium">Customer</th>
                              <th className="py-2 pr-4 font-medium">Route</th>
                              <th className="py-2 pr-4 font-medium">Service</th>
                              <th className="py-2 pr-4 font-medium">Template</th>
                              <th className="py-2 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((s) => (
                              <tr key={s.key} className="border-b border-border/20 last:border-0">
                                <td className="py-2 pr-4 tabular-nums text-muted-foreground whitespace-nowrap">{s.customerId || "—"}</td>
                                <td className="py-2 pr-4">
                                  <p className="text-foreground font-medium">{s.customerName}</p>
                                  {s.address && <p className="text-xs text-muted-foreground/60 truncate max-w-[240px]">{s.address}</p>}
                                </td>
                                <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">{s.techName} · {s.date}</td>
                                <td className="py-2 pr-4 text-muted-foreground">{s.serviceType || "—"}</td>
                                <td className="py-2 pr-4 text-muted-foreground">{s.template || "—"}</td>
                                <td className="py-2">
                                  {s.status === "completed" && <Badge variant="success">Completed</Badge>}
                                  {s.status === "pending" && <Badge variant="warning">Not completed</Badge>}
                                  {s.status === "scheduled" && <Badge variant="secondary">Scheduled</Badge>}
                                  {s.status === "unknown" && <Badge variant="outline">—</Badge>}
                                </td>
                              </tr>
                            ))}
                            {rows.length === 0 && (
                              <tr><td colSpan={6} className="py-6 text-center text-muted-foreground/60 text-sm">No stops in this view.</td></tr>
                            )}
                          </tbody>
                        </table>
                      );
                    })()
                  )}
                </div>
                {drill !== "routes" && drillData.hasUnknown && (
                  <p className="text-xs text-muted-foreground/50">
                    Some past stops don&apos;t have per-stop completion detail yet — re-pick the date range (or run a sync)
                    to verify them against FieldRoutes.
                  </p>
                )}
                {drill === "routes" && drillData.hasEstimatedDrive && (
                  <p className="text-xs text-muted-foreground/50">
                    <span className="text-amber-400/80">~est</span> drive times are straight-line estimates — real Google
                    drive times replace them on the next sync (today&apos;s routes are upgraded first).
                  </p>
                )}
              </DialogContent>
            </Dialog>

            {/* OVERDUE STOPS — its own thing (company-wide) */}
            <Card className="border-red-500/30 bg-red-500/[0.04] animate-fade-in">
              <CardContent className="p-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-lg bg-red-500/10 text-red-400">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-[13px] text-muted-foreground font-medium">Overdue Stops</p>
                    <p className="text-xs text-muted-foreground/70">Customers past due 30+ days · company-wide</p>
                  </div>
                </div>
                <p className="text-4xl font-bold text-red-400 tracking-tight">{stats.overdueStops}</p>
              </CardContent>
            </Card>

            {/* THIS WEEK — efficiency KPIs vs targets */}
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{kpiWindowLabel}</p>
              <p className="text-xs text-muted-foreground/50">{stats.weekKpis.routeCount} routes</p>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {weekCards.map((kpi) => {
                const color = kpi.target === null
                  ? "text-foreground"
                  : kpi.ok === null ? "text-muted-foreground/50" : kpi.ok ? "text-emerald-400" : "text-red-400";
                return (
                  <Card key={kpi.title} className="border-border/40 animate-fade-in">
                    <CardContent className="p-5">
                      <p className="text-[13px] text-muted-foreground font-medium">{kpi.title}</p>
                      <p className={`text-2xl font-bold tracking-tight ${color}`}>{kpi.value}</p>
                      <p className="text-xs text-muted-foreground/70">{kpi.target === null ? kpi.subtitle : `Target ${kpi.target}`}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* TARGETS — per service line, with a history period selector */}
            <div className="flex items-center justify-between pt-2 gap-3 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Targets by Service</p>
              <div className="flex items-center gap-2">
                {periodView && (
                  <span className="text-xs text-muted-foreground/50">
                    {rangeLoading ? "loading…" : `${rangeDone?.monthsAvailable ?? 0}/${rangeDone?.monthsTotal ?? periodView.months.length} months`}
                  </span>
                )}
                {periodView && (
                  <button
                    onClick={refreshRange}
                    disabled={rangeRefreshing}
                    className="text-xs px-2 py-1 rounded-md border border-border/50 text-muted-foreground hover:bg-accent/30 disabled:opacity-50 transition-colors"
                  >
                    {rangeRefreshing ? "Refreshing…" : "Refresh"}
                  </button>
                )}
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as DashboardPeriod)}
                  className="text-xs bg-card border border-border/50 rounded-md px-2 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-blue-500/40"
                >
                  {DASHBOARD_PERIODS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {periodView ? (
              // Historical range: actual completed vs a rate-based target baseline.
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[...periodView.rows, { line: "total" as const, label: "Total (All)", target: periodView.total.target, done: periodView.total.done }].map((r) => {
                  const isTotal = r.line === "total";
                  const pct = r.target > 0 ? Math.round((r.done / r.target) * 100) : 0;
                  const ok = r.done >= r.target;
                  return (
                    <Card key={r.line} className={`border-border/40 animate-fade-in ${isTotal ? "ring-1 ring-blue-500/40 bg-blue-500/[0.03]" : ""}`}>
                      <CardContent className="p-5 space-y-3">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-[13px] text-muted-foreground font-medium">{r.label}</p>
                            <p className="text-3xl font-bold text-foreground tracking-tight">
                              {r.done.toLocaleString()}
                              <span className="text-base text-muted-foreground/60 font-medium"> / {r.target.toLocaleString()}</span>
                            </p>
                            <p className="text-xs text-muted-foreground/70">{periodView.label} · done / target</p>
                          </div>
                          <div className={`p-2 rounded-lg ${isTotal ? "bg-blue-500/10 text-blue-400" : "bg-accent/40 text-muted-foreground"}`}><Target className="w-4 h-4" /></div>
                        </div>
                        <div className="space-y-1">
                          <Progress value={Math.min(100, pct)} className="h-2" />
                          <p className={`text-xs ${ok ? "text-emerald-400" : "text-red-400"}`}>{pct}% of target</p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              // Current month: live cards with pace.
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.lineTargets.map((lt) => {
                  const donePct = Math.round(lt.pace.donePct * 100);
                  const progressPct = Math.round(lt.pace.progressPct * 100);
                  const isTotal = lt.line === "total";
                  // Forecast: what's already on the books for the rest of the
                  // month. done + booked vs target answers "is the schedule as
                  // it stands enough, or do we need to book more?"
                  const booked = isTotal ? stats.monthScheduledTotal : (stats.monthScheduledByLine[lt.line] || 0);
                  const projected = lt.pace.done + booked;
                  const projPct = lt.target > 0 ? Math.round((projected / lt.target) * 100) : 0;
                  const shortBy = Math.max(0, lt.target - projected);
                  const doneW = lt.target > 0 ? Math.min(100, (lt.pace.done / lt.target) * 100) : 0;
                  const bookedW = lt.target > 0 ? Math.min(100 - doneW, (booked / lt.target) * 100) : 0;
                  return (
                    <Card key={lt.line} className={`border-border/40 animate-fade-in ${isTotal ? "ring-1 ring-blue-500/40 bg-blue-500/[0.03]" : ""}`}>
                      <CardContent className="p-5 space-y-3">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-[13px] text-muted-foreground font-medium">{isTotal ? "Total (All)" : lt.label}</p>
                            <p className="text-3xl font-bold text-foreground tracking-tight">{lt.target.toLocaleString()}</p>
                            <p className="text-xs text-muted-foreground/70">{lt.pace.done.toLocaleString()} done · {booked.toLocaleString()} booked · {lt.pace.remaining.toLocaleString()} left</p>
                          </div>
                          <div className={`p-2 rounded-lg ${isTotal ? "bg-blue-500/10 text-blue-400" : "bg-accent/40 text-muted-foreground"}`}><Target className="w-4 h-4" /></div>
                        </div>
                        <div className="space-y-1">
                          {/* Stacked: solid = done, faded = booked on the schedule */}
                          <div className="h-2 w-full rounded-full bg-secondary overflow-hidden flex">
                            <div className="h-full bg-primary" style={{ width: `${doneW}%` }} />
                            <div className="h-full bg-primary/35" style={{ width: `${bookedW}%` }} />
                          </div>
                          <p className={`text-xs ${lt.pace.ahead ? "text-emerald-400" : "text-red-400"}`}>
                            {donePct}% of target · {progressPct}% through month · {lt.pace.ahead ? "on/ahead of pace" : "behind pace"}
                          </p>
                          <p className={`text-xs ${shortBy === 0 ? "text-emerald-400" : "text-amber-400"}`}>
                            {shortBy === 0
                              ? `Schedule covers target · ${projected.toLocaleString()} done + booked`
                              : `Projected ${projPct}% with schedule · book ${shortBy.toLocaleString()} more`}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Weekly + Daily — current month only (derived from the tracked-line Total) */}
            {!periodView && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Weekly target — with the same %-of-target pace as Monthly */}
              <Card className="border-border/40 animate-fade-in">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[13px] text-muted-foreground font-medium">Weekly Target</p>
                      <p className="text-3xl font-bold text-foreground tracking-tight">{stats.weeklyTarget.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground/70">{stats.weekPace.done.toLocaleString()} done · {stats.weekScheduled.toLocaleString()} booked · {stats.weekPace.remaining.toLocaleString()} left</p>
                    </div>
                    <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400"><Gauge className="w-4 h-4" /></div>
                  </div>
                  <div className="space-y-1">
                    {/* Stacked: solid = done, faded = booked through end of week */}
                    <div className="h-2 w-full rounded-full bg-secondary overflow-hidden flex">
                      <div className="h-full bg-primary" style={{ width: `${Math.min(100, weekDonePct)}%` }} />
                      <div
                        className="h-full bg-primary/35"
                        style={{ width: `${stats.weeklyTarget > 0 ? Math.min(100 - Math.min(100, weekDonePct), (stats.weekScheduled / stats.weeklyTarget) * 100) : 0}%` }}
                      />
                    </div>
                    <p className={`text-xs ${stats.weekPace.ahead ? "text-emerald-400" : "text-red-400"}`}>
                      {weekDonePct}% of target · {weekProgressPct}% through week · {stats.weekPace.ahead ? "on/ahead of pace" : "behind pace"}
                    </p>
                    <p className={`text-xs ${stats.weekPace.done + stats.weekScheduled >= stats.weeklyTarget ? "text-emerald-400" : "text-amber-400"}`}>
                      {stats.weekPace.done + stats.weekScheduled >= stats.weeklyTarget
                        ? `Schedule covers target · ${(stats.weekPace.done + stats.weekScheduled).toLocaleString()} done + booked`
                        : `Projected ${(stats.weekPace.done + stats.weekScheduled).toLocaleString()} with schedule · book ${(stats.weeklyTarget - stats.weekPace.done - stats.weekScheduled).toLocaleString()} more`}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Daily target */}
              <Card className="border-border/40 animate-fade-in">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <p className="text-[13px] text-muted-foreground font-medium">Daily Target</p>
                      <p className="text-3xl font-bold text-foreground tracking-tight">{stats.dailyTarget.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground/70">Monthly ÷ {MONTH_WORKING_DAYS} working days</p>
                      <p className={`text-xs ${stats.todayScheduled >= stats.dailyTarget ? "text-emerald-400" : "text-amber-400"}`}>
                        {stats.todayScheduled.toLocaleString()} booked today vs {stats.dailyTarget.toLocaleString()} target
                      </p>
                    </div>
                    <div className="p-2 rounded-lg bg-teal-500/10 text-teal-400"><CalendarDays className="w-4 h-4" /></div>
                  </div>
                </CardContent>
              </Card>
            </div>
            )}

            {/* COMPLETED — Initials / Reservices / Specialty / Wildlife (from completed appointments) */}
            {(() => {
              // Period-aware: current month uses the live monthlyDone doc; a
              // historical period uses the summed cached aggregates.
              const cd = periodView
                ? (rangeDone && rangeDone.monthsAvailable > 0
                    ? {
                        initialsTotal: rangeDone.initials,
                        initialsByLine: rangeDone.initialsByLine,
                        reserviceDone: rangeDone.reservices,
                        followupDone: rangeDone.followups,
                        specialtyDone: rangeDone.specialty,
                        wildlifeDone: rangeDone.wildlife,
                        newCustomers: rangeDone.newCustomers,
                        newSubscriptions: rangeDone.newSubscriptions,
                        completedAppointments: rangeDone.completedAppointments,
                      }
                    : null)
                : monthlyDone;
              const heading = periodView ? `Completed · ${periodView.label}` : "Completed This Month";
              const caption = periodView
                ? (rangeLoading ? "loading…" : cd ? `${cd.completedAppointments.toLocaleString()} appts` : "not yet computed — use Refresh")
                : (monthlyDone ? `${monthlyDone.completedAppointments.toLocaleString()} appts · updated ${format(parseISO(monthlyDone.computedAt), "MMM d")}` : "not yet computed");
              return (
                <>
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{heading}</p>
              <p className="text-xs text-muted-foreground/50">{caption}</p>
            </div>
            {cd ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Initials with per-line breakdown */}
                <Card className="border-border/40 animate-fade-in">
                  <CardContent className="p-5 space-y-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-[13px] text-muted-foreground font-medium">Initials</p>
                        <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.initialsTotal ?? 0).toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground/70">new-signup first services</p>
                      </div>
                      <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400"><TrendingUp className="w-4 h-4" /></div>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
                      {INITIAL_LINE_LABELS.map(({ key, label }) => (
                        <span key={key}>{label} <span className="text-foreground font-medium tabular-nums">{cd.initialsByLine?.[key] ?? 0}</span></span>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Reservices — unscheduled returns/callbacks; feeds the forecast as GPC workload */}
                <Card className="border-border/40 animate-fade-in">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <p className="text-[13px] text-muted-foreground font-medium">Reservices</p>
                        <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.reserviceDone ?? 0).toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground/70">reservices / retreats / callbacks</p>
                      </div>
                      <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400"><RotateCcw className="w-4 h-4" /></div>
                    </div>
                  </CardContent>
                </Card>

                {/* Follow-ups — own bucket; also feeds the forecast as GPC workload */}
                <Card className="border-border/40 animate-fade-in">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <p className="text-[13px] text-muted-foreground font-medium">Follow-ups</p>
                        <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.followupDone ?? 0).toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground/70">scheduled follow-up visits</p>
                      </div>
                      <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400"><Repeat className="w-4 h-4" /></div>
                    </div>
                  </CardContent>
                </Card>

                {/* Specialty (GR + one-time / flea / misc) */}
                <Card className="border-border/40 animate-fade-in">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <p className="text-[13px] text-muted-foreground font-medium">Specialty</p>
                        <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.specialtyDone ?? 0).toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground/70">German Roach · flea · one-time · misc</p>
                      </div>
                      <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400"><Activity className="w-4 h-4" /></div>
                    </div>
                  </CardContent>
                </Card>

                {/* Wildlife */}
                <Card className="border-border/40 animate-fade-in">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <p className="text-[13px] text-muted-foreground font-medium">Wildlife</p>
                        <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.wildlifeDone ?? 0).toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground/70">exclusion &amp; wildlife work</p>
                      </div>
                      <div className="p-2 rounded-lg bg-rose-500/10 text-rose-400"><Briefcase className="w-4 h-4" /></div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : (
              <Card className="border-border/40">
                <CardContent className="p-4 text-xs text-muted-foreground/70">
                  Initials, Reservices, Follow-ups, Specialty, and Wildlife counts come from completed appointments.{" "}
                  {periodView
                    ? "This period hasn't been computed yet — hit Refresh above to pull it."
                    : "Run a Sync (or the monthly aggregate) to populate this section."}
                </CardContent>
              </Card>
            )}

            {/* NEW BUSINESS — customers & subscriptions added in the period; drives the forecast growth rate */}
            {cd ? (
              <>
                <div className="flex items-center justify-between pt-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {periodView ? `New Business · ${periodView.label}` : "New Business This Month"}
                  </p>
                  <p className="text-xs text-muted-foreground/50">records created this period · drives the forecast growth rate</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Card className="border-border/40 animate-fade-in">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <p className="text-[13px] text-muted-foreground font-medium">New Customers</p>
                          <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.newCustomers ?? 0).toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground/70">first-time accounts added</p>
                        </div>
                        <div className="p-2 rounded-lg bg-green-500/10 text-green-400"><UserPlus className="w-4 h-4" /></div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-border/40 animate-fade-in">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <p className="text-[13px] text-muted-foreground font-medium">New Subscriptions</p>
                          <p className="text-3xl font-bold text-foreground tracking-tight">{(cd.newSubscriptions ?? 0).toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground/70">recurring plans sold</p>
                        </div>
                        <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400"><FilePlus2 className="w-4 h-4" /></div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </>
            ) : null}
                </>
              );
            })()}

            {/* TECHNICIANS NEEDED — 12-month workforce forecast */}
            <div className="flex items-center justify-between pt-2 gap-3 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Technicians Needed — 12-Month Forecast</p>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs ${forecastGrowth.source === "auto" ? "text-emerald-400" : "text-muted-foreground/50"}`}
                  title={forecastGrowth.source === "auto"
                    ? "Growth is derived from your new-subscription trend vs. the same period last year. Type a monthly % to override."
                    : "Not enough year-over-year history for an auto rate — using your manual monthly growth %."}
                >
                  {forecastGrowth.source === "auto"
                    ? `Auto ${forecastGrowth.annualPct >= 0 ? "+" : ""}${forecastGrowth.annualPct}%/yr`
                    : "Manual growth"}
                </span>
                <span className="text-xs text-muted-foreground/40">·</span>
                <span className="text-xs text-muted-foreground/50" title="Override the auto rate. 0 = auto.">override %/mo</span>
                <input
                  value={growthPct}
                  onChange={(e) => setGrowthPct(e.target.value.replace(/[^0-9.\-]/g, ""))}
                  inputMode="decimal"
                  className="w-16 text-xs bg-card border border-border/50 rounded-md px-2 py-1.5 text-foreground text-right focus:outline-none focus:ring-1 focus:ring-blue-500/40"
                />
                <button
                  onClick={saveGrowthPct}
                  disabled={savingGrowth}
                  className="text-xs px-2 py-1 rounded-md border border-border/50 text-muted-foreground hover:bg-accent/30 disabled:opacity-50 transition-colors"
                >
                  {savingGrowth ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            <Card className="border-border/40 animate-fade-in">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground/60 border-b border-border/40">
                        <th className="py-2.5 pl-4 pr-4 font-medium">Month</th>
                        {TECH_CATEGORIES.map((cat) => (
                          <th key={cat.key} className="py-2.5 pr-4 font-medium text-right" title={cat.handles}>
                            {cat.label} <span className="text-muted-foreground/40 font-normal">({cat.perDay}/day)</span>
                          </th>
                        ))}
                        <th className="py-2.5 pr-4 font-medium text-right">Total hires</th>
                      </tr>
                    </thead>
                    <tbody>
                      {techForecast.map((row) => (
                        <tr key={row.month} className="border-b border-border/20 last:border-0">
                          <td className="py-2 pl-4 pr-4 text-foreground whitespace-nowrap">
                            {format(parseISO(`${row.month}-01`), "MMM yyyy")}
                          </td>
                          {TECH_CATEGORIES.map((cat) => {
                            const cell = row.byCategory[cat.key];
                            const partial = cell.need > 0 && cell.need < 1;
                            return (
                              <td key={cat.key} className="py-2 pr-4 text-right">
                                <span className={`font-semibold tabular-nums ${partial ? "text-amber-400" : ""}`}>
                                  {cell.workload > 0 && cell.need < 0.05 ? "<0.1" : cell.need.toFixed(1)}
                                </span>
                                <span className="text-[10px] text-muted-foreground/50 tabular-nums block leading-tight">
                                  {cell.workload.toLocaleString()} appts · hire {cell.hire}
                                </span>
                              </td>
                            );
                          })}
                          <td className="py-2 pr-4 text-right">
                            <span className="font-bold text-blue-400 tabular-nums">{row.totalHires}</span>
                            <span className="text-[10px] text-muted-foreground/50 tabular-nums block leading-tight">
                              need {row.totalNeed.toFixed(1)} · {row.totalWorkload.toLocaleString()} appts
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground/50 px-4 py-2.5 border-t border-border/30">
                  Numbers are FRACTIONAL techs needed (0.2 = ~4 days of work, not a full hire — shown amber). &quot;Hire&quot; and the Total
                  are whole people AFTER cross-coverage: a Termite tech&apos;s spare days cover Specialty; Specialty, Lawn &amp; Wildlife
                  spare days cover GPC — so a partial tech&apos;s remainder offsets headcount elsewhere. Current book projected onto each
                  month&apos;s seasonality · {MONTH_WORKING_DAYS} working days/month · capacities: GPC 14, Specialty 8, Lawn 12, Termite 5,
                  Wildlife 4 per day · Specialty includes Commercial, German Roach, and one-time/initial work; GPC includes
                  reservices &amp; follow-ups. Reservice, follow-up, one-time &amp; wildlife volume is projected per month from
                  last year&apos;s same month, scaled by the recent 3-month trend (falls back to a flat recent-3mo run rate when
                  there&apos;s no year-over-year history). Book growth is {forecastGrowth.source === "auto"
                    ? `auto-derived from your new-subscription trend (${forecastGrowth.annualPct >= 0 ? "+" : ""}${forecastGrowth.annualPct}%/yr)`
                    : "your manual monthly growth % (not enough year-over-year new-subscription history for an auto rate)"}
                  {recentDone.length === 0 ? " · no history cached yet — run a Sync or Refresh a 12+ month period to populate it" : ` · ${recentDone.length} month${recentDone.length !== 1 ? "s" : ""} of history`}.
                </p>
              </CardContent>
            </Card>

            {/* Jobs Due This Week chart */}
            <Card className="border-border/40 animate-fade-in">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Jobs Due This Week</CardTitle>
                <CardDescription className="text-xs">Scheduled jobs per day (next 7 days)</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={stats.jobsDueThisWeek} barSize={28}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", color: "hsl(var(--foreground))", fontSize: "13px" }}
                      cursor={{ fill: "hsl(var(--accent) / 0.3)" }}
                    />
                    <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* 8-week trend — efficiency over the last 8 weeks */}
            <Card className="border-border/40 animate-fade-in">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">8-Week Trend</CardTitle>
                <CardDescription className="text-xs">Weekly routing efficiency</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground/60 border-b border-border/40">
                      <th className="py-2 pr-4 font-medium">Week of</th>
                      <th className="py-2 pr-4 font-medium text-right">Routes</th>
                      <th className="py-2 pr-4 font-medium text-right">Stops/Route</th>
                      <th className="py-2 pr-4 font-medium text-right">Avg Drive</th>
                      <th className="py-2 font-medium text-right">Stops/Hr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.trend.map((row) => (
                      <tr key={row.label} className="border-b border-border/20 last:border-0">
                        <td className="py-2 pr-4 text-foreground">{row.label}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{row.routeCount}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{row.stopsPerRoute === null ? "—" : row.stopsPerRoute.toFixed(1)}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">{row.avgDriveTime === null ? "—" : `${Math.round(row.avgDriveTime)}m`}</td>
                        <td className="py-2 text-right text-muted-foreground">{row.stopsPerHour === null ? "—" : row.stopsPerHour.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
