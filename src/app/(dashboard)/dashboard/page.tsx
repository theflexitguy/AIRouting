"use client";

import { useEffect, useState } from "react";
import { collection, query, where, getDocs, orderBy, limit, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatTime, getConfidenceColor, getConfidenceLabel } from "@/lib/utils";
import {
  Route,
  Briefcase,
  Clock,
  TrendingUp,
  Brain,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import {
  LineChart,
  Line,
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
import { format, addDays, startOfDay } from "date-fns";

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

      // Today's routes
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

      // Jobs due in next 7 days
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

      // Recent routes for confidence trend
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

      // Recent activity (mock + real)
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
      // Provide demo data when Firestore is unavailable
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

  const StatCard = ({ title, value, subtitle, icon: Icon, color = "text-blue-400" }: {
    title: string; value: string | number; subtitle: string; icon: React.ElementType; color?: string;
  }) => (
    <Card className="border-border/50">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold text-foreground mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          </div>
          <div className={`p-2 rounded-lg bg-accent ${color}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Dashboard" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6 animate-fade-in">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : stats ? (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard title="Today's Routes" value={stats.todayRoutes} subtitle="Active routes" icon={Route} color="text-blue-400" />
              <StatCard title="Total Stops" value={stats.totalStops} subtitle="Across all techs" icon={Briefcase} color="text-purple-400" />
              <StatCard title="Drive Time" value={formatTime(stats.estimatedDriveTime)} subtitle="Total estimated" icon={Clock} color="text-orange-400" />
              <StatCard
                title="AI Confidence"
                value={`${Math.round(stats.avgConfidence * 100)}%`}
                subtitle={getConfidenceLabel(stats.avgConfidence) + " confidence"}
                icon={Brain}
                color={getConfidenceColor(stats.avgConfidence)}
              />
            </div>

            {/* Charts row */}
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Jobs Due This Week</CardTitle>
                  <CardDescription>Scheduled jobs per day</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stats.jobsDueThisWeek} barSize={24}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", color: "hsl(var(--foreground))" }}
                        cursor={{ fill: "hsl(var(--accent))" }}
                      />
                      <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">AI Confidence Trend</CardTitle>
                  <CardDescription>Route confidence over time</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={stats.confidenceTrend}>
                      <defs>
                        <linearGradient id="confidenceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", color: "hsl(var(--foreground))" }}
                        formatter={(val) => [`${val}%`, "Confidence"]}
                      />
                      <Area type="monotone" dataKey="confidence" stroke="#3b82f6" strokeWidth={2} fill="url(#confidenceGrad)" dot={{ fill: "#3b82f6", strokeWidth: 0, r: 3 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* Activity feed */}
            <Card className="border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Recent Activity</CardTitle>
                <CardDescription>Latest routing events</CardDescription>
              </CardHeader>
              <CardContent>
                {stats.recentActivity.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-8">No recent activity. Generate your first routes to get started.</p>
                ) : (
                  <div className="space-y-3">
                    {stats.recentActivity.map((item) => {
                      const Icon = activityIcons[item.type];
                      const color = activityColors[item.type];
                      return (
                        <div key={item.id} className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0">
                          <div className={`mt-0.5 shrink-0 ${color}`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground">{item.message}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{item.time}</p>
                          </div>
                          {item.confidence !== undefined && (
                            <Badge variant={item.confidence >= 0.85 ? "success" : item.confidence >= 0.6 ? "warning" : "destructive"}>
                              {Math.round(item.confidence * 100)}%
                            </Badge>
                          )}
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
