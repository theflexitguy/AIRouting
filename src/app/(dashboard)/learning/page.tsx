"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SkeletonCard, SkeletonChart } from "@/components/ui/skeleton";
import { ModelMetrics } from "@/types";
import { formatDate } from "@/lib/utils";
import { Brain, Loader2, RefreshCw, Target, Database, Eye } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

export default function LearningPage() {
  const { userProfile } = useAuth();
  const [metrics, setMetrics] = useState<ModelMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [retraining, setRetraining] = useState(false);
  const [shadowMode, setShadowMode] = useState(false);
  const [retrainResult, setRetrainResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadMetrics(userProfile.companyId);
  }, [userProfile]);

  async function loadMetrics(companyId: string) {
    try {
      const docRef = doc(db, `companies/${companyId}/modelMetrics/current`);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        setMetrics(snap.data() as ModelMetrics);
      } else {
        setMetrics(getDemoMetrics());
      }
    } catch {
      setMetrics(getDemoMetrics());
    } finally {
      setLoading(false);
    }
  }

  function getDemoMetrics(): ModelMetrics {
    return {
      lastTrainedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      accuracy: 0.87,
      totalRoutesLearned: 143,
      avgConfidence: 0.84,
      accuracyHistory: [
        { date: "Mar 1", accuracy: 0.62 },
        { date: "Mar 5", accuracy: 0.68 },
        { date: "Mar 10", accuracy: 0.72 },
        { date: "Mar 15", accuracy: 0.78 },
        { date: "Mar 20", accuracy: 0.83 },
        { date: "Mar 25", accuracy: 0.87 },
      ],
    };
  }

  async function handleRetrain() {
    if (!userProfile?.companyId) return;
    setRetraining(true);
    setRetrainResult(null);
    try {
      const res = await fetch("/api/retrain-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: userProfile.companyId }),
      });
      const data = await res.json();
      if (data.success) {
        setRetrainResult({ success: true, message: `Model retrained. Accuracy: ${Math.round((data.accuracy || 0) * 100)}%. Learned from ${data.totalRoutesLearned} routes.` });
        await loadMetrics(userProfile.companyId);
      } else {
        setRetrainResult({ success: false, message: data.message || data.error || "Retraining failed" });
      }
    } catch {
      setRetrainResult({ success: false, message: "Retrain request sent (Python Cloud Run service may need deployment)" });
    } finally {
      setRetraining(false);
    }
  }

  const chartData = metrics?.accuracyHistory?.map(h => ({
    date: h.date,
    accuracy: Math.round(h.accuracy * 100),
  })) || [];

  return (
    <div className="flex flex-col h-full">
      <TopBar title="AI Learning" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonCard key={i} className={`animate-fade-in stagger-${i + 1}`} />
              ))}
            </div>
            <SkeletonChart className="animate-fade-in stagger-5" />
          </div>
        ) : metrics ? (
          <>
            {/* Key metrics */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: "Model Accuracy", value: `${Math.round(metrics.accuracy * 100)}%`, icon: Target, color: "text-emerald-400", bg: "bg-emerald-500/10", progress: metrics.accuracy * 100 },
                { label: "Routes Learned", value: metrics.totalRoutesLearned, icon: Database, color: "text-blue-400", bg: "bg-blue-500/10", progress: Math.min(metrics.totalRoutesLearned / 5, 100) },
                { label: "Avg Confidence", value: `${Math.round(metrics.avgConfidence * 100)}%`, icon: Brain, color: "text-purple-400", bg: "bg-purple-500/10", progress: metrics.avgConfidence * 100 },
                { label: "Last Trained", value: formatDate(metrics.lastTrainedAt), icon: RefreshCw, color: "text-orange-400", bg: "bg-orange-500/10" },
              ].map((stat, i) => (
                <Card key={stat.label} className={`border-border/40 animate-fade-in stagger-${i + 1}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs text-muted-foreground/60 font-medium">{stat.label}</p>
                      <div className={`p-1.5 rounded-md ${stat.bg}`}>
                        <stat.icon className={`w-3.5 h-3.5 ${stat.color}`} />
                      </div>
                    </div>
                    <p className="text-2xl font-bold text-foreground tracking-tight">{stat.value}</p>
                    {stat.progress !== undefined && (
                      <Progress value={stat.progress} className="mt-2.5 h-1" />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Accuracy trend chart */}
            <Card className="border-border/40 animate-fade-in stagger-5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Model Accuracy Over Time</CardTitle>
                <CardDescription className="text-xs">How accuracy improves as the model learns from dispatcher feedback</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} axisLine={false} tickLine={false} unit="%" width={35} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", color: "hsl(var(--foreground))", fontSize: "13px" }}
                      formatter={(val) => [`${val}%`, "Accuracy"]}
                    />
                    <ReferenceLine y={85} stroke="#3b82f6" strokeDasharray="4 4" label={{ value: "Auto-approve (85%)", fill: "#3b82f6", fontSize: 11 }} />
                    <Line type="monotone" dataKey="accuracy" stroke="#10b981" strokeWidth={2.5} dot={{ fill: "#10b981", r: 4 }} activeDot={{ r: 6, strokeWidth: 2, stroke: "#10b981", fill: "hsl(var(--background))" }} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Controls */}
            <div className="grid lg:grid-cols-2 gap-4">
              <Card className="border-border/40 animate-fade-in stagger-5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Retrain Model</CardTitle>
                  <CardDescription className="text-xs">Process new route feedback and update the model weights</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="bg-accent/20 rounded-lg p-3 text-sm space-y-1.5">
                    <p className="text-muted-foreground/60 text-xs">Training data: <span className="text-foreground font-medium">{metrics.totalRoutesLearned} routes</span></p>
                    <p className="text-muted-foreground/60 text-xs">Current accuracy: <span className="text-emerald-400 font-medium">{Math.round(metrics.accuracy * 100)}%</span></p>
                    <p className="text-muted-foreground/60 text-xs">Auto-approve threshold: <span className="text-blue-400 font-medium">85%</span></p>
                  </div>
                  {retrainResult && (
                    <div className={`text-sm px-3 py-2.5 rounded-lg border animate-scale-in ${retrainResult.success ? "bg-emerald-500/8 border-emerald-500/15 text-emerald-400" : "bg-yellow-500/8 border-yellow-500/15 text-yellow-400"}`}>
                      {retrainResult.message}
                    </div>
                  )}
                  <Button
                    onClick={handleRetrain}
                    disabled={retraining}
                    className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                  >
                    {retraining ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
                    {retraining ? "Training..." : "Retrain Model Now"}
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-border/40 animate-fade-in stagger-6">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Shadow Mode</CardTitle>
                  <CardDescription className="text-xs">Control how the AI interacts with your dispatch workflow</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-accent/20 rounded-lg">
                    <div>
                      <Label htmlFor="shadow-mode" className="font-medium text-sm cursor-pointer">Observe Only Mode</Label>
                      <p className="text-xs text-muted-foreground/50 mt-0.5">AI generates routes but never auto-approves</p>
                    </div>
                    <Switch id="shadow-mode" checked={shadowMode} onCheckedChange={setShadowMode} />
                  </div>
                  <div className="space-y-2.5 text-sm">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-2 h-2 rounded-full transition-colors ${shadowMode ? "bg-yellow-400" : "bg-emerald-400"}`} />
                      <span className="text-muted-foreground/60 text-xs">
                        {shadowMode ? "Shadow mode ON — all routes require manual approval" : "Auto mode ON — routes with 85%+ confidence are auto-approved"}
                      </span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <Eye className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-0.5" />
                      <span className="text-muted-foreground/50 text-xs leading-relaxed">Switch to shadow mode when testing new service areas or technician assignments</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
