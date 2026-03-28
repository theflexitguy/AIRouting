"use client";

import { useEffect, useState } from "react";
import { collection, query, getDocs, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RouteHistory } from "@/types";
import { formatDate, formatTime } from "@/lib/utils";
import { History, ArrowRight, GitCompare, Clock, TrendingDown, Loader2 } from "lucide-react";
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
      // Demo data
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

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Route History" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 animate-fade-in">
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total Modifications", value: history.length, icon: GitCompare, color: "text-blue-400" },
            { label: "Avg Stops Changed", value: history.length > 0 ? (history.reduce((s, h) => s + h.deltaStops.moved.length, 0) / history.length).toFixed(1) : 0, icon: ArrowRight, color: "text-orange-400" },
            { label: "Feedback Processed", value: history.filter(h => h.feedbackProcessed).length, icon: History, color: "text-emerald-400" },
          ].map(stat => (
            <Card key={stat.label} className="border-border/50">
              <CardContent className="p-4 flex items-center gap-3">
                <stat.icon className={`w-5 h-5 ${stat.color}`} />
                <div>
                  <p className="text-2xl font-bold">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>
        ) : (
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Modification History</CardTitle>
              <CardDescription>AI routes that were modified by dispatchers</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border/50">
                {history.map(item => {
                  const saved = driveTimeSaved(item);
                  const date = item.originalRoute?.date || "";
                  const nMoved = item.deltaStops.moved.length;
                  return (
                    <div key={item.id} className="p-4 hover:bg-accent/20 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{formatDate(date)}</span>
                            <Badge variant="outline" className="text-xs">Tech {item.originalRoute?.techId?.slice(-1)}</Badge>
                            {nMoved > 0 && <Badge variant="warning" className="text-xs">{nMoved} stops reordered</Badge>}
                            {item.feedbackProcessed && <Badge variant="success" className="text-xs">Learned</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Modified by {item.modifiedBy} · {formatDate(item.modifiedAt)}
                          </p>
                          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              <span className="line-through">{formatTime(item.originalRoute?.totalDriveTimeMinutes || 0)}</span>
                              <ArrowRight className="w-3 h-3" />
                              <span>{formatTime(item.modifiedRoute?.totalDriveTimeMinutes || 0)}</span>
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
                          <p className="text-xs text-muted-foreground">AI Confidence</p>
                          <p className="font-bold text-sm">{Math.round((item.originalRoute?.confidence || 0) * 100)}%</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {history.length === 0 && (
                  <div className="text-center text-muted-foreground py-12">
                    No route modifications yet. History appears here after dispatchers edit AI-generated routes.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
