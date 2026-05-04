"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { collection, query, where, getDocs, orderBy, doc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SkeletonRow } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { calculateStopProductionValue, formatCurrency } from "@/lib/production-value";
import { Upload, Search, MapPin, Calendar, User, Loader2, FileSpreadsheet, AlertTriangle, DollarSign, Repeat, Briefcase, Trash2, RotateCcw } from "lucide-react";
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

const normalizeText = (value: unknown) => String(value ?? "").trim().toLowerCase();

function normalizeStatus(value: unknown) {
  const normalized = normalizeText(value).replace(/[\s-]+/g, "_");
  if (normalized === "inprogress") return "in_progress";
  return normalized;
}

type TechOption = { id: string; name: string; employeeId?: string };

function uniqueOptions(values: Array<unknown>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

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
  billingPrice?: string;
  recurringFrequency?: string;
  recurringPrice?: string;
  subscriptionStatus?: string;
  subscriptionBalance?: string;
  subscriptionOnHold?: string;
  initialServiceDate?: string;
  revenue?: string;
  productionValue?: string;
  subscriptionCategory?: string;
  source?: string;
  rawCsv?: Record<string, unknown>;
  csvFields?: Array<{ name?: string; value?: unknown }>;
}

function getCsvFields(job: JobRow) {
  if (Array.isArray(job.csvFields) && job.csvFields.length > 0) {
    return job.csvFields.map((field) => ({
      name: String(field.name || ""),
      value: String(field.value ?? ""),
    }));
  }

  return Object.entries(job.rawCsv || {}).map(([name, value]) => ({
    name,
    value: String(value ?? ""),
  }));
}

