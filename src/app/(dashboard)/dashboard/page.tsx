"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonCard, SkeletonChart } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatTime } from "@/lib/utils";
import { formatCurrency } from "@/lib/production-value";
import {
  stopsPerRoute,
  stopsPerHour,
  avgDriveTime,
  monthlyServiced,
  weeklyPace,
  monthlyTargetsByLine,
  isTrackedServiceLine,
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
  estimatedDriveTime: number;
  totalRouteValue: number;
  avgRouteValue: number;
  todayStopsPerHour: number | null;
  overdueStops: number;
  weekKpis: WeekKpis;
  lineTargets: LineTarget[];
  monthlyTarget: number;
  weeklyTarget: number;
  dailyTarget: number;
  pace: MonthlyPace;
  weekPace: MonthlyPace;
  trend: TrendRow[];
  jobsDueThisWeek: Array<{ date: string; count: number }>;
}

// Raw doc shapes the dashboard fetches once, then filters/derives client-side.
interface RouteRec extends RouteLike {
  date: string;
  techId?: string;
  techName?: string;
  routeGroupTitle?: string;
  routeValue?: number;
}
interface JobRec extends JobLike {
  status?: string;
  overdueActionable?: boolean;
}
interface TechOption {
  id: string;
  name: string;
  employeeId?: string;
  fieldRoutesEmployeeId?: string;
  fieldRoutesTechId?: string;
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

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

