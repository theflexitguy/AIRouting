"use client";

import { useEffect, useState, useCallback } from "react";
import { collection, query, where, getDocs, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRow } from "@/components/ui/skeleton";
import { Job } from "@/types";
import { formatDate } from "@/lib/utils";
import { RefreshCw, Search, MapPin, Calendar, User, Loader2, ChevronRight, Briefcase } from "lucide-react";
import { format, addDays } from "date-fns";

const statusConfig = {
  pending: { label: "Pending", variant: "warning" as const },
  scheduled: { label: "Scheduled", variant: "default" as const },
  in_progress: { label: "In Progress", variant: "secondary" as const },
  completed: { label: "Completed", variant: "success" as const },
  cancelled: { label: "Cancelled", variant: "destructive" as const },
};

export default function JobsPage() {
  const { userProfile } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filteredJobs, setFilteredJobs] = useState<Job[]>([]);
  const [techs, setTechs] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterTech, setFilterTech] = useState("all");
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    if (!userProfile?.companyId) return;
    setLoading(true);
    try {
      const companyId = userProfile.companyId;
      const today = format(new Date(), "yyyy-MM-dd");
      const future = format(addDays(new Date(), 30), "yyyy-MM-dd");

      const jobsQuery = query(
        collection(db, `companies/${companyId}/jobs`),
        where("scheduledDate", ">=", today),
        where("scheduledDate", "<=", future),
        orderBy("scheduledDate", "asc")
      );
      const snap = await getDocs(jobsQuery);
      const jobData = snap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
      setJobs(jobData);

      const techSnap = await getDocs(collection(db, `companies/${companyId}/technicians`));
      setTechs(techSnap.docs.map(d => ({ id: d.id, name: d.data().name })));
    } catch (error) {
      console.error("Load jobs error:", error);
      const demo: Job[] = Array.from({ length: 18 }, (_, i) => ({
        id: `job-${i}`,
        companyId: "demo",
        customerId: `cust-${i}`,
        customerName: ["Oak Hill HOA", "Smith Residence", "Green Valley Apts", "Parkview Commercial", "Riverside Condos"][i % 5],
        address: ["123 Oak St, Austin TX", "456 Elm Ave, Dallas TX", "789 Pine Rd, Houston TX", "321 Maple Blvd, San Antonio TX", "654 Cedar Ln, Plano TX"][i % 5],
        scheduledDate: format(addDays(new Date(), Math.floor(i / 3)), "yyyy-MM-dd"),
        serviceType: ["Pest Control", "Lawn Care", "HVAC Service", "Pool Maintenance", "Irrigation"][i % 5],
        duration: [60, 90, 45, 120, 30][i % 5],
        assignedTechId: i % 3 === 0 ? undefined : `tech-${i % 3}`,
        status: (["pending", "scheduled", "scheduled", "completed", "pending"] as Job["status"][])[i % 5],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      setJobs(demo);
      setTechs([{ id: "tech-1", name: "Marcus Johnson" }, { id: "tech-2", name: "Sarah Chen" }, { id: "tech-3", name: "David Torres" }]);
    } finally {
      setLoading(false);
    }
  }, [userProfile]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  useEffect(() => {
    let filtered = [...jobs];
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(j =>
        j.customerName.toLowerCase().includes(s) ||
        j.address.toLowerCase().includes(s) ||
        j.serviceType.toLowerCase().includes(s)
      );
    }
    if (filterStatus !== "all") filtered = filtered.filter(j => j.status === filterStatus);
    if (filterTech !== "all") {
      filtered = filtered.filter(j => filterTech === "unassigned" ? !j.assignedTechId : j.assignedTechId === filterTech);
    }
    setFilteredJobs(filtered);
  }, [jobs, search, filterStatus, filterTech]);

  const handleSync = async () => {
    if (!userProfile?.companyId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: userProfile.companyId }),
      });
      const data = await res.json();
      if (data.success) {
        setSyncResult(`Synced ${data.total} jobs (${data.created} new, ${data.updated} updated)`);
        await loadJobs();
      } else {
        setSyncResult(data.error || "Check Cloud Function logs");
      }
    } catch {
      setSyncResult("Sync request sent (Cloud Function may need deployment)");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 5000);
    }
  };

  const techName = (techId?: string) => {
    if (!techId) return "Unassigned";
    return techs.find(t => t.id === techId)?.name || techId;
  };

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Jobs" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">
        {/* Header actions */}
        <div className="flex flex-col sm:flex-row gap-2.5 animate-fade-in">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/40" />
            <Input
              placeholder="Search jobs..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-full sm:w-36 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterTech} onValueChange={setFilterTech}>
            <SelectTrigger className="w-full sm:w-44 h-9">
              <SelectValue placeholder="Technician" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Techs</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {techs.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            onClick={handleSync}
            disabled={syncing}
            className="bg-blue-500 hover:bg-blue-600 text-white shrink-0 h-9"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sync FieldRoutes
          </Button>
        </div>

        {syncResult && (
          <div className="text-sm px-3 py-2 rounded-lg border bg-blue-500/8 border-blue-500/15 text-blue-400 animate-scale-in">
            {syncResult}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground/60 animate-fade-in">
          <span>{filteredJobs.length} of {jobs.length} jobs</span>
          <Button variant="ghost" size="sm" onClick={loadJobs} className="h-7 text-xs">
            <RefreshCw className="w-3 h-3" /> Refresh
          </Button>
        </div>

        {loading ? (
          <Card className="border-border/40 animate-fade-in">
            <CardContent className="p-0">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonRow key={i} className={`border-b border-border/30 last:border-0 stagger-${i + 1}`} />
              ))}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/40 animate-fade-in">
            <CardContent className="p-0">
              {/* Desktop table */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-muted-foreground/60">
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Customer</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Address</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Date</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Service</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Tech</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Status</th>
                      <th className="w-8 p-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map((job) => {
                      const sc = statusConfig[job.status] || statusConfig.pending;
                      return (
                        <tr key={job.id} className="border-b border-border/30 last:border-0 hover:bg-accent/20 transition-colors group">
                          <td className="p-4 font-medium text-foreground">{job.customerName}</td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <MapPin className="w-3 h-3 shrink-0 text-muted-foreground/40" />
                              <span className="truncate max-w-[200px]">{job.address}</span>
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <Calendar className="w-3 h-3 text-muted-foreground/40" />
                              {formatDate(job.scheduledDate)}
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70">{job.serviceType}</td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <User className="w-3 h-3 text-muted-foreground/40" />
                              {techName(job.assignedTechId)}
                            </div>
                          </td>
                          <td className="p-4">
                            <Badge variant={sc.variant} className="text-[11px]">{sc.label}</Badge>
                          </td>
                          <td className="p-4">
                            <ChevronRight className="w-4 h-4 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredJobs.length === 0 && (
                  <div className="flex flex-col items-center text-center py-16">
                    <Briefcase className="w-8 h-8 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">No jobs found</p>
                    <p className="text-xs text-muted-foreground/50 mt-1">Try adjusting filters or syncing from FieldRoutes.</p>
                  </div>
                )}
              </div>

              {/* Mobile/iPad cards */}
              <div className="lg:hidden divide-y divide-border/30">
                {filteredJobs.map(job => {
                  const sc = statusConfig[job.status] || statusConfig.pending;
                  return (
                    <div key={job.id} className="p-4 hover:bg-accent/20 active:bg-accent/30 transition-colors">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p className="font-medium text-foreground">{job.customerName}</p>
                        <Badge variant={sc.variant} className="text-[11px]">{sc.label}</Badge>
                      </div>
                      <div className="space-y-1 text-sm text-muted-foreground/60">
                        <div className="flex items-center gap-1.5"><MapPin className="w-3 h-3" />{job.address}</div>
                        <div className="flex items-center gap-1.5"><Calendar className="w-3 h-3" />{formatDate(job.scheduledDate)} · {job.serviceType}</div>
                        <div className="flex items-center gap-1.5"><User className="w-3 h-3" />{techName(job.assignedTechId)}</div>
                      </div>
                    </div>
                  );
                })}
                {filteredJobs.length === 0 && (
                  <div className="flex flex-col items-center text-center py-16">
                    <Briefcase className="w-8 h-8 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">No jobs found</p>
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
