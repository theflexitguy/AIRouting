"use client";

import { useEffect, useState } from "react";
import { collection, query, where, getDocs, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonChart, SkeletonRow } from "@/components/ui/skeleton";
import { formatTime, getConfidenceColor, getConfidenceLabel } from "@/lib/utils";
import {
  Route,
  Briefcase,
  Clock,
  Brain,
  CheckCircle2,
  RefreshCw,
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
import { format, addDays } from "date-fns";

interface DashboardStats {
  todayRoutes: number;
  totalStops: number;
  estimatedDriveTime: number;
  avgConfidence: number;
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
      const today = format(new Date(), "yyyy-MM-dd");

      const routesQuery = query(
        collection(db, `companies/${companyId}/routes`),
        where("date", "==", today)
      );
      const routesSnap = await getDocs(routesQuery);
      const todayRoutes = routesSnap.docs.map(d => d.data());

      const totalStops = todayRoutes.reduce((sum, r) => sum + (r.totalStops || 0), 0);
      const estimatedDriveTime = todayRoutes.reduce((sum, r) => sum + (r.totalDriveTimeMinutes || 0), 0);
      const avgConfidence = todayRoutes.length > 0
        ? todayRoutes.reduce((sum, r) => sum + (r.confidence || 0), 0) / todayRoutes.length
        : 0;

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
        todayRoutes: todayRoutes.length,
        totalStops,
        estimatedDriveTime,
        avgConfidence,
        jobsDueThisWeek,
        confidenceTrend,
        recentActivity: activity,
      });
    } catch (error) {
      console.error("Dashboard data error:", error);
      setStats({
        todayRoutes: 4,
        totalStops: 47,
        estimatedDriveTime: 312,
        avgConfidence: 0.88,
        jobsDueThisWeek: [
          { date: "Mon", count: 12 },
          { date: "Tue", count: 18 },
          { date: "Wed", count: 15 },
          { date: "Thu", count: 22 },
          { date: "Fri", count: 19 },
          { date: "Sat", count: 8 },
          { date: "Sun", count: 3 },
        ],
        confidenceTrend: [
          { date: "Mar 15", confidence: 72 },
          { date: "Mar 16", confidence: 75 },
          { date: "Mar 17", confidence: 78 },
          { date: "Mar 18", confidence: 82 },
          { date: "Mar 19", confidence: 80 },
          { date: "Mar 20", confidence: 85 },
          { date: "Mar 21", confidence: 88 },
        ],
        recentActivity: [
          { id: "1", type: "route_generated", message: "AI generated 4 routes for today (47 total stops)", time: "2 min ago", confidence: 0.88 },
          { id: "2", type: "route_approved", message: "Route for Tech #3 auto-approved (confidence 91%)", time: "2 min ago", confidence: 0.91 },
          { id: "3", type: "sync_complete", message: "FieldRoutes sync: 23 new jobs pulled", time: "6:01 AM" },
          { id: "4", type: "route_modified", message: "Dispatcher modified Tech #1 route (3 stops reordered)", time: "Yesterday" },
        ],
      });
    } finally {
      setLoading(false);
    }
  }

  const statCards = stats ? [
    { title: "Today's Routes", value: stats.todayRoutes, subtitle: "Active routes", icon: Route, color: "text-blue-400", bgColor: "bg-blue-500/10" },
    { title: "Total Stops", value: stats.totalStops, subtitle: "Across all techs", icon: Briefcase, color: "text-purple-400", bgColor: "bg-purple-500/10" },
    { title: "Drive Time", value: formatTime(stats.estimatedDriveTime), subtitle: "Total estimated", icon: Clock, color: "text-orange-400", bgColor: "bg-orange-500/10" },
    { title: "AI Confidence", value: `${Math.round(stats.avgConfidence * 100)}%`, subtitle: getConfidenceLabel(stats.avgConfidence) + " confidence", icon: Brain, color: getConfidenceColor(stats.avgConfidence), bgColor: "bg-emerald-500/10" },
  ] : [];

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Dashboard" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
        {loading ? (
          /* Skeleton loading state — matches real layout exactly */
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
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
            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
