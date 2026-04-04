"use client";

import { useEffect, useState } from "react";
import { collection, query, getDocs, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonCard, SkeletonRow } from "@/components/ui/skeleton";
import { RouteHistory } from "@/types";
import { formatDate, formatTime } from "@/lib/utils";
import { ArrowRight, GitCompare, Clock, TrendingDown, History } from "lucide-react";
import { format, subDays } from "date-fns";

interface HistoryItem extends RouteHistory {
  id: string;
}

export default function HistoryPage() {
  const { userProfile } = useAuth();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadHistory(userProfile.companyId);
  }, [userProfile]);

  async function loadHistory(companyId: string) {
    try {
      const q = query(
        collection(db, `companies/${companyId}/routeHistory`),
        orderBy("modifiedAt", "desc"),
        limit(50)
      );
      const snap = await getDocs(q);
      setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() } as HistoryItem)));
    } catch {
      const demo: HistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
        id: `hist-${i}`,
        companyId: "demo",
        originalRoute: {
          id: `r-${i}`,
          companyId: "demo",
          date: format(subDays(new Date(), i * 3 + 1), "yyyy-MM-dd"),
          techId: `tech-${(i % 3) + 1}`,
          stopSequence: Array.from({ length: 12 }, (_, j) => `job-${j}`),
          totalDriveTimeMinutes: 180 + i * 15,
          totalStops: 12,
          generatedBy: "ai",
          confidence: 0.82 + (i % 3) * 0.04,
          approved: true,
          createdAt: new Date().toISOString(),
        },
        modifiedRoute: {
          id: `r-${i}-mod`,
          companyId: "demo",
          date: format(subDays(new Date(), i * 3 + 1), "yyyy-MM-dd"),
          techId: `tech-${(i % 3) + 1}`,
          stopSequence: Array.from({ length: 12 }, (_, j) => `job-${j}`),
          totalDriveTimeMinutes: 165 + i * 12,
          totalStops: 12,
          generatedBy: "human",
          confidence: 0.82 + (i % 3) * 0.04,
          approved: true,
          createdAt: new Date().toISOString(),
        },
        modifiedBy: ["dispatcher@company.com", "admin@company.com"][i % 2],
        modifiedAt: subDays(new Date(), i * 3).toISOString(),
        deltaStops: {
          moved: Array.from({ length: i % 4 }, (_, j) => ({ jobId: `job-${j}`, fromIndex: j, toIndex: j + 2 })),
          added: [],
          removed: [],
        },
        feedbackProcessed: i > 2,
      }));
      setHistory(demo);
    } finally {
      setLoading(false);
    }
  }

  const driveTimeSaved = (item: HistoryItem) => {
    const orig = item.originalRoute?.totalDriveTimeMinutes || 0;
    const mod = item.modifiedRoute?.totalDriveTimeMinutes || 0;
    return orig - mod;
  };

  const totalSaved = history.reduce((sum, h) => sum + Math.max(0, driveTimeSaved(h)), 0);

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Route History" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">
        {loading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonCard key={i} className={`animate-fade-in stagger-${i + 1}`} />
              ))}
            </div>
            <Card className="border-border/40">
              <CardContent className="p-0">
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonRow key={i} className="border-b border-border/30 last:border-0" />
                ))}
              </CardContent>
            </Card>
          </div>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: "Total Modifications", value: history.length, icon: GitCompare, color: "text-blue-400", bg: "bg-blue-500/10" },
                { label: "Avg Stops Changed", value: history.length > 0 ? (history.reduce((s, h) => s + h.deltaStops.moved.length, 0) / history.length).toFixed(1) : "0", icon: ArrowRight, color: "text-orange-400", bg: "bg-orange-500/10" },
                { label: "Feedback Processed", value: history.filter(h => h.feedbackProcessed).length, icon: History, color: "text-emerald-400", bg: "bg-emerald-500/10" },
                { label: "Drive Time Saved", value: formatTime(totalSaved), icon: TrendingDown, color: "text-purple-400", bg: "bg-purple-500/10" },
              ].map((stat, i) => (
                <Card key={stat.label} className={`border-border/40 animate-fade-in stagger-${i + 1}`}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${stat.bg}`}>
                      <stat.icon className={`w-4 h-4 ${stat.color}`} />
                    </div>
                    <div>
                      <p className="text-xl font-bold tracking-tight">{stat.value}</p>
                      <p className="text-xs text-muted-foreground/60">{stat.label}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* History list */}
            <Card className="border-border/40 animate-fade-in stagger-5">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Modification History</CardTitle>
                <CardDescription className="text-xs">AI routes modified by dispatchers — each change trains the model</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/30">
                  {history.map((item, i) => {
                    const saved = driveTimeSaved(item);
                    const date = item.originalRoute?.date || "";
                    const nMoved = item.deltaStops.moved.length;
                    return (
                      <div key={item.id} className="p-4 hover:bg-accent/15 transition-colors">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm">{formatDate(date)}</span>
                              <Badge variant="outline" className="text-[11px]">Tech {item.originalRoute?.techId?.slice(-1)}</Badge>
                              {nMoved > 0 && <Badge variant="warning" className="text-[11px]">{nMoved} stops reordered</Badge>}
                              {item.feedbackProcessed && <Badge variant="success" className="text-[11px]">Learned</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground/50 mt-1.5">
                              Modified by {item.modifiedBy} · {formatDate(item.modifiedAt)}
                            </p>
                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground/50">
                              <div className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                <span className="line-through">{formatTime(item.originalRoute?.totalDriveTimeMinutes || 0)}</span>
                                <ArrowRight className="w-3 h-3" />
                                <span className="text-foreground">{formatTime(item.modifiedRoute?.totalDriveTimeMinutes || 0)}</span>
                              </div>
                              {saved > 0 && (
                                <div className="flex items-center gap-1 text-emerald-400">
                                  <TrendingDown className="w-3 h-3" />
                                  {formatTime(saved)} saved
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[11px] text-muted-foreground/40 uppercase tracking-wider">Confidence</p>
                            <p className="font-bold text-sm tabular-nums">{Math.round((item.originalRoute?.confidence || 0) * 100)}%</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {history.length === 0 && (
                    <div className="flex flex-col items-center text-center py-16">
                      <GitCompare className="w-8 h-8 text-muted-foreground/20 mb-3" />
                      <p className="text-sm text-muted-foreground">No route modifications yet</p>
                      <p className="text-xs text-muted-foreground/50 mt-1">History appears here after dispatchers edit AI-generated routes.</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