export default function JobsPage() {
  const { userProfile } = useAuth();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [techs, setTechs] = useState<TechOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterTech, setFilterTech] = useState("all");
  const [filterService, setFilterService] = useState("all");
  const [filterSubscriptionStatus, setFilterSubscriptionStatus] = useState("all");
  const [filterBillingFrequency, setFilterBillingFrequency] = useState("all");
  const [filterServiceFrequency, setFilterServiceFrequency] = useState("all");
  const [dateFrom, setDateFrom] = useState(format(startOfYear(new Date()), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(addDays(new Date(), 90), "yyyy-MM-dd"));
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedCsvJob, setSelectedCsvJob] = useState<JobRow | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
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
    const pageIds = paginatedJobs.map(j => j.id);
    const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      pageIds.forEach(id => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
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
      const status = normalizeStatus(job?.status);
      return job && (status === "scheduled" || status === "in_progress");
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
      setTechs(techSnap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          name: String(data.name || d.id),
          employeeId: data.employeeId ? String(data.employeeId) : undefined,
        };
      }));
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

  const filteredJobs = useMemo(() => {
    let filtered = [...jobs];
    const techByAssignment = new Map<string, TechOption>();
    techs.forEach((tech) => {
      [tech.id, tech.name, tech.employeeId].forEach((value) => {
        const key = normalizeText(value);
        if (key) techByAssignment.set(key, tech);
      });
    });

    if (search.trim()) {
      const s = normalizeText(search);
      filtered = filtered.filter((j) => {
        const assignedTech = techByAssignment.get(normalizeText(j.assignedTechId));
        const searchableValues = [
          j.customerName,
          j.address,
          j.serviceType,
          j.customerId,
          j.assignedTechId,
          assignedTech?.name,
          assignedTech?.employeeId,
          j.subscriptionId,
          j.schedulingRequest,
          j.billingFrequency,
          j.billingPrice,
          j.recurringFrequency,
          j.recurringPrice,
          j.subscriptionStatus,
          j.subscriptionBalance,
          j.subscriptionOnHold,
          j.initialServiceDate,
          j.revenue,
          j.productionValue,
          j.subscriptionCategory,
          j.scheduledDate,
          j.status,
          ...Object.values(j.rawCsv || {}),
          ...(j.csvFields || []).flatMap((field) => [field.name, field.value]),
        ];
        return searchableValues.some((value) => normalizeText(value).includes(s));
      });
    }
    if (filterStatus !== "all") {
      filtered = filtered.filter(j => normalizeStatus(j.status) === filterStatus);
    }
    if (filterTech !== "all") {
      const selectedTech = techs.find((tech) => tech.id === filterTech);
      const selectedKeys = new Set(
        [selectedTech?.id, selectedTech?.name, selectedTech?.employeeId]
          .map(normalizeText)
          .filter(Boolean),
      );
      filtered = filtered.filter((j) => {
        const assigned = normalizeText(j.assignedTechId);
        if (filterTech === "unassigned") return !assigned;
        return selectedKeys.has(assigned);
      });
    }
    if (filterService !== "all") {
      filtered = filtered.filter(j => String(j.serviceType || "") === filterService);
    }
    if (filterSubscriptionStatus !== "all") {
      filtered = filtered.filter(j => String(j.subscriptionStatus || "") === filterSubscriptionStatus);
    }
    if (filterBillingFrequency !== "all") {
      filtered = filtered.filter(j => String(j.billingFrequency || "") === filterBillingFrequency);
    }
    if (filterServiceFrequency !== "all") {
      filtered = filtered.filter(j => String(j.recurringFrequency || "") === filterServiceFrequency);
    }
    return filtered;
  }, [
    filterBillingFrequency,
    filterService,
    filterServiceFrequency,
    filterStatus,
    filterSubscriptionStatus,
    filterTech,
    jobs,
    search,
    techs,
  ]);

  const serviceOptions = useMemo(() => uniqueOptions(jobs.map(j => j.serviceType)), [jobs]);
  const subscriptionStatusOptions = useMemo(() => uniqueOptions(jobs.map(j => j.subscriptionStatus)), [jobs]);
  const billingFrequencyOptions = useMemo(() => uniqueOptions(jobs.map(j => j.billingFrequency)), [jobs]);
  const serviceFrequencyOptions = useMemo(() => uniqueOptions(jobs.map(j => j.recurringFrequency)), [jobs]);
  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = filteredJobs.length === 0 ? 0 : (safeCurrentPage - 1) * pageSize;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, filteredJobs.length);
  const paginatedJobs = filteredJobs.slice(pageStartIndex, pageEndIndex);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    dateFrom,
    dateTo,
    filterBillingFrequency,
    filterService,
    filterServiceFrequency,
    filterStatus,
    filterSubscriptionStatus,
    filterTech,
    pageSize,
    search,
  ]);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

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
        setUploadResult(data.message || `${data.new} new, ${data.updated} updated`);
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

  const getTechLabel = (assignedTechId?: string) => {
    const assigned = normalizeText(assignedTechId);
    if (!assigned) return "Unassigned";
    const tech = techs.find((t) =>
      [t.id, t.name, t.employeeId].some((value) => normalizeText(value) === assigned),
    );
    return tech?.name || assignedTechId || "Unassigned";
  };

  const isPastDue = (job: JobRow) => job.scheduledDate < today && normalizeStatus(job.status) === "pending";

  const pendingCount = jobs.filter(j => normalizeStatus(j.status) === "pending").length;
  const scheduledCount = jobs.filter(j => normalizeStatus(j.status) === "scheduled").length;
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
              <SelectItem value="cancelled">Cancelled</SelectItem>
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
          <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value) || 50)}>
            <SelectTrigger className="w-full sm:w-28 h-9">
              <SelectValue placeholder="Rows" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 rows</SelectItem>
              <SelectItem value="50">50 rows</SelectItem>
              <SelectItem value="100">100 rows</SelectItem>
              <SelectItem value="250">250 rows</SelectItem>
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

        <div className="flex flex-col lg:flex-row gap-2.5">
          <Select value={filterService} onValueChange={setFilterService}>
            <SelectTrigger className="w-full lg:w-48 h-9">
              <SelectValue placeholder="Service" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Services</SelectItem>
              {serviceOptions.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterSubscriptionStatus} onValueChange={setFilterSubscriptionStatus}>
            <SelectTrigger className="w-full lg:w-48 h-9">
              <SelectValue placeholder="Subscription" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Subscription Status</SelectItem>
              {subscriptionStatusOptions.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterBillingFrequency} onValueChange={setFilterBillingFrequency}>
            <SelectTrigger className="w-full lg:w-48 h-9">
              <SelectValue placeholder="Billing frequency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Billing Frequency</SelectItem>
              {billingFrequencyOptions.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterServiceFrequency} onValueChange={setFilterServiceFrequency}>
            <SelectTrigger className="w-full lg:w-48 h-9">
              <SelectValue placeholder="Service frequency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Frequency</SelectItem>
              {serviceFrequencyOptions.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="h-9 lg:ml-auto"
            onClick={() => {
              setSearch("");
              setFilterStatus("all");
              setFilterTech("all");
              setFilterService("all");
              setFilterSubscriptionStatus("all");
              setFilterBillingFrequency("all");
              setFilterServiceFrequency("all");
            }}
          >
            <RotateCcw className="w-4 h-4" />
            Reset
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
            Accepts FieldRoutes CSV exports and preserves every uploaded column. Key columns: <code className="bg-accent px-1 rounded">Customer ID</code>, <code className="bg-accent px-1 rounded">Address</code>, <code className="bg-accent px-1 rounded">Service Due</code>, <code className="bg-accent px-1 rounded">Preferred Tech</code>, <code className="bg-accent px-1 rounded">Billing Frequency</code>, <code className="bg-accent px-1 rounded">Recurring Frequency</code>, <code className="bg-accent px-1 rounded">Recurring Price</code>
          </span>
        </div>

        {uploadResult && (
          <div className={`text-sm px-3 py-2.5 rounded-lg border animate-scale-in ${uploadResult.includes("failed") ? "bg-red-500/8 border-red-500/15 text-red-400" : "bg-emerald-500/8 border-emerald-500/15 text-emerald-400"}`}>
            {uploadResult}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground/60 animate-fade-in">
          <span>
            {filteredJobs.length > 0
              ? `${pageStartIndex + 1}-${pageEndIndex} of ${filteredJobs.length} filtered`
              : "0 filtered"} · {jobs.length} loaded
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setCurrentPage(1)}
              disabled={safeCurrentPage === 1}
            >
              First
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
              disabled={safeCurrentPage === 1}
            >
              Prev
            </Button>
            <span className="whitespace-nowrap">Page {safeCurrentPage} of {totalPages}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
              disabled={safeCurrentPage === totalPages}
            >
              Next
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setCurrentPage(totalPages)}
              disabled={safeCurrentPage === totalPages}
            >
              Last
            </Button>
          </div>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 animate-scale-in basis-full sm:basis-auto">
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
                          checked={paginatedJobs.length > 0 && paginatedJobs.every(job => selectedIds.has(job.id))}
                          onChange={toggleSelectAll}
                          className="rounded border-border/60 bg-transparent cursor-pointer accent-blue-500"
                        />
                      </th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Customer</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Address</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Due Date</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Service</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Tech</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Billing Freq</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Service Freq</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Recurring Price</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Stop Value</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">CSV Production</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Sub Status</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">CSV Fields</th>
                      <th className="text-left p-4 font-medium text-xs uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedJobs.map((job) => {
                      const status = normalizeStatus(job.status);
                      const sc = statusConfig[status] || statusConfig.pending;
                      const pastDue = isPastDue(job);
                      const stopProduction = calculateStopProductionValue(job);
                      const csvFieldCount = getCsvFields(job).length;
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
                              <span className="truncate max-w-[120px]">{getTechLabel(job.assignedTechId)}</span>
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <Repeat className="w-3 h-3 text-muted-foreground/40" />
                              <span className="truncate max-w-[130px]">{job.billingFrequency || "-"}</span>
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70">
                            <div className="flex items-center gap-1.5">
                              <Repeat className="w-3 h-3 text-muted-foreground/40" />
                              <span className="truncate max-w-[130px]">{job.recurringFrequency || "-"}</span>
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground/70 whitespace-nowrap">
                            {stopProduction.price !== null ? (
                              <div className="flex items-center gap-1">
                                <DollarSign className="w-3 h-3 text-muted-foreground/40" />
                                {formatCurrency(stopProduction.price)}
                              </div>
                            ) : "-"}
                          </td>
                          <td className="p-4 whitespace-nowrap">
                            {stopProduction.value !== null ? (
                              <div title={stopProduction.explanation}>
                                <p className="font-semibold text-emerald-400">{formatCurrency(stopProduction.value)}</p>
                                {stopProduction.multiplier !== null && stopProduction.multiplier !== 1 && (
                                  <p className="text-[10px] text-muted-foreground/50">
                                    {stopProduction.multiplier.toFixed(2).replace(/\.00$/, "")}x price
                                  </p>
                                )}
                              </div>
                            ) : "-"}
                          </td>
                          <td className="p-4 text-muted-foreground/70 whitespace-nowrap">
                            {stopProduction.csvValue !== null ? formatCurrency(stopProduction.csvValue) : "-"}
                          </td>
                          <td className="p-4">
                            {job.subscriptionStatus ? (
                              <Badge variant={job.subscriptionStatus === "Active" ? "success" : "secondary"} className="text-[10px]">
                                {job.subscriptionStatus}
                              </Badge>
                            ) : "—"}
                          </td>
                          <td className="p-4">
                            {csvFieldCount > 0 ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => setSelectedCsvJob(job)}
                              >
                                <FileSpreadsheet className="w-3 h-3" />
                                {csvFieldCount}
                              </Button>
                            ) : "-"}
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
                {paginatedJobs.map(job => {
                  const status = normalizeStatus(job.status);
                  const sc = statusConfig[status] || statusConfig.pending;
                  const pastDue = isPastDue(job);
                  const stopProduction = calculateStopProductionValue(job);
                  const csvFieldCount = getCsvFields(job).length;
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
                        <div className="flex items-center gap-1.5"><User className="w-3 h-3" />{getTechLabel(job.assignedTechId)}</div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                          <span><Repeat className="w-3 h-3 inline mr-1" />Billing: {job.billingFrequency || "-"}</span>
                          <span><Repeat className="w-3 h-3 inline mr-1" />Service: {job.recurringFrequency || "-"}</span>
                          <span><DollarSign className="w-3 h-3 inline mr-1" />Price: {formatCurrency(stopProduction.price)}</span>
                          <span className="text-emerald-400"><DollarSign className="w-3 h-3 inline mr-1" />Stop: {formatCurrency(stopProduction.value)}</span>
                          <span>CSV Production: {formatCurrency(stopProduction.csvValue)}</span>
                          {job.subscriptionStatus && <Badge variant={job.subscriptionStatus === "Active" ? "success" : "secondary"} className="text-[10px]">{job.subscriptionStatus}</Badge>}
                        </div>
                        {csvFieldCount > 0 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2 h-7 px-2 text-xs"
                            onClick={() => setSelectedCsvJob(job)}
                          >
                            <FileSpreadsheet className="w-3 h-3" />
                            View {csvFieldCount} CSV fields
                          </Button>
                        )}
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
      <Dialog open={Boolean(selectedCsvJob)} onOpenChange={(open) => { if (!open) setSelectedCsvJob(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden">
          {selectedCsvJob && (
            <>
              <DialogHeader>
                <DialogTitle>CSV Fields</DialogTitle>
                <DialogDescription>
                  {selectedCsvJob.customerName} · Customer {selectedCsvJob.customerId || "-"} · Subscription {selectedCsvJob.subscriptionId || "-"}
                </DialogDescription>
              </DialogHeader>
              <div className="overflow-auto rounded-lg border border-border/50 max-h-[65vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background border-b border-border/60">
                    <tr className="text-muted-foreground/70">
                      <th className="text-left p-3 font-medium text-xs uppercase tracking-wider w-1/3">Column</th>
                      <th className="text-left p-3 font-medium text-xs uppercase tracking-wider">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getCsvFields(selectedCsvJob).map((field, index) => (
                      <tr key={`${field.name}-${index}`} className="border-b border-border/30 last:border-0">
                        <td className="p-3 text-muted-foreground/70 align-top">{field.name || `Column ${index + 1}`}</td>
                        <td className="p-3 text-foreground break-words">{field.value || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
