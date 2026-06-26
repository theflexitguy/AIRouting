"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonChart } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatTime, getConfidenceColor, getConfidenceLabel } from "@/lib/utils";
import {
  stopsPerRoute,
  stopsPerHour,
  avgDriveTime,
  stopVariance,
  completionRate,
  paceFor,
  meetsTarget,
  STOPS_PER_ROUTE_TARGET,
  STOPS_PER_HOUR_TARGET,
  DRIVE_TIME_TARGET,
  STOP_VARIANCE_TARGET,
  COMPLETION_RATE_TARGET,
  type RouteLike,
  type JobLike,
  type Pace,
} from "@/lib/metrics/operational";
import {
  Route,
  Briefcase,
  Clock,
  Brain,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  Target,
  Gauge,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
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
  stopVariance: number | null;
  completionRate: number | null;
  routeCount: number;
}

interface TrendRow {
  label: string; // week start, e.g. "Jun 1"
  routeCount: number;
  stopsPerRoute: number | null;
  avgDriveTime: number | null;
  stopVariance: number | null;
  stopsPerHour: number | null;
}

interface DashboardStats {
  todayRoutes: number;
  totalStops: number;
  overdueStops: number;
  estimatedDriveTime: number;
  avgConfidence: number;
  weekKpis: WeekKpis;
  monthlyPace: Pace;
  weeklyPace: Pace;
  trend: TrendRow[];
  jobsDueThisWeek: Array<{ date: string; count: number }>;
  confidenceTrend: Array<{ date: string; confidence: number }>;
  recentActivity: Array<{
    id: string;
    type: "route_generated" | "route_approved" | "route_modified" | "sync_complete";
    message: string;
    time: string;
    confidence?: number;
  }>;
}

const activityIcons = {
  route_generated: Brain,
  route_approved: CheckCircle2,
  route_modified: RefreshCw,
  sync_complete: Briefcase,
};

const activityColors = {
  route_generated: "text-blue-400",
  route_approved: "text-emerald-400",
  route_modified: "text-yellow-400",
  sync_complete: "text-purple-400",
};

