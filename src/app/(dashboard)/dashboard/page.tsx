"use client";

import { useEffect, useState } from "react";
import { collection, query, where, getDocs, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonChart } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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

const EMPTY_PACE: Pace = { target: 0, done: 0, remaining: 0, pct: 0 };
const EMPTY_WEEK_KPIS: WeekKpis = {
  stopsPerRoute: null,
  stopsPerHour: null,
  avgDriveTime: null,
  stopVariance: null,
  completionRate: null,
  routeCount: 0,
};

export default function DashboardPage() {
  const { userProfile } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadDashboardData(userProfile.companyId);
  }, [userProfile]);

  async function loadDashboardData(companyId: string) {
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

      const routesQuery = query(
        collection(db, `companies/${companyId}/routes`),
        where("date", "==", today)
      );
      const routesSnap = await getDocs(routesQuery);
      const todayRoutes = routesSnap.docs.map(d => d.data());

      // FieldRoutes-scheduled appointments are materialized into real route docs
      // by the sync (see reconcileScheduledRoutes), so counting route docs here
      // already includes them alongside AI-generated routes — no separate
      // scheduled-jobs tally needed (that would double-count).
      const routesToday = todayRoutes.length;
      const totalStops = todayRoutes.reduce((sum, r) => sum + (r.totalStops || 0), 0);
      const estimatedDriveTime = todayRoutes.reduce((sum, r) => sum + (r.totalDriveTimeMinutes || 0), 0);
      const avgConfidence = todayRoutes.length > 0
        ? todayRoutes.reduce((sum, r) => sum + (r.confidence || 0), 0) / todayRoutes.length
        : 0;

      // Overdue Stops = distinct CUSTOMERS with at least one overdueActionable
      // subscription. FieldRoutes' "Customers Due For Service" counts by customer,
      // so we deduplicate by customerId to match. Routing still operates on
      // individual subscriptions — this only affects the dashboard display number.
      const jobsCol = collection(db, `companies/${companyId}/jobs`);
      const overdueSnap = await getDocs(
        query(jobsCol, where("overdueActionable", "==", true))
      );
      const overdueCustomerIds = new Set(
        overdueSnap.docs.map(d => d.data().customerId as string)
      );
      const overdueStops = overdueCustomerIds.size;

      // --- Period boundaries (calendar dates; compared as YYYY-MM-DD strings) ---
      const todayDate = parseISO(today);
      const weekStart = format(startOfWeek(todayDate, { weekStartsOn: 1 }), "yyyy-MM-dd");
      const weekEnd = format(endOfWeek(todayDate, { weekStartsOn: 1 }), "yyyy-MM-dd");
      const monthStart = format(startOfMonth(todayDate), "yyyy-MM-dd");
      const monthEnd = format(endOfMonth(todayDate), "yyyy-MM-dd");

      // --- THIS WEEK KPIs (auto-computed from this week's route docs) ---
      const weekRoutesSnap = await getDocs(
        query(
          collection(db, `companies/${companyId}/routes`),
          where("date", ">=", weekStart),
          where("date", "<=", weekEnd)
        )
      );
      const weekRoutes = weekRoutesSnap.docs.map(d => d.data() as RouteLike);

      // --- Pace: one broad read of the active base, reused for month + week ---
      const allJobsSnap = await getDocs(query(jobsCol, where("inScope", "==", true)));
      const allJobs = allJobsSnap.docs.map(d => d.data() as JobLike);
      const monthlyPace = paceFor(allJobs, monthStart, monthEnd, today);
      const weeklyPace = paceFor(allJobs, weekStart, weekEnd, today);

      const weekKpis: WeekKpis = {
        stopsPerRoute: stopsPerRoute(weekRoutes),
        stopsPerHour: stopsPerHour(weekRoutes),
        avgDriveTime: avgDriveTime(weekRoutes),
        stopVariance: stopVariance(weekRoutes),
        // Completion rate this week = subs serviced ÷ subs due this week.
        completionRate: completionRate(weeklyPace.done, weeklyPace.target),
        routeCount: weekRoutes.length,
      };

      // --- 8-week trend (auto-derived from the last 8 weeks of route docs) ---
      const trendStart = format(startOfWeek(subWeeks(todayDate, 7), { weekStartsOn: 1 }), "yyyy-MM-dd");
      const trendRoutesSnap = await getDocs(
        query(
          collection(db, `companies/${companyId}/routes`),
          where("date", ">=", trendStart),
          where("date", "<=", weekEnd)
        )
      );
      const trendRoutes = trendRoutesSnap.docs.map(d => d.data() as RouteLike & { date?: string });
      const trend: TrendRow[] = [];
      for (let w = 7; w >= 0; w--) {
        const wkStartDate = startOfWeek(subWeeks(todayDate, w), { weekStartsOn: 1 });
        const wkStart = format(wkStartDate, "yyyy-MM-dd");
        const wkEnd = format(endOfWeek(wkStartDate, { weekStartsOn: 1 }), "yyyy-MM-dd");
        const wkRoutes = trendRoutes.filter(r => {
          const d = String(r.date || "");
          return d >= wkStart && d <= wkEnd;
        });
        trend.push({
          label: format(wkStartDate, "MMM d"),
          routeCount: wkRoutes.length,
          stopsPerRoute: stopsPerRoute(wkRoutes),
          avgDriveTime: avgDriveTime(wkRoutes),
          stopVariance: stopVariance(wkRoutes),
          stopsPerHour: stopsPerHour(wkRoutes),
        });
      }

      const jobsDueThisWeek = [];
      for (let i = 0; i < 7; i++) {
        const d = format(addDays(new Date(), i), "yyyy-MM-dd");
        const jq = query(
          collection(db, `companies/${companyId}/jobs`),
          where("scheduledDate", "==", d),
          where("status", "in", ["pending", "scheduled"])
        );
        const jsnap = await getDocs(jq);
        jobsDueThisWeek.push({ date: format(addDays(new Date(), i), "EEE"), count: jsnap.size });
      }

      const recentRoutesQuery = query(
        collection(db, `companies/${companyId}/routes`),
        orderBy("createdAt", "desc"),
        limit(14)
      );
      const recentRoutesSnap = await getDocs(recentRoutesQuery);
      const confidenceTrend = recentRoutesSnap.docs.map(d => ({
        date: d.data().date || today,
        confidence: Math.round((d.data().confidence || 0) * 100),
      })).reverse();

      const activity: DashboardStats["recentActivity"] = todayRoutes.slice(0, 5).map((r, i) => ({
        id: `route-${i}`,
        type: r.generatedBy === "ai" ? "route_generated" : "route_modified",
        message: r.generatedBy === "ai"
          ? `AI generated route for ${r.totalStops} stops`
          : `Route manually updated (${r.totalStops} stops)`,
        time: "Today",
        confidence: r.confidence,
      }));

      setStats({
        todayRoutes: routesToday,
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
        recentActivity: activity,
      });
    } catch (error) {
      console.error("Dashboard data error:", error);
      // Show empty state when Firestore is unavailable
      setStats({
        todayRoutes: 0,
        totalStops: 0,
        overdueStops: 0,
        estimatedDriveTime: 0,
        avgConfidence: 0,
        weekKpis: EMPTY_WEEK_KPIS,
        monthlyPace: EMPTY_PACE,
        weeklyPace: EMPTY_PACE,
        trend: [],
        jobsDueThisWeek: [],
        confidenceTrend: [],
        recentActivity: [],
      });
    } finally {
      setLoading(false);
    }
  }

  const statCards = stats ? [
    { title: "Today's Routes", value: stats.todayRoutes, subtitle: "Active routes", icon: Route, color: "text-blue-400", bgColor: "bg-blue-500/10" },
    { title: "Overdue Stops", value: stats.overdueStops, subtitle: "Past due 30+ days", icon: AlertTriangle, color: "text-red-400", bgColor: "bg-red-500/10" },
    { title: "Total Stops", value: stats.totalStops, subtitle: "Across all techs", icon: Briefcase, color: "text-purple-400", bgColor: "bg-purple-500/10" },
    { title: "Drive Time", value: formatTime(stats.estimatedDriveTime), subtitle: "Total estimated", icon: Clock, color: "text-orange-400", bgColor: "bg-orange-500/10" },
    { title: "AI Confidence", value: `${Math.round(stats.avgConfidence * 100)}%`, subtitle: getConfidenceLabel(stats.avgConfidence) + " confidence", icon: Brain, color: getConfidenceColor(stats.avgConfidence), bgColor: "bg-emerald-500/10" },
  ] : [];

  // THIS WEEK KPI cards. Each shows the value vs its target; green when on target,
  // red when missing it, and a muted "—" when there's no route data yet.
  const fmt1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  const kpiCards = stats ? [
    { title: "Stops / Route", value: fmt1(stats.weekKpis.stopsPerRoute), target: `≥ ${STOPS_PER_ROUTE_TARGET}`, ok: meetsTarget(stats.weekKpis.stopsPerRoute, STOPS_PER_ROUTE_TARGET) },
    { title: "Stops / Hour", value: fmt1(stats.weekKpis.stopsPerHour), target: `≥ ${STOPS_PER_HOUR_TARGET.toFixed(1)}`, ok: meetsTarget(stats.weekKpis.stopsPerHour, STOPS_PER_HOUR_TARGET) },
    { title: "Avg Drive Time", value: stats.weekKpis.avgDriveTime === null ? "—" : `${Math.round(stats.weekKpis.avgDriveTime)}m`, target: `< ${DRIVE_TIME_TARGET}m`, ok: meetsTarget(stats.weekKpis.avgDriveTime, DRIVE_TIME_TARGET, true) },
    { title: "Stop Variance", value: stats.weekKpis.stopVariance === null ? "—" : String(stats.weekKpis.stopVariance), target: `≤ ${STOP_VARIANCE_TARGET}`, ok: meetsTarget(stats.weekKpis.stopVariance, STOP_VARIANCE_TARGET, true) },
    { title: "Completion Rate", value: stats.weekKpis.completionRate === null ? "—" : `${Math.round(stats.weekKpis.completionRate * 100)}%`, target: `≥ ${Math.round(COMPLETION_RATE_TARGET * 100)}%`, ok: meetsTarget(stats.weekKpis.completionRate, COMPLETION_RATE_TARGET) },
  ] : [];

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
            {/* TODAY — operational snapshot */}
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">Today</p>
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
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">This Week</p>
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
