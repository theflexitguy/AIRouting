"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { collection, query, where, getDocs, orderBy, doc, deleteDoc, writeBatch, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRow } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { Upload, Search, MapPin, Calendar, User, Loader2, FileSpreadsheet, Clock, AlertTriangle, DollarSign, Repeat, Briefcase, Trash2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { DatePicker } from "@/components/ui/date-picker";
import { format, addDays, startOfYear } from "date-fns";

const statusConfig: Record<string, { label: string; variant: "warning" | "default" | "secondary" | "success" | "destructive" }> = {
  pending: { label: "Pending", variant: "warning" },
  scheduled: { label: "Scheduled", variant: "default" },
  in_progress: { label: "In Progress", variant: "secondary" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

// Extended job type for all CSV fields
interface JobRow {
  id: string;
  companyId: string;
  customerId: string;
  customerName: string;
  address: string;
  lat?: number;
  lng?: number;
  scheduledDate: string;
  serviceType: string;
  duration: number;
  assignedTechId?: string;
  status: string;
  subscriptionId?: string;
  schedulingRequest?: string;
  billingFrequency?: string;
  recurringFrequency?: string;
  recurringPrice?: string;
  subscriptionStatus?: string;
  source?: string;
}

export default function JobsPage() {
  const { userProfile } = useAuth();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [filteredJobs, setFilteredJobs] = useState<JobRow[]>([]);
  const [techs, setTechs] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterTech, setFilterTech] = useState("all");
  const [dateFrom, setDateFrom] = useState(format(startOfYear(new Date()), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(addDays(new Date(), 90), "yyyy-MM-dd"));
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const today = format(new Date(), "yyyy-MM-dd");

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredJobs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredJobs.map(j => j.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (!userProfile?.companyId || selectedIds.size === 0) return;
    const count = selectedIds.size;
    setBulkLoading(true);
    try {
      let batch = writeBatch(db);
      let ops = 0;
      for (const id of selectedIds) {
        batch.delete(doc(db, `companies/${userProfile.companyId}/jobs`, id));
        ops++;
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
      }
      if (ops > 0) await batch.commit();
      setSelectedIds(new Set());
      toast.success(`Deleted ${count} job(s)`);
      await loadJobs();
    } catch (e) {
      console.error("Bulk delete error:", e);
      toast.error("Failed to delete jobs");
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkUnschedule = async () => {
    if (!userProfile?.companyId || selectedIds.size === 0) return;
    const scheduledSelected = [...selectedIds].filter(id => {
      const job = jobs.find(j => j.id === id);
      return job && (job.status === "scheduled" || job.status === "in_progress");
    });
    if (scheduledSelected.length === 0) {
      toast.error("No scheduled jobs selected");
      return;
    }
    setBulkLoading(true);
    try {
      let batch = writeBatch(db);
      let ops = 0;
      for (const id of scheduledSelected) {
        batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, id), {
          status: "pending",
          assignedTechId: "",
          updatedAt: new Date().toISOString(),
        });
        ops++;
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
      }
      if (ops > 0) await batch.commit();
      setSelectedIds(new Set());
      toast.success(`Unscheduled ${scheduledSelected.length} job(s) — returned to pending`);
      await loadJobs();
    } catch (e) {
      console.error("Bulk unschedule error:", e);
      toast.error("Failed to unschedule jobs");
    } finally {
      setBulkLoading(false);
    }
  };

  const loadJobs = useCallback(async () => {
    if (!userProfile?.companyId) return;
    setLoading(true);
    try {
      const companyId = userProfile.companyId;

      const jobsQuery = query(
        collection(db, `companies/${companyId}/jobs`),
        where("scheduledDate", ">=", dateFrom),
        where("scheduledDate", "<=", dateTo),
        orderBy("scheduledDate", "asc")
      );
      const snap = await getDocs(jobsQuery);
      const jobData = snap.docs.map(d => ({ id: d.id, ...d.data() } as JobRow));
      setJobs(jobData);

      const techSnap = await getDocs(collection(db, `companies/${companyId}/technicians`));
      setTechs(techSnap.docs.map(d => ({ id: d.id, name: d.data().name })));
    } catch (error: unknown) {
      console.error("Load jobs error:", error);
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("index") || msg.includes("Index")) {
        alert("Firestore index required. Check browser console for the index creation link.");
      }
      setJobs([]);
      setTechs([]);
    } finally {
      setLoading(false);
    }
  }, [userProfile, dateFrom, dateTo]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  useEffect(() => {
    let filtered = [...jobs];
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(j =>
        j.customerName?.toLowerCase().includes(s) ||
        j.address?.toLowerCase().includes(s) ||
        j.serviceType?.toLowerCase().includes(s) ||
        j.customerId?.toLowerCase().includes(s) ||
        j.assignedTechId?.toLowerCase().includes(s) ||
        j.subscriptionId?.toLowerCase().includes(s)
      );
    }
    if (filterStatus !== "all") filtered = filtered.filter(j => j.status === filterStatus);
    if (filterTech !== "all") {
      filtered = filtered.filter(j => filterTech === "unassigned" ? !j.assignedTechId : j.assignedTechId === filterTech);
    }
    setFilteredJobs(filtered);
  }, [jobs, search, filterStatus, filterTech]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userProfile?.companyId) return;

    setUploading(true);
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("companyId", userProfile.companyId);

      const res = await fetch("/api/upload-jobs", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        setUploadResult(`${data.new} new, ${data.updated} updated, ${data.skipped} skipped`);
        await loadJobs();
      } else {
        setUploadResult(`Upload failed: ${data.error}`);
      }
    } catch {
      setUploadResult("Upload failed. Check your connection.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const isPastDue = (job: JobRow) => job.scheduledDate < today && job.status === "pending";

  const pendingCount = jobs.filter(j => j.status === "pending").length;
  const scheduledCount = jobs.filter(j => j.status === "scheduled").length;
  const pastDueCount = jobs.filter(isPastDue).length;

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Jobs" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 animate-fade-in">
        {/* Summary stats */}
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-yellow-400" />
            <span className="text-muted-foreground">{pendingCount} pending</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-400" />
            <span className="text-muted-foreground">{scheduledCount} scheduled</span>
          </div>
          {pastDueCount > 0 && (
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3 text-red-400" />
              <span className="text-red-400 font-medium">{pastDueCount} past due</span>
            </div>
          )}
          <div className="ml-auto text-muted-foreground">{jobs.length} total</div>
        </div>

        {/* Filters row */}
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/40" />
            <Input
              placeholder="Search by customer, address, tech, ID..."
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
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleUpload}
            className="hidden"
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="bg-blue-500 hover:bg-blue-600 text-white shrink-0 h-9"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload CSV
          </Button>
        </div>

        {/* Date range filter */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Showing jobs from</span>
          <DatePicker value={dateFrom} onChange={setDateFrom} className="h-8 text-xs" />
          <span className="text-muted-foreground">to</span>
          <DatePicker value={dateTo} onChange={setDateTo} className="h-8 text-xs" />
        </div>

        {/* CSV format hint */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-accent/30 rounded-lg px-3 py-2 border border-border/40">
          <FileSpreadsheet className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Accepts FieldRoutes CSV exports. Key columns: <code className="bg-accent px-1 rounded">Customer ID</code>, <code className="bg-accent px-1 rounded">Address</code>, <code className="bg-accent px-1 rounded">Latitude</code>, <code className="bg-accent px-1 rounded">Longitude</code>, <code className="bg-accent px-1 rounded">Service Due</code>, <code className="bg-accent px-1 rounded">Preferred Tech</code>
          </span>
        </div>

        {uploadResult && (
          <div className={`text-sm px-3 py-2.5 rounded-lg border animate-scale-in ${uploadResult.includes("failed") ? "bg-red-500/8 border-red-500/15 text-red-400" : "bg-emerald-500/8 border-emerald-500/15 text-emerald-400"}`}>
            {uploadResult}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground/60 animate-fade-in">
          <span>{filteredJobs.length} of {jobs.length} jobs</span>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 animate-scale-in">
              <span className="text-blue-400 font-medium">{selectedIds.size} selected</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleBulkUnschedule}
                disabled={bulkLoading}
              >
                {bulkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                Unschedule
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-red-400 border-red-500/20 hover:bg-red-500/10"
                onClick={handleBulkDelete}
                disabled={bulkLoading}
              >
                {bulkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground/40"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
            </div>
          )}
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
                      <th className="w-10 p-4">
                        <input
                          type="checkbox"
                          checked={selectedIds.size === filteredJobs.length && filteredJobs.length > 0}
                          onChange={toggleSelectAll}
                          className="rounded border-border/60 bg-transparent cursor-pointer accent-blue-500"
                        />
                      </th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Customer</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Address</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Due Date</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Service</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Tech</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Frequency</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Price</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Sub Status</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map((job, i) => {
                      const sc = statusConfig[job.status] || statusConfig.pending;
                      const pastDue = isPastDue(job);
                      return (
                        <tr key={job.id} className={`border-b border-border/30 last:border-0 hover:bg-accent/20 transition-colors ${pastDue ? "bg-red-500/5" : ""} ${selectedIds.has(job.id) ? "bg-blue-500/5" : ""}`}>
                          <td className="w-10 p-4">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(job.id)}
                              onChange={() => toggleSelect(job.id)}
                              className="rounded border-border/60 bg-transparent cursor-pointer accent-blue-500"
                            />
                          </td>
                          <td className="p-4">
                            <p className="font-medium text-foreground">{job.customerName}</p>
                            <p className="text-xs text-muted-foreground/50">ID: {job.customerId} · Sub: {job.subscriptionId || "—"}</p>
                          </td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <MapPin className="w-3 h-3 shrink-0 text-muted-foreground/40" />
                              <span className="truncate max-w-[180px]">{job.address}</span>
                            </div>
                          </td>
                          <td className="p-4 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <Calendar className="w-3 h-3 text-muted-foreground/40" />
                              <span className={pastDue ? "text-red-400 font-medium" : "text-muted-foreground/70"}>
                                {formatDate(job.scheduledDate)}
                              </span>
                            </div>
                            {pastDue && (
                              <Badge variant="destructive" className="mt-1 text-[10px] px-1.5 py-0">Past Due</Badge>
                            )}
                          </td>
                          <td className="p-4 text-muted-foreground/70">{job.serviceType}</td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <User className="w-3 h-3 text-muted-foreground/40" />
                              <span className="truncate max-w-[120px]">{job.assignedTechId || "Unassigned"}</span>
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <Repeat className="w-3 h-3 text-muted-foreground/40" />
                              <span className="truncate max-w-[100px]">{job.recurringFrequency || "—"}</span>
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70">
                            {job.recurringPrice ? (
                              <div className="flex items-center gap-1">
                                <DollarSign className="w-3 h-3 text-muted-foreground/40" />
                                {job.recurringPrice}
                              </div>
                            ) : "—"}
                          </td>
                          <td className="p-4">
                            {job.subscriptionStatus ? (
                              <Badge variant={job.subscriptionStatus === "Active" ? "success" : "secondary"} className="text-[10px]">
                                {job.subscriptionStatus}
                              </Badge>
                            ) : "—"}
                          </td>
                          <td className="p-4">
                            <Badge variant={sc.variant} className="text-[11px]">{sc.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredJobs.length === 0 && (
                  <div className="flex flex-col items-center text-center py-16">
                    <Briefcase className="w-8 h-8 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">
                      {jobs.length === 0 ? "No jobs yet" : "No jobs match your filters"}
                    </p>
                    <p className="text-xs text-muted-foreground/50 mt-1">
                      {jobs.length === 0 ? "Upload a CSV to get started." : "Try adjusting filters."}
                    </p>
                  </div>
                )}
              </div>

              {/* Mobile/iPad cards */}
              <div className="lg:hidden divide-y divide-border/30">
                {filteredJobs.map(job => {
                  const sc = statusConfig[job.status] || statusConfig.pending;
                  const pastDue = isPastDue(job);
                  return (
                    <div key={job.id} className={`p-4 hover:bg-accent/20 active:bg-accent/30 transition-colors ${pastDue ? "bg-red-500/5" : ""} ${selectedIds.has(job.id) ? "bg-blue-500/5" : ""}`}>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(job.id)}
                            onChange={() => toggleSelect(job.id)}
                            className="rounded border-border/60 bg-transparent cursor-pointer accent-blue-500 mt-1"
                          />
                          <div>
                            <p className="font-medium text-foreground">{job.customerName}</p>
                            <p className="text-xs text-muted-foreground/50">ID: {job.customerId}</p>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          {pastDue && <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Past Due</Badge>}
                          <Badge variant={sc.variant} className="text-[11px]">{sc.label}</Badge>
                        </div>
                      </div>
                      <div className="space-y-1 text-sm text-muted-foreground/60">
                        <div className="flex items-center gap-1.5"><MapPin className="w-3 h-3" />{job.address}</div>
                        <div className="flex items-center gap-1.5"><Calendar className="w-3 h-3" /><span className={pastDue ? "text-red-400" : ""}>{formatDate(job.scheduledDate)}</span> · {job.serviceType}</div>
                        <div className="flex items-center gap-1.5"><User className="w-3 h-3" />{job.assignedTechId || "Unassigned"}</div>
                        <div className="flex items-center gap-3">
                          {job.recurringFrequency && <span><Repeat className="w-3 h-3 inline mr-1" />{job.recurringFrequency}</span>}
                          {job.recurringPrice && <span><DollarSign className="w-3 h-3 inline mr-1" />{job.recurringPrice}</span>}
                          {job.subscriptionStatus && <Badge variant={job.subscriptionStatus === "Active" ? "success" : "secondary"} className="text-[10px]">{job.subscriptionStatus}</Badge>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredJobs.length === 0 && (
                  <div className="flex flex-col items-center text-center py-16">
                    <Briefcase className="w-8 h-8 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">
                      {jobs.length === 0 ? "No jobs yet. Upload a CSV to get started." : "No jobs match your filters."}
                    </p>
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