// Raw doc shapes the dashboard fetches once, then filters/derives client-side.
interface RouteRec extends RouteLike {
  date: string;
  confidence?: number;
  generatedBy?: string;
  techId?: string;
  techName?: string;
  routeGroupTitle?: string;
}
interface JobRec extends JobLike {
  status?: string;
  overdueActionable?: boolean;
  fieldRoutesServicedById?: string;
  fieldRoutesServicedBy?: string;
  assignedTechId?: string;
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
      // includes today + this week); one inScope jobs read for overdue + pace.
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
      if (filterGroup !== "all" && String(r.routeGroupTitle || "") !== filterGroup) return false;
      if (!routeMatchesTech(r, techKeys)) return false;
      return true;
    });
  }, [filterGroup, techKeys]);

  const stats: DashboardStats = useMemo(() => {
    // Route set for the "Today" cards + KPIs: the custom range when the date
    // filter is on, otherwise today's routes (cards) / this week's (KPIs).
    const todaySet = filterRoutes(
      dateFilterEnabled ? (rangeRoutes ?? []) : rawRoutes.filter(r => r.date === today)
    );
    const kpiSet = filterRoutes(
      dateFilterEnabled ? (rangeRoutes ?? []) : rawRoutes.filter(r => r.date >= bounds.weekStart && r.date <= bounds.weekEnd)
    );

    const totalStops = todaySet.reduce((s, r) => s + (r.totalStops || 0), 0);
    const estimatedDriveTime = todaySet.reduce((s, r) => s + (r.totalDriveTimeMinutes || 0), 0);
    const avgConfidence = todaySet.length > 0
      ? todaySet.reduce((s, r) => s + (r.confidence || 0), 0) / todaySet.length
      : 0;

    // Overdue + pace stay company-wide (subscriptions aren't tied to a route
    // group, and overdue subs are typically unassigned).
    const overdueStops = new Set(
      rawJobs.filter(j => j.overdueActionable).map(j => String(j.customerId))
    ).size;
    const monthlyPace = paceFor(rawJobs, bounds.monthStart, bounds.monthEnd, today);
    const weeklyPace = paceFor(rawJobs, bounds.weekStart, bounds.weekEnd, today);

    const weekKpis: WeekKpis = {
      stopsPerRoute: stopsPerRoute(kpiSet),
      stopsPerHour: stopsPerHour(kpiSet),
      avgDriveTime: avgDriveTime(kpiSet),
      stopVariance: stopVariance(kpiSet),
      completionRate: completionRate(weeklyPace.done, weeklyPace.target),
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
        stopVariance: stopVariance(wk),
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

    const confidenceTrend = [...trendSet]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14)
      .map(r => ({ date: r.date, confidence: Math.round((r.confidence || 0) * 100) }));

    const recentActivity: DashboardStats["recentActivity"] = todaySet.slice(0, 5).map((r, i) => ({
      id: `route-${i}`,
      type: r.generatedBy === "ai" ? "route_generated" : "route_modified",
      message: r.generatedBy === "ai"
        ? `AI generated route for ${r.totalStops} stops`
        : `Route updated (${r.totalStops} stops)`,
      time: "Today",
      confidence: r.confidence,
    }));

    return {
      todayRoutes: todaySet.length,
      totalStops,
      overdueStops,
      estimatedDriveTime,
      avgConfidence,
      weekKpis,
      monthlyPace,
      weeklyPace,
      trend,
      jobsDueThisWeek,
      confidenceTrend,
      recentActivity,
    };
  }, [rawRoutes, rawJobs, rangeRoutes, dateFilterEnabled, filterRoutes, bounds, today]);

  const routeWindowLabel = dateFilterEnabled ? "Selected range" : "Today";
  const kpiWindowLabel = dateFilterEnabled ? "Selected range" : "This Week";

  const statCards = [
    { title: "Routes", value: stats.todayRoutes, subtitle: `${routeWindowLabel} · active routes`, icon: Route, color: "text-blue-400", bgColor: "bg-blue-500/10" },
    { title: "Overdue Stops", value: stats.overdueStops, subtitle: filtersActive ? "Past due 30+ days · company-wide" : "Past due 30+ days", icon: AlertTriangle, color: "text-red-400", bgColor: "bg-red-500/10" },
    { title: "Total Stops", value: stats.totalStops, subtitle: `${routeWindowLabel} · all techs`, icon: Briefcase, color: "text-purple-400", bgColor: "bg-purple-500/10" },
    { title: "Drive Time", value: formatTime(stats.estimatedDriveTime), subtitle: `${routeWindowLabel} · total`, icon: Clock, color: "text-orange-400", bgColor: "bg-orange-500/10" },
    { title: "AI Confidence", value: `${Math.round(stats.avgConfidence * 100)}%`, subtitle: getConfidenceLabel(stats.avgConfidence) + " confidence", icon: Brain, color: getConfidenceColor(stats.avgConfidence), bgColor: "bg-emerald-500/10" },
  ];

  // THIS WEEK KPI cards. Each shows the value vs its target; green when on target,
  // red when missing it, and a muted "—" when there's no route data yet.
  const fmt1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  const kpiCards = [
    { title: "Stops / Route", value: fmt1(stats.weekKpis.stopsPerRoute), target: `≥ ${STOPS_PER_ROUTE_TARGET}`, ok: meetsTarget(stats.weekKpis.stopsPerRoute, STOPS_PER_ROUTE_TARGET) },
    { title: "Stops / Hour", value: fmt1(stats.weekKpis.stopsPerHour), target: `≥ ${STOPS_PER_HOUR_TARGET.toFixed(1)}`, ok: meetsTarget(stats.weekKpis.stopsPerHour, STOPS_PER_HOUR_TARGET) },
    { title: "Avg Drive Time", value: stats.weekKpis.avgDriveTime === null ? "—" : `${Math.round(stats.weekKpis.avgDriveTime)}m`, target: `< ${DRIVE_TIME_TARGET}m`, ok: meetsTarget(stats.weekKpis.avgDriveTime, DRIVE_TIME_TARGET, true) },
    { title: "Stop Variance", value: stats.weekKpis.stopVariance === null ? "—" : String(stats.weekKpis.stopVariance), target: `≤ ${STOP_VARIANCE_TARGET}`, ok: meetsTarget(stats.weekKpis.stopVariance, STOP_VARIANCE_TARGET, true) },
    { title: "Completion Rate", value: stats.weekKpis.completionRate === null ? "—" : `${Math.round(stats.weekKpis.completionRate * 100)}%`, target: `≥ ${Math.round(COMPLETION_RATE_TARGET * 100)}%`, ok: meetsTarget(stats.weekKpis.completionRate, COMPLETION_RATE_TARGET) },
  ];

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Dashboard" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
        {loading ? (
          /* Skeleton loading state — matches real layout exactly */
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonCard key={i} className={`animate-fade-in stagger-${i + 1}`} />
              ))}
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <SkeletonChart className="animate-fade-in stagger-5" />
              <SkeletonChart className="animate-fade-in stagger-6" />
            </div>
          </div>
        ) : stats ? (
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
                  Tip: pull and select your route groups in Settings to filter KPIs by GPC / Specialty / Wildlife / Lawn.
                </p>
              )}
            </div>

            {/* TODAY — operational snapshot */}
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{routeWindowLabel}</p>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {statCards.map((stat, i) => {
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

            {/* THIS WEEK — efficiency KPIs vs targets (auto-computed) */}
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{kpiWindowLabel}</p>
              <p className="text-xs text-muted-foreground/50">{stats.weekKpis.routeCount} routes</p>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {kpiCards.map((kpi) => {
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

            {/* PACE — progress toward the auto-derived service target */}
            {filtersActive && (
              <p className="text-xs text-muted-foreground/50">Overdue & pace are company-wide (all groups & techs).</p>
            )}
            <div className="grid lg:grid-cols-2 gap-4">
              {[
                { label: "Monthly Target", sub: "Services due this month", pace: stats.monthlyPace, icon: Target, color: "text-blue-400", bg: "bg-blue-500/10" },
                { label: "Weekly Target", sub: "Services due this week", pace: stats.weeklyPace, icon: Gauge, color: "text-purple-400", bg: "bg-purple-500/10" },
              ].map((p) => {
                const Icon = p.icon;
                const pctRounded = Math.min(100, Math.round(p.pace.pct * 100));
                return (
                  <Card key={p.label} className="border-border/40 animate-fade-in">
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-[13px] text-muted-foreground font-medium">{p.label}</p>
                          <p className="text-3xl font-bold text-foreground tracking-tight">{p.pace.remaining} <span className="text-base font-medium text-muted-foreground/70">left</span></p>
                          <p className="text-xs text-muted-foreground/70">{p.pace.done} done · {p.pace.target} target</p>
                        </div>
                        <div className={`p-2 rounded-lg ${p.bg} ${p.color}`}>
                          <Icon className="w-4 h-4" />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Progress value={pctRounded} className="h-2" />
                        <p className="text-xs text-muted-foreground/60">{pctRounded}% complete · {p.sub}</p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Charts row */}
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-border/40 animate-fade-in stagger-5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Jobs Due This Week</CardTitle>
                  <CardDescription className="text-xs">Scheduled jobs per day</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stats.jobsDueThisWeek} barSize={20}>
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

              <Card className="border-border/40 animate-fade-in stagger-6">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">AI Confidence Trend</CardTitle>
                  <CardDescription className="text-xs">Route confidence over time</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={stats.confidenceTrend}>
                      <defs>
                        <linearGradient id="confidenceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} width={35} unit="%" />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", color: "hsl(var(--foreground))", fontSize: "13px" }}
                        formatter={(val) => [`${val}%`, "Confidence"]}
                      />
                      <Area type="monotone" dataKey="confidence" stroke="#3b82f6" strokeWidth={2} fill="url(#confidenceGrad)" dot={{ fill: "#3b82f6", strokeWidth: 0, r: 3 }} activeDot={{ r: 5, strokeWidth: 2, stroke: "#3b82f6", fill: "hsl(var(--background))" }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* 8-week trend — efficiency over the last 8 weeks (auto-derived) */}
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
                      <th className="py-2 pr-4 font-medium text-right">Variance</th>
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
                        <td className="py-2 pr-4 text-right text-muted-foreground">{row.stopVariance === null ? "—" : row.stopVariance}</td>
                        <td className="py-2 text-right text-muted-foreground">{row.stopsPerHour === null ? "—" : row.stopsPerHour.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Activity feed */}
            <Card className="border-border/40 animate-fade-in stagger-5">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Recent Activity</CardTitle>
                <CardDescription className="text-xs">Latest routing events</CardDescription>
              </CardHeader>
              <CardContent>
                {stats.recentActivity.length === 0 ? (
                  <div className="text-center py-10">
                    <Route className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-muted-foreground text-sm">No recent activity</p>
                    <p className="text-muted-foreground/60 text-xs mt-1">Generate your first routes to get started.</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {stats.recentActivity.map((item, i) => {
                      const Icon = activityIcons[item.type];
                      const color = activityColors[item.type];
                      return (
                        <div key={item.id} className={`flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-lg hover:bg-accent/30 transition-colors animate-fade-in stagger-${i + 1}`}>
                          <div className={`shrink-0 ${color}`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground">{item.message}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {item.confidence !== undefined && (
                              <Badge variant={item.confidence >= 0.85 ? "success" : item.confidence >= 0.6 ? "warning" : "destructive"} className="text-[11px]">
                                {Math.round(item.confidence * 100)}%
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground/60 whitespace-nowrap">{item.time}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