  // Filters
  const [dateFilterEnabled, setDateFilterEnabled] = useState(false);
  const [dateFrom, setDateFrom] = useState(() => format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(today);
  const [filterTech, setFilterTech] = useState("all");
  const [filterGroup, setFilterGroup] = useState("all");
  const [rangeRoutes, setRangeRoutes] = useState<RouteRec[] | null>(null);

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
      setRawJobs(jobsSnap.docs.map(d => d.data() as JobRec));

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
    } catch (error) {
      console.error("Dashboard data error:", error);
      setRawRoutes([]);
      setRawJobs([]);
    } finally {
      setLoading(false);
    }
  }

  // Fetch routes for a custom date range only while that filter is enabled.
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
  }, [userProfile, dateFilterEnabled, dateFrom, dateTo]);

  // Identifier set for the selected technician (matched against route/job fields).
  const techKeys = useMemo(() => {
    if (filterTech === "all") return new Set<string>();
    const t = techs.find(x => x.id === filterTech);
    return new Set([t?.id, t?.name, t?.employeeId, t?.fieldRoutesEmployeeId, t?.fieldRoutesTechId].map(norm).filter(Boolean));
  }, [filterTech, techs]);

  const filtersActive = dateFilterEnabled || filterTech !== "all" || filterGroup !== "all";

  // Apply technician + route-group filters to a set of routes.
  const filterRoutes = useMemo(() => {
    return (routes: RouteRec[]) => routes.filter(r => {
      // Match on the canonical bucket so every FieldRoutes spelling variant of a
      // group (GPC/gpc, Wildlife/WILD LIFE, …) is included under one selection.
      if (filterGroup !== "all" && canonicalRouteGroup(String(r.routeGroupTitle || "")) !== filterGroup) return false;
      if (!routeMatchesTech(r, techKeys)) return false;
      return true;
    });
  }, [filterGroup, techKeys]);

  const stats: DashboardStats = useMemo(() => {
    // Route set for the "Today" cards: the custom range when the date filter is
    // on, otherwise today's routes. KPIs use this week's routes (or the range).
    const todaySet = filterRoutes(
      dateFilterEnabled ? (rangeRoutes ?? []) : rawRoutes.filter(r => r.date === today)
    );
    const kpiSet = filterRoutes(
      dateFilterEnabled ? (rangeRoutes ?? []) : rawRoutes.filter(r => r.date >= bounds.weekStart && r.date <= bounds.weekEnd)
    );

    const totalStops = todaySet.reduce((s, r) => s + (r.totalStops || 0), 0);
    const estimatedDriveTime = todaySet.reduce((s, r) => s + (r.totalDriveTimeMinutes || 0), 0);
    const totalRouteValue = todaySet.reduce((s, r) => s + (Number(r.routeValue) || 0), 0);
    const avgRouteValue = todaySet.length > 0 ? totalRouteValue / todaySet.length : 0;

    // Overdue + targets stay company-wide (subscriptions aren't tied to a route
    // group, and overdue subs are typically unassigned).
    const overdueStops = new Set(
      rawJobs.filter(j => j.overdueActionable).map(j => String(j.customerId))
    ).size;

    // Per-service-line monthly targets (General Pest / Mosquito / Lawn / Termite /
    // Commercial) plus a combined Total. GR + Wildlife are excluded (one-time /
    // auto-scheduled). Weekly + Daily derive from the tracked-line Total.
    const lineTargets = monthlyTargetsByLine(rawJobs, bounds.monthIndex, bounds.monthStart, today);
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
      estimatedDriveTime,
      totalRouteValue,
      avgRouteValue,
      todayStopsPerHour: stopsPerHour(todaySet),
      overdueStops,
      weekKpis,
      lineTargets,
      monthlyTarget,
      weeklyTarget,
      dailyTarget,
      pace,
      weekPace,
      trend,
      jobsDueThisWeek,
    };
  }, [rawRoutes, rawJobs, rangeRoutes, dateFilterEnabled, filterRoutes, bounds, today]);

  const routeWindowLabel = dateFilterEnabled ? "Selected range" : "Today";
  const kpiWindowLabel = dateFilterEnabled ? "Selected range" : "This Week";
  const fmt1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));

  // TODAY cards (route-derived; respect the filters).
  const todayCards = [
    { title: "Routes", value: String(stats.todayRoutes), subtitle: `${routeWindowLabel} · active routes`, icon: Route, color: "text-blue-400", bgColor: "bg-blue-500/10" },
    { title: "Total Stops", value: String(stats.totalStops), subtitle: `${routeWindowLabel} · all techs`, icon: Briefcase, color: "text-purple-400", bgColor: "bg-purple-500/10" },
    { title: "Drive Time", value: formatTime(stats.estimatedDriveTime), subtitle: `${routeWindowLabel} · total`, icon: Clock, color: "text-orange-400", bgColor: "bg-orange-500/10" },
    { title: "Total Route Value", value: formatCurrency(stats.totalRouteValue), subtitle: `${routeWindowLabel} · all routes`, icon: DollarSign, color: "text-emerald-400", bgColor: "bg-emerald-500/10" },
    { title: "Avg Route Value", value: formatCurrency(stats.avgRouteValue), subtitle: `${routeWindowLabel} · per route`, icon: TrendingUp, color: "text-teal-400", bgColor: "bg-teal-500/10" },
    { title: "Stops / Hour", value: fmt1(stats.todayStopsPerHour), subtitle: `${routeWindowLabel} · per working hour`, icon: Activity, color: "text-yellow-400", bgColor: "bg-yellow-500/10" },
  ];

  // THIS WEEK efficiency KPIs vs targets.
  const weekCards = [
    { title: "Stops / Route", value: fmt1(stats.weekKpis.stopsPerRoute), target: `≥ ${STOPS_PER_ROUTE_TARGET}`, ok: meetsTarget(stats.weekKpis.stopsPerRoute, STOPS_PER_ROUTE_TARGET) },
    { title: "Stops / Hour", value: fmt1(stats.weekKpis.stopsPerHour), target: `≥ ${STOPS_PER_HOUR_TARGET.toFixed(1)}`, ok: meetsTarget(stats.weekKpis.stopsPerHour, STOPS_PER_HOUR_TARGET) },
    { title: "Avg Drive Time", value: stats.weekKpis.avgDriveTime === null ? "—" : `${Math.round(stats.weekKpis.avgDriveTime)}m`, target: `< ${DRIVE_TIME_TARGET}m`, ok: meetsTarget(stats.weekKpis.avgDriveTime, DRIVE_TIME_TARGET, true) },
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
                  </>
                )}
                <Select value={filterTech} onValueChange={setFilterTech}>
                  <SelectTrigger className="w-full sm:w-44 h-8 text-xs"><SelectValue placeholder="Technician" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Technicians</SelectItem>
                    {techs.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filterGroup} onValueChange={setFilterGroup}>
                  <SelectTrigger className="w-full sm:w-44 h-8 text-xs"><SelectValue placeholder="Route group" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Route Groups</SelectItem>
                    {groupOptions.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                  </SelectContent>
                </Select>
                {filtersActive && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground/60 hover:text-foreground underline underline-offset-2 ml-auto"
                    onClick={() => { setDateFilterEnabled(false); setFilterTech("all"); setFilterGroup("all"); }}
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
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
              {todayCards.map((stat, i) => {
                const Icon = stat.icon;
                return (
                  <Card key={stat.title} className={`border-border/40 animate-fade-in stagger-${i + 1}`}>
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <p className="text-[13px] text-muted-foreground font-medium">{stat.title}</p>
                          <p className="text-2xl font-bold text-foreground tracking-tight">{stat.value}</p>
                          <p className="text-xs text-muted-foreground/70">{stat.subtitle}</p>
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
            <div className="grid grid-cols-3 gap-4">
              {weekCards.map((kpi) => {
                const color = kpi.ok === null ? "text-muted-foreground/50" : kpi.ok ? "text-emerald-400" : "text-red-400";
                return (
                  <Card key={kpi.title} className="border-border/40 animate-fade-in">
                    <CardContent className="p-5">
                      <p className="text-[13px] text-muted-foreground font-medium">{kpi.title}</p>
                      <p className={`text-2xl font-bold tracking-tight ${color}`}>{kpi.value}</p>
                      <p className="text-xs text-muted-foreground/70">Target {kpi.target}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* TARGETS — seasonality-aware monthly service targets per service line */}
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Monthly Targets by Service</p>
              <p className="text-xs text-muted-foreground/50">{format(parseISO(today), "MMMM")} · company-wide</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {stats.lineTargets.map((lt) => {
                const donePct = Math.round(lt.pace.donePct * 100);
                const progressPct = Math.round(lt.pace.progressPct * 100);
                const isTotal = lt.line === "total";
                return (
                  <Card key={lt.line} className={`border-border/40 animate-fade-in ${isTotal ? "ring-1 ring-blue-500/40 bg-blue-500/[0.03]" : ""}`}>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-[13px] text-muted-foreground font-medium">{isTotal ? "Total (All)" : lt.label}</p>
                          <p className="text-3xl font-bold text-foreground tracking-tight">{lt.target.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground/70">{lt.pace.done.toLocaleString()} done · {lt.pace.remaining.toLocaleString()} left</p>
                        </div>
                        <div className={`p-2 rounded-lg ${isTotal ? "bg-blue-500/10 text-blue-400" : "bg-accent/40 text-muted-foreground"}`}><Target className="w-4 h-4" /></div>
                      </div>
                      <div className="space-y-1">
                        <Progress value={Math.min(100, donePct)} className="h-2" />
                        <p className={`text-xs ${lt.pace.ahead ? "text-emerald-400" : "text-red-400"}`}>
                          {donePct}% of target · {progressPct}% through month · {lt.pace.ahead ? "on/ahead of pace" : "behind pace"}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Weekly + Daily — derived from the tracked-line Total */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Weekly target — with the same %-of-target pace as Monthly */}
              <Card className="border-border/40 animate-fade-in">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[13px] text-muted-foreground font-medium">Weekly Target</p>
                      <p className="text-3xl font-bold text-foreground tracking-tight">{stats.weeklyTarget.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground/70">{stats.weekPace.done.toLocaleString()} done · {stats.weekPace.remaining.toLocaleString()} left</p>
                    </div>
                    <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400"><Gauge className="w-4 h-4" /></div>
                  </div>
                  <div className="space-y-1">
                    <Progress value={Math.min(100, weekDonePct)} className="h-2" />
                    <p className={`text-xs ${stats.weekPace.ahead ? "text-emerald-400" : "text-red-400"}`}>
                      {weekDonePct}% of target · {weekProgressPct}% through week · {stats.weekPace.ahead ? "on/ahead of pace" : "behind pace"}
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
                    </div>
                    <div className="p-2 rounded-lg bg-teal-500/10 text-teal-400"><CalendarDays className="w-4 h-4" /></div>
                  </div>
                </CardContent>
              </Card>
            </div>

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
