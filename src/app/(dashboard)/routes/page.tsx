"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { collection, getDocs, query, where, doc, updateDoc, deleteDoc, writeBatch, setDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Route, Job, Technician } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { formatTime, getConfidenceColor, cn } from "@/lib/utils";
import {
  Loader2, Wand2, CheckCircle, XCircle, GripVertical,
  Clock, ChevronDown, ChevronUp, AlertTriangle, Calendar,
  Printer, Download, Share2, Pencil, MoreVertical, ArrowRight, Merge
} from "lucide-react";
import { format, addDays } from "date-fns";
import { toast } from "sonner";
import { ConstraintBadges } from "@/components/routes/ConstraintBadges";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEditHistory } from "@/hooks/useEditHistory";
import { Undo2, Redo2 } from "lucide-react";

const TECH_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

interface TechRoute {
  route: Route;
  tech: Technician;
  jobs: Job[];
  color: string;
  expanded: boolean;
}

interface StopMenuTarget { routeId: string; techName: string; color: string; date: string; }

function SortableStop({ job, index, color, onRemove, moveTargets, onMoveTo, onHoverStart, onHoverEnd }: {
  job: Job; index: number; color: string;
  onRemove?: () => void;
  moveTargets?: StopMenuTarget[];
  onMoveTo?: (targetRouteId: string) => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: job.id });
  return (
    <div
      ref={setNodeRef}
      data-job-id={job.id}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn(
        "group/stop flex items-center gap-2.5 p-3 rounded-lg bg-accent/20 border border-border/40 mb-1.5 cursor-default touch-manipulation relative",
        "transition-[box-shadow,background,border-color] duration-200",
        isDragging && "shadow-xl shadow-blue-500/15 border-blue-500/30 ring-2 ring-blue-500/20 scale-[1.02]",
      )}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div {...attributes} {...listeners} className="text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none transition-colors">
        <GripVertical className="w-4 h-4" />
      </div>
      <div
        className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
        style={{ background: color }}
      >
        {index + 1}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{job.customerName}</p>
        <p className="text-xs text-muted-foreground/60 truncate">{job.address}</p>
        <ConstraintBadges schedulingRequest={(job as Record<string, unknown>).schedulingRequest as string} />
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <span className="text-xs text-muted-foreground/50 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {job.duration}m
        </span>
        {(onRemove || moveTargets) && (
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              className="opacity-0 group-hover/stop:opacity-100 ml-1 p-1 rounded hover:bg-accent/50 text-muted-foreground/30 hover:text-muted-foreground transition-all"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-card border border-border/60 rounded-lg shadow-xl shadow-black/20 py-1 animate-scale-in">
                  {moveTargets && moveTargets.length > 0 && (
                    <>
                      <p className="px-3 py-1 text-[10px] text-muted-foreground/40 uppercase tracking-wider">Move to</p>
                      {moveTargets.map(t => (
                        <button
                          key={t.routeId}
                          onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onMoveTo?.(t.routeId); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 transition-colors"
                        >
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                          <div className="flex-1 min-w-0">
                            <span className="truncate block">{t.techName}</span>
                            <span className="text-[10px] text-muted-foreground/40">{t.date}</span>
                          </div>
                          <ArrowRight className="w-3 h-3 shrink-0 text-muted-foreground/30" />
                        </button>
                      ))}
                    </>
                  )}
                  {onRemove && (
                    <>
                      <div className="h-px bg-border/30 my-1" />
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRemove(); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors"
                      >
                        <XCircle className="w-3 h-3" />
                        Remove from route
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoutesPage() {
  const { userProfile } = useAuth();
  const [startDate, setStartDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(addDays(new Date(), 6), "yyyy-MM-dd"));
  const [maxStops, setMaxStops] = useState<number>(16);
  const [maxDriveTime, setMaxDriveTime] = useState<number>(240);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("routeiq.generateSettings.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { maxStops?: number; maxDriveTime?: number };
      if (typeof parsed.maxStops === "number" && parsed.maxStops > 0) {
        setMaxStops(parsed.maxStops);
      }
      if (typeof parsed.maxDriveTime === "number" && parsed.maxDriveTime > 0) {
        setMaxDriveTime(parsed.maxDriveTime);
      }
    } catch {
      // ignore malformed localStorage
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(
      "routeiq.generateSettings.v1",
      JSON.stringify({ maxStops, maxDriveTime }),
    );
  }, [maxStops, maxDriveTime]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]); // which days to show (multi-select)
  const [techs, setTechs] = useState<Technician[]>([]);
  const [selectedTechIds, setSelectedTechIds] = useState<string[]>([]);
  const [allRoutes, setAllRoutes] = useState<TechRoute[]>([]); // all routes in date range
  const [allJobs, setAllJobs] = useState<{ [jobId: string]: Job }>({});
  const [generating, setGenerating] = useState(false);
  const [genStage, setGenStage] = useState("");
  const [genResult, setGenResult] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Hover is ref-based (no re-renders) — uses direct DOM manipulation
  const hoveredStopIdRef = useRef<string | null>(null);
  const [leftPanelRouteId, setLeftPanelRouteId] = useState<string | null>(null);
  const [rightPanelRouteId, setRightPanelRouteId] = useState<string | null>(null);
  const heldKeyRef = useRef<string | null>(null);

  // Track L/R key hold state for map click assignment
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "l" || e.key === "L") heldKeyRef.current = "l";
      if (e.key === "r" || e.key === "R") heldKeyRef.current = "r";
    };
    const up = () => { heldKeyRef.current = null; };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => { document.removeEventListener("keydown", down); document.removeEventListener("keyup", up); };
  }, []);
  const mapMarkerByJobId = useRef<Map<string, google.maps.Marker>>(new Map());
  const hasFittedBounds = useRef(false);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const mapMarkersRef = useRef<google.maps.Marker[]>([]);
  const mapPolylinesRef = useRef<google.maps.Polyline[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (routeId: string, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !userProfile?.companyId) return;

    const tr = allRoutes.find(r => r.route.id === routeId);
    if (!tr) return;

    const oldSeq = tr.route.stopSequence;
    const oldIdx = oldSeq.indexOf(String(active.id));
    const newIdx = oldSeq.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;

    const newSeq = arrayMove(oldSeq, oldIdx, newIdx);
    setAllRoutes(allRoutes.map(r =>
      r.route.id === routeId
        ? { ...r, route: { ...r.route, stopSequence: newSeq, generatedBy: "human" as const } }
        : r
    ));

    // Record feedback for AI learning
    fetch("/api/record-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: userProfile.companyId,
        routeId,
        originalRoute: tr.route,
        modifiedRoute: { ...tr.route, stopSequence: newSeq },
        modifiedBy: userProfile.email,
      }),
    }).catch(() => {});
  };

  const { pushEdit, undo, redo, canUndo, canRedo } = useEditHistory();

  // Undo/redo keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey && canUndo) {
        e.preventDefault();
        handleUndo();
      }
      if (((e.key === "z" && e.shiftKey) || e.key === "y") && canRedo) {
        e.preventDefault();
        handleRedo();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });

  const handleUndo = async () => {
    const op = undo();
    if (!op || !userProfile?.companyId) return;
    // Revert all routes in this operation to their "before" state
    for (const snap of op.before) {
      try {
        await updateDoc(doc(db, `companies/${userProfile.companyId}/routes`, snap.routeId), {
          stopSequence: snap.stopSequence,
          totalStops: snap.stopSequence.length,
          ...(snap.date ? { date: snap.date } : {}),
          updatedAt: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }
    toast.info(`Undone: ${op.description}`);
  };

  const handleRedo = async () => {
    const op = redo();
    if (!op || !userProfile?.companyId) return;
    for (const snap of op.after) {
      try {
        await updateDoc(doc(db, `companies/${userProfile.companyId}/routes`, snap.routeId), {
          stopSequence: snap.stopSequence,
          totalStops: snap.stopSequence.length,
          ...(snap.date ? { date: snap.date } : {}),
          updatedAt: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }
    toast.info(`Redone: ${op.description}`);
  };

  // Get unique dates that have routes
  const routeDates = [...new Set(allRoutes.map((tr) => tr.route.date))].sort();
  // Routes for selected dates (show all if none specifically selected)
  const visibleRoutes = selectedDates.length > 0
    ? allRoutes.filter((tr) => selectedDates.includes(tr.route.date))
    : allRoutes;
  const pendingVisibleRoutes = visibleRoutes.filter(tr => !tr.route.approved);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadTechs(userProfile.companyId);
  }, [userProfile]);

  useEffect(() => {
    if (!userProfile?.companyId || !startDate || !endDate) return;
    loadJobsForRange(userProfile.companyId, startDate, endDate);

    // Real-time listener for routes
    const routesQuery = query(
      collection(db, `companies/${userProfile.companyId}/routes`),
      where("date", ">=", startDate),
      where("date", "<=", endDate)
    );

    const unsubscribe = onSnapshot(routesQuery, async (snap) => {
      if (snap.empty) { setAllRoutes([]); return; }

      const techSnap = await getDocs(collection(db, `companies/${userProfile.companyId}/technicians`));
      const techMap: { [id: string]: Technician } = {};
      techSnap.docs.forEach(d => { techMap[d.id] = { id: d.id, ...d.data() } as Technician; });

      let colorIdx = 0;
      const routes = snap.docs.map((d) => {
        const route = { id: d.id, ...d.data() } as Route;
        const routeData = d.data();
        const tech = techMap[route.techId] || {
          id: route.techId, name: routeData.techName || route.techId,
          employeeId: "", active: true, maxStopsPerDay: 20, companyId: userProfile.companyId!,
        };
        const color = TECH_COLORS[colorIdx % TECH_COLORS.length];
        colorIdx++;
        return { route, tech, jobs: [], color, expanded: true };
      });
      setAllRoutes(routes);

      // Auto-select all dates on first load
      const dates = [...new Set(routes.map((r) => r.route.date))].sort();
      setSelectedDates(prev => prev.length === 0 ? dates : prev);
    }, () => {
      setAllRoutes([]);
    });

    return () => unsubscribe();
  }, [userProfile, startDate, endDate]);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || key === "your-google-maps-api-key") {
      setMapError(true);
      return;
    }
    if (window.google?.maps) { setMapLoaded(true); return; }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry`;
    script.async = true;
    script.onload = () => setMapLoaded(true);
    script.onerror = () => setMapError(true);
    document.head.appendChild(script);
  }, []);

  // NW Arkansas anchor — always start here
  const NW_ARK = { lat: 36.07, lng: -94.17 };

  // Create map instance ONCE — anchored to NW Arkansas
  useEffect(() => {
    if (!mapLoaded || mapInstanceRef.current) return;
    const mapEl = document.getElementById("route-map");
    if (!mapEl || !window.google) return;

    mapInstanceRef.current = new window.google.maps.Map(mapEl, {
      center: NW_ARK,
      zoom: 11,
      mapTypeId: "roadmap",
      styles: [
        { elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
        { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
      ],
    });
    hasFittedBounds.current = false;
  }, [mapLoaded]);

  // Update markers and polylines when routes/jobs change (without recreating the map)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !window.google) return;

    // Clear old overlays
    mapMarkersRef.current.forEach(m => m.setMap(null));
    mapPolylinesRef.current.forEach(p => p.setMap(null));
    mapMarkersRef.current = [];
    mapPolylinesRef.current = [];
    mapMarkerByJobId.current.clear();

    const bounds = new window.google.maps.LatLngBounds();
    let hasCoords = false;

    visibleRoutes.forEach((tr) => {
      const color = tr.color;
      const path: google.maps.LatLng[] = [];
      const jobs = getJobsForRoute(tr);

      jobs.forEach((job, idx) => {
        if (!job.lat || !job.lng) return;
        const pos = new window.google.maps.LatLng(job.lat, job.lng);
        path.push(pos);
        bounds.extend(pos);
        hasCoords = true;

        const marker = new window.google.maps.Marker({
          position: pos,
          map,
          label: { text: String(idx + 1), color: "white", fontSize: "11px", fontWeight: "bold" },
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "white",
            strokeWeight: 2,
            scale: 14,
          },
          title: `${idx + 1}. ${job.customerName} — ${tr.tech.name}`,
        });

        // Hover sync: map → sidebar
        marker.addListener("mouseover", () => setHoveredStop(job.id));
        marker.addListener("mouseout", () => setHoveredStop(null));

        const routeId = tr.route.id;
        const infoWindow = new window.google.maps.InfoWindow({
          content: `<div style="color:#000;padding:6px;max-width:240px">
            <b>${job.customerName}</b><br/>
            <span style="color:#666">${job.address}</span><br/>
            ${job.serviceType ? `${job.serviceType} · ` : ""}${job.duration}min<br/>
            <span style="color:${color};font-weight:600">${tr.tech.name}</span> · ${tr.route.date}<br/>
            <span style="color:#999;font-size:11px">L+click = left panel · R+click = right panel</span>
          </div>`,
        });
        marker.addListener("click", () => {
          if (heldKeyRef.current === "l") {
            setLeftPanelRouteId(routeId);
            toast.info(`${tr.tech.name} → left panel`);
            return;
          }
          if (heldKeyRef.current === "r") {
            setRightPanelRouteId(routeId);
            toast.info(`${tr.tech.name} → right panel`);
            return;
          }
          // Default: open info window + assign to left panel
          setLeftPanelRouteId(routeId);
          infoWindow.open(map, marker);
        });

        mapMarkersRef.current.push(marker);
        mapMarkerByJobId.current.set(job.id, marker);
        markerOriginalColors.current.set(job.id, color);
      });

      if (path.length > 1) {
        const polyline = new window.google.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: color,
          strokeOpacity: 0.8,
          strokeWeight: 3,
          map,
        });
        mapPolylinesRef.current.push(polyline);
      }
    });

    // Only fit bounds on FIRST data load — don't jump around after that
    if (hasCoords && !hasFittedBounds.current) {
      map.fitBounds(bounds, 50);
      hasFittedBounds.current = true;
    }
  }, [visibleRoutes, allJobs]);

  const markerOriginalColors = useRef<Map<string, string>>(new Map());

  // Direct DOM + Maps API hover — no React re-renders
  const setHoveredStop = useCallback((jobId: string | null) => {
    const prev = hoveredStopIdRef.current;
    if (prev === jobId) return;

    // Un-highlight previous sidebar stop
    if (prev) {
      const prevEl = document.querySelector(`[data-job-id="${prev}"]`);
      if (prevEl) prevEl.classList.remove("ring-2", "ring-blue-400/50", "bg-blue-500/10", "border-blue-500/30");

      // Restore previous map marker
      if (window.google) {
        const marker = mapMarkerByJobId.current.get(prev);
        const origColor = markerOriginalColors.current.get(prev) || "#3b82f6";
        if (marker) {
          marker.setIcon({
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: origColor, fillOpacity: 1,
            strokeColor: "white", strokeWeight: 2, scale: 14,
          });
          marker.setZIndex(0);
        }
      }
    }

    // Highlight new sidebar stop
    if (jobId) {
      const newEl = document.querySelector(`[data-job-id="${jobId}"]`);
      if (newEl) {
        newEl.classList.add("ring-2", "ring-blue-400/50", "bg-blue-500/10", "border-blue-500/30");
        // Scroll into view if needed
        newEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      // Highlight new map marker
      if (window.google) {
        const marker = mapMarkerByJobId.current.get(jobId);
        if (marker) {
          marker.setIcon({
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: "#facc15", fillOpacity: 1,
            strokeColor: "#facc15", strokeWeight: 3, scale: 20,
          });
          marker.setZIndex(9999);
        }
      }
    }

    hoveredStopIdRef.current = jobId;
  }, []);

  async function loadTechs(companyId: string) {
    try {
      const snap = await getDocs(query(collection(db, `companies/${companyId}/technicians`), where("active", "==", true)));
      const techList = snap.docs.map(d => ({ id: d.id, ...d.data() } as Technician));
      setTechs(techList);
      setSelectedTechIds(techList.map(t => t.id));
    } catch {
      setTechs([]);
      setSelectedTechIds([]);
    }
  }

  async function loadJobsForRange(companyId: string, start: string, end: string) {
    try {
      // Load all jobs that could appear in routes (pending + scheduled in range, plus past-due)
      const snap = await getDocs(collection(db, `companies/${companyId}/jobs`));
      const jobMap: { [id: string]: Job } = {};
      snap.docs.forEach(d => { jobMap[d.id] = { id: d.id, ...d.data() } as Job; });
      setAllJobs(jobMap);
    } catch {
      setAllJobs({});
    }
  }

  // Routes are now loaded via onSnapshot listener in the useEffect above

  const generateRoutes = async () => {
    if (!userProfile?.companyId) return;
    setGenerating(true);
    setGenResult(null);
    setGenStage("Fetching jobs and technicians...");

    // Progress stages on a timer to show activity
    const stages = [
      { delay: 2000, msg: "Validating job coordinates..." },
      { delay: 4000, msg: "Geocoding missing addresses..." },
      { delay: 7000, msg: "Snapping coordinates to roads..." },
      { delay: 10000, msg: "Clustering jobs into routes..." },
      { delay: 14000, msg: "Optimizing stop order (2-opt + or-opt)..." },
      { delay: 20000, msg: "Enriching with traffic-aware drive times..." },
      { delay: 30000, msg: "Saving routes to database..." },
      { delay: 45000, msg: "Still working — large job sets take longer..." },
      { delay: 60000, msg: "Almost there..." },
    ];
    const timers = stages.map(s => setTimeout(() => setGenStage(s.msg), s.delay));

    try {
      const res = await fetch("/api/generate-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: userProfile.companyId,
          startDate,
          endDate,
          techIds: selectedTechIds,
          maxStops,
          maxDriveTime,
        }),
      });
      timers.forEach(clearTimeout);
      const data = await res.json();
      if (data.success) {
        setGenStage(`Done! ${data.routeCount} routes with ${data.stopCount} stops`);
        toast.success(`Generated ${data.routeCount} routes with ${data.stopCount} stops`);
        setGenResult(null);
        const warnings = data.warnings as string[] || [];
        warnings.forEach((w: string) => toast.warning(w, { duration: 8000 }));
        await loadJobsForRange(userProfile.companyId, startDate, endDate);
      } else {
        toast.error(data.error || "Route generation failed");
        setGenResult(null);
      }
    } catch (e) {
      timers.forEach(clearTimeout);
      console.error("Generate routes error:", e);
      toast.error("Failed to generate routes. Check connection.");
    } finally {
      setTimeout(() => { setGenerating(false); setGenStage(""); }, 1500);
    }
  };


  const handleApprove = async (techIndex: number, approved: boolean) => {
    if (!userProfile?.companyId) return;
    const visRoute = visibleRoutes[techIndex];
    const allIdx = allRoutes.findIndex((r) => r.route.id === visRoute.route.id);
    if (allIdx === -1) return;

    const tr = allRoutes[allIdx];
    setApproving(tr.route.id);

    try {
      const routeRef = doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id);

      if (!approved) {
        // Rejecting: delete the route and mark all its jobs back to pending
        const batch = writeBatch(db);
        for (const jobId of tr.route.stopSequence) {
          const jobRef = doc(db, `companies/${userProfile.companyId}/jobs`, jobId);
          batch.update(jobRef, { status: "pending", updatedAt: new Date().toISOString() });
        }
        await batch.commit();
        await deleteDoc(routeRef);

        // Remove from local state
        setAllRoutes(allRoutes.filter((_, i) => i !== allIdx));
      } else {
        // Approving: update the route
        await updateDoc(routeRef, { approved: true, updatedAt: new Date().toISOString() });

        const updatedRoutes = [...allRoutes];
        updatedRoutes[allIdx] = { ...tr, route: { ...tr.route, approved: true } };
        setAllRoutes(updatedRoutes);
      }
    } catch (e) {
      console.error("Approve/reject error:", e);
    } finally {
      setApproving(null);
    }
  };

  const handleBulkApprove = async () => {
    if (!userProfile?.companyId) return;
    const pending = visibleRoutes.filter(tr => !tr.route.approved);
    if (pending.length === 0) return;

    setApproving("bulk");
    try {
      const batch = writeBatch(db);
      for (const tr of pending) {
        const routeRef = doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id);
        batch.update(routeRef, { approved: true, updatedAt: new Date().toISOString() });
      }
      await batch.commit();

      const updatedRoutes = allRoutes.map(tr =>
        pending.some(p => p.route.id === tr.route.id)
          ? { ...tr, route: { ...tr.route, approved: true } }
          : tr
      );
      setAllRoutes(updatedRoutes);
      toast.success(`Approved ${pending.length} route(s)`);
    } catch (e) {
      console.error("Bulk approve error:", e);
      toast.error("Failed to approve routes");
    } finally {
      setApproving(null);
    }
  };

  const handleBulkReject = async () => {
    if (!userProfile?.companyId) return;
    const pending = visibleRoutes.filter(tr => !tr.route.approved);
    if (pending.length === 0) return;

    setApproving("bulk");
    try {
      for (const tr of pending) {
        const routeRef = doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id);
        const batch = writeBatch(db);
        for (const jobId of tr.route.stopSequence) {
          const jobRef = doc(db, `companies/${userProfile.companyId}/jobs`, jobId);
          batch.update(jobRef, { status: "pending", updatedAt: new Date().toISOString() });
        }
        await batch.commit();
        await deleteDoc(routeRef);
      }

      const rejectedIds = new Set(pending.map(p => p.route.id));
      setAllRoutes(allRoutes.filter(tr => !rejectedIds.has(tr.route.id)));
      toast.success(`Rejected ${pending.length} route(s) — jobs returned to pending`);
    } catch (e) {
      console.error("Bulk reject error:", e);
      toast.error("Failed to reject routes");
    } finally {
      setApproving(null);
    }
  };

  const handleMoveStop = async (jobId: string, fromRouteId: string, toRouteId: string) => {
    if (!userProfile?.companyId) return;
    const fromRoute = allRoutes.find(r => r.route.id === fromRouteId);
    const toRoute = allRoutes.find(r => r.route.id === toRouteId);
    if (!fromRoute || !toRoute) return;

    const newFromSeq = fromRoute.route.stopSequence.filter(id => id !== jobId);
    const newToSeq = [...toRoute.route.stopSequence, jobId];

    // Optimistic update
    setAllRoutes(allRoutes.map(r => {
      if (r.route.id === fromRouteId) return { ...r, route: { ...r.route, stopSequence: newFromSeq, totalStops: newFromSeq.length, generatedBy: "human" as const } };
      if (r.route.id === toRouteId) return { ...r, route: { ...r.route, stopSequence: newToSeq, totalStops: newToSeq.length, generatedBy: "human" as const } };
      return r;
    }));

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, fromRouteId), {
        stopSequence: newFromSeq, totalStops: newFromSeq.length, generatedBy: "human", updatedAt: new Date().toISOString(),
      });
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, toRouteId), {
        stopSequence: newToSeq, totalStops: newToSeq.length, generatedBy: "human", updatedAt: new Date().toISOString(),
      });
      batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, jobId), {
        assignedTechId: toRoute.tech.id, updatedAt: new Date().toISOString(),
      });
      await batch.commit();
      const job = allJobs[jobId];
      toast.success(`Moved ${job?.customerName || "stop"} → ${toRoute.tech.name}`);
    } catch (e) {
      console.error("Move stop error:", e);
      toast.error("Failed to move stop");
    }
  };

  const handleMergeRoute = async (fromRouteId: string, toRouteId: string) => {
    if (!userProfile?.companyId) return;
    const fromRoute = allRoutes.find(r => r.route.id === fromRouteId);
    const toRoute = allRoutes.find(r => r.route.id === toRouteId);
    if (!fromRoute || !toRoute) return;

    const newToSeq = [...toRoute.route.stopSequence, ...fromRoute.route.stopSequence];

    // Optimistic update — remove source route, update target
    setAllRoutes(allRoutes
      .filter(r => r.route.id !== fromRouteId)
      .map(r => r.route.id === toRouteId
        ? { ...r, route: { ...r.route, stopSequence: newToSeq, totalStops: newToSeq.length, generatedBy: "human" as const } }
        : r
      )
    );

    try {
      const batch = writeBatch(db);
      // Update target route
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, toRouteId), {
        stopSequence: newToSeq, totalStops: newToSeq.length, generatedBy: "human", updatedAt: new Date().toISOString(),
      });
      // Update all moved jobs' tech assignment
      for (const jobId of fromRoute.route.stopSequence) {
        batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, jobId), {
          assignedTechId: toRoute.tech.id, updatedAt: new Date().toISOString(),
        });
      }
      await batch.commit();
      // Delete source route after batch (can't delete + update in same batch easily)
      await deleteDoc(doc(db, `companies/${userProfile.companyId}/routes`, fromRouteId));
      toast.success(`Merged ${fromRoute.tech.name}'s ${fromRoute.route.totalStops} stops into ${toRoute.tech.name}`);
    } catch (e) {
      console.error("Merge route error:", e);
      toast.error("Failed to merge routes");
    }
  };

  const getJobsForRoute = (tr: TechRoute): Job[] => {
    return tr.route.stopSequence.map(id => allJobs[id]).filter(Boolean) as Job[];
  };

  const handleRemoveStop = async (tr: TechRoute, jobId: string) => {
    if (!userProfile?.companyId) return;
    const job = allJobs[jobId];
    const newSeq = tr.route.stopSequence.filter(id => id !== jobId);

    // Optimistic update
    const updated = allRoutes.map(r =>
      r.route.id === tr.route.id
        ? { ...r, route: { ...r.route, stopSequence: newSeq, totalStops: newSeq.length, generatedBy: "human" as const } }
        : r
    );
    setAllRoutes(updated);

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id), {
        stopSequence: newSeq,
        totalStops: newSeq.length,
        generatedBy: "human",
        updatedAt: new Date().toISOString(),
      });
      batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, jobId), {
        status: "pending",
        assignedTechId: "",
        updatedAt: new Date().toISOString(),
      });
      await batch.commit();
      toast.success(`Removed ${job?.customerName || "stop"} — returned to pending`);
    } catch (e) {
      console.error("Remove stop error:", e);
      toast.error("Failed to remove stop");
    }
  };

  const handleChangeRouteDate = async (tr: TechRoute, newDate: string) => {
    if (!userProfile?.companyId || !newDate) return;

    // Optimistic update
    const updated = allRoutes.map(r =>
      r.route.id === tr.route.id
        ? { ...r, route: { ...r.route, date: newDate } }
        : r
    );
    setAllRoutes(updated);

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, `companies/${userProfile.companyId}/routes`, tr.route.id), {
        date: newDate,
        updatedAt: new Date().toISOString(),
      });
      // Update all jobs in this route
      for (const jobId of tr.route.stopSequence) {
        batch.update(doc(db, `companies/${userProfile.companyId}/jobs`, jobId), {
          scheduledDate: newDate,
          updatedAt: new Date().toISOString(),
        });
      }
      await batch.commit();
      toast.success(`Route moved to ${newDate}`);
    } catch (e) {
      console.error("Change date error:", e);
      toast.error("Failed to change route date");
    }
  };

  const handlePrint = (tr: TechRoute) => {
    const jobs = getJobsForRoute(tr);
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Route - ${tr.tech.name} - ${tr.route.date}</title>
      <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;padding:32px;max-width:800px;margin:0 auto}.header{border-bottom:2px solid #2563eb;padding-bottom:16px;margin-bottom:24px}.header h1{font-size:24px;font-weight:700;color:#2563eb}.meta{display:flex;gap:24px;margin-top:8px;color:#6b7280;font-size:14px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}.stat{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px}.stat .label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af}.stat .value{font-size:20px;font-weight:700;margin-top:2px}.stop{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #e5e7eb}.stop:last-child{border-bottom:none}.stop-num{width:28px;height:28px;border-radius:50%;background:#2563eb;color:white;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}.stop-details{flex:1}.stop-name{font-weight:600;font-size:14px}.stop-address{color:#6b7280;font-size:13px;margin-top:2px}.stop-meta{color:#9ca3af;font-size:12px;margin-top:4px}.footer{margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;text-align:center}</style></head><body>
      <div class="header"><h1>RouteIQ</h1><div class="meta"><span><strong>Technician:</strong> ${tr.tech.name}</span><span><strong>Date:</strong> ${tr.route.date}</span><span><strong>Status:</strong> ${tr.route.approved ? "Approved" : "Pending"}</span></div></div>
      <div class="stats"><div class="stat"><div class="label">Total Stops</div><div class="value">${tr.route.totalStops}</div></div><div class="stat"><div class="label">Drive Time</div><div class="value">${formatTime(tr.route.totalDriveTimeMinutes)}</div></div><div class="stat"><div class="label">Confidence</div><div class="value">${Math.round(tr.route.confidence * 100)}%</div></div></div>
      <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">Stop Sequence</h2>
      ${jobs.map((job, i) => `<div class="stop"><div class="stop-num">${i + 1}</div><div class="stop-details"><div class="stop-name">${job.customerName}</div><div class="stop-address">${job.address}</div><div class="stop-meta">${job.serviceType || ""} ${job.duration ? `· ${job.duration} min` : ""}</div></div></div>`).join("")}
      <div class="footer">Generated by RouteIQ · ${new Date().toLocaleDateString()}</div></body></html>`);
    w.document.close();
    w.print();
  };

  const handleDownload = (tr: TechRoute) => {
    if (!userProfile?.companyId) return;
    window.open(`/api/export-route?companyId=${userProfile.companyId}&routeId=${tr.route.id}&format=html`, "_blank");
  };

  const handleShare = async (tr: TechRoute) => {
    if (!userProfile?.companyId) return;
    const jobs = getJobsForRoute(tr);
    const token = crypto.randomUUID();
    const expires = new Date();
    expires.setDate(expires.getDate() + 7);

    try {
      await setDoc(doc(db, "sharedRoutes", token), {
        companyId: userProfile.companyId,
        routeId: tr.route.id,
        techName: tr.tech.name,
        date: tr.route.date,
        expiresAt: expires.toISOString(),
        totalStops: tr.route.totalStops,
        totalDriveTimeMinutes: tr.route.totalDriveTimeMinutes,
        confidence: tr.route.confidence,
        approved: tr.route.approved,
        stops: jobs.map(j => ({
          customerName: j.customerName,
          address: j.address,
          serviceType: j.serviceType,
          duration: j.duration,
        })),
      });

      const shareUrl = `${window.location.origin}/share/${token}`;
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied to clipboard! Valid for 7 days.");
    } catch (e) {
      console.error("Share error:", e);
      toast.error("Failed to create share link.");
    }
  };

  // Summary stats
  const totalRoutes = allRoutes.length;
  const totalStops = allRoutes.reduce((sum, tr) => sum + tr.route.totalStops, 0);
  const approvedCount = allRoutes.filter((tr) => tr.route.approved).length;

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      <TopBar title="Route Builder" />
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Controls bar */}
        <div className="p-3 lg:p-4 border-b border-border/60 flex flex-wrap gap-2.5 items-center bg-background/95 backdrop-blur-sm no-print">
          <div className="flex items-center gap-2">
            <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" className="h-9" />
            <span className="text-muted-foreground text-sm">to</span>
            <DatePicker value={endDate} onChange={setEndDate} placeholder="End date" className="h-9" />
          </div>
          <div className="flex items-center gap-3 border-l border-border/60 pl-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Max stops
              <Input
                type="number"
                min={1}
                max={30}
                value={maxStops}
                onChange={(e) => setMaxStops(Math.max(1, parseInt(e.target.value) || 16))}
                className="h-9 w-16 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Max drive (min)
              <Input
                type="number"
                min={30}
                max={600}
                step={15}
                value={maxDriveTime}
                onChange={(e) => setMaxDriveTime(Math.max(30, parseInt(e.target.value) || 240))}
                className="h-9 w-20 text-sm"
              />
            </label>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {techs.map(tech => (
              <button
                key={tech.id}
                onClick={() => setSelectedTechIds(prev =>
                  prev.includes(tech.id) ? prev.filter(id => id !== tech.id) : [...prev, tech.id]
                )}
                className={cn(
                  "px-3 py-1.5 rounded-full text-xs font-medium border min-h-[32px]",
                  "transition-all duration-150",
                  selectedTechIds.includes(tech.id)
                    ? "bg-blue-500/15 border-blue-500/30 text-blue-400"
                    : "border-border/60 text-muted-foreground/60 hover:bg-accent/50 hover:text-muted-foreground"
                )}
              >
                {tech.name}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant={editMode ? "default" : "outline"}
              onClick={() => setEditMode(!editMode)}
              className={cn(
                "h-9 text-sm",
                editMode
                  ? "bg-orange-500 hover:bg-orange-600 text-white"
                  : "text-muted-foreground"
              )}
            >
              <Pencil className="w-4 h-4" />
              {editMode ? "Editing" : "Edit Routes"}
            </Button>
            <Button
              onClick={generateRoutes}
              disabled={generating || selectedTechIds.length === 0}
              className="bg-blue-500 hover:bg-blue-600 text-white h-9 text-sm"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              Generate Routes
            </Button>
          </div>
        </div>

        {/* Generation result */}
        {genResult && (
          <div className={`mx-4 mt-2 text-sm px-3 py-2 rounded-lg border animate-scale-in ${genResult.startsWith("Error") || genResult.startsWith("Failed") ? "bg-red-500/8 border-red-500/15 text-red-400" : "bg-emerald-500/8 border-emerald-500/15 text-emerald-400"}`}>
            {genResult}
          </div>
        )}

        {/* Date filter pills + bulk actions */}
        {routeDates.length > 0 && (
          <div className="px-4 pt-3 pb-2 border-b border-border/50 space-y-2">
            <div className="flex items-center gap-2 overflow-x-auto">
              {/* Select All / None */}
              <button
                onClick={() => setSelectedDates(prev => prev.length === routeDates.length ? [] : [...routeDates])}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors whitespace-nowrap",
                  selectedDates.length === routeDates.length
                    ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                    : "border-border text-muted-foreground hover:bg-accent"
                )}
              >
                All Days
              </button>
              {routeDates.map((d) => {
                const count = allRoutes.filter((r) => r.route.date === d).length;
                const isSelected = selectedDates.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => setSelectedDates(prev =>
                      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
                    )}
                    className={cn(
                      "px-3 py-1 rounded-md text-[11px] font-medium border transition-colors whitespace-nowrap",
                      isSelected
                        ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                        : "border-border text-muted-foreground hover:bg-accent"
                    )}
                  >
                    <Calendar className="w-3 h-3 inline mr-1" />
                    {d} ({count})
                  </button>
                );
              })}
              <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap pl-4">
                {visibleRoutes.length} routes · {visibleRoutes.reduce((s, r) => s + r.route.totalStops, 0)} stops
              </span>
            </div>

            {/* Editing toolbar — undo/redo + bulk actions */}
            <div className="flex items-center gap-2">
              {/* Undo/Redo */}
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground/50" onClick={handleUndo} disabled={!canUndo} title="Undo (Cmd+Z)">
                <Undo2 className="w-3.5 h-3.5" /> Undo
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground/50" onClick={handleRedo} disabled={!canRedo} title="Redo (Cmd+Shift+Z)">
                <Redo2 className="w-3.5 h-3.5" /> Redo
              </Button>

              {pendingVisibleRoutes.length > 0 && (
                <>
                  <div className="w-px h-4 bg-border/50 mx-1" />
                  <span className="text-xs text-muted-foreground">
                    {pendingVisibleRoutes.length} pending:
                  </span>
                <Button
                  size="sm"
                  className="h-7 text-xs px-3 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20"
                  onClick={handleBulkApprove}
                  disabled={approving === "bulk"}
                >
                  {approving === "bulk" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                  Approve All ({pendingVisibleRoutes.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs px-3 text-red-400 border-red-500/20 hover:bg-red-500/10"
                  onClick={handleBulkReject}
                  disabled={approving === "bulk"}
                >
                  {approving === "bulk" ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                  Reject All ({pendingVisibleRoutes.length})
                </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Main content: left panel + map + right panel */}
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* LEFT PANEL — shows route assigned via click or L+click */}
          {leftPanelRouteId && (() => {
            const tr = allRoutes.find(r => r.route.id === leftPanelRouteId);
            if (!tr) return null;
            const panelJobs = getJobsForRoute(tr);
            return (
              <div className="w-72 shrink-0 border-r border-border/60 overflow-y-auto bg-background animate-fade-in">
                <div className="flex items-center justify-between p-2 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: tr.color }} />
                    <span className="text-xs font-semibold text-foreground truncate">{tr.tech.name}</span>
                    <span className="text-[10px] text-muted-foreground/50">{tr.route.date}</span>
                  </div>
                  <button onClick={() => setLeftPanelRouteId(null)} className="p-1 hover:bg-accent/50 rounded text-muted-foreground/40 hover:text-foreground transition-colors">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
                {editMode && (
                  <div className="px-2 py-1.5 bg-orange-500/10 border-b border-orange-500/20 text-orange-400 text-[10px] flex items-center gap-1.5">
                    <Pencil className="w-2.5 h-2.5" /> Edit mode active
                  </div>
                )}
                <div className="p-2">
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => handleDragEnd(tr.route.id, e)}>
                    <SortableContext items={tr.route.stopSequence} strategy={verticalListSortingStrategy}>
                      {panelJobs.map((job, idx) => (
                        <SortableStop
                          key={job.id} job={job} index={idx} color={tr.color}
                          onHoverStart={() => setHoveredStop(job.id)}
                          onHoverEnd={() => setHoveredStop(null)}
                          onRemove={editMode ? () => handleRemoveStop(tr, job.id) : undefined}
                          moveTargets={editMode ? visibleRoutes.filter(o => o.route.id !== tr.route.id).map(o => ({ routeId: o.route.id, techName: o.tech.name, color: o.color, date: o.route.date })) : undefined}
                          onMoveTo={editMode ? (tid) => handleMoveStop(job.id, tr.route.id, tid) : undefined}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                  {panelJobs.length === 0 && <p className="text-xs text-muted-foreground/50 text-center py-4">{tr.route.stopSequence.length} stops</p>}
                </div>
                {/* Route actions */}
                <div className="p-2 border-t border-border/40 flex flex-wrap gap-1">
                  {!editMode && (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handlePrint(tr)}><Printer className="w-3 h-3" /> Print</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handleShare(tr)}><Share2 className="w-3 h-3" /> Share</Button>
                    </>
                  )}
                  {!tr.route.approved && (
                    <>
                      <Button size="sm" className="h-6 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, true); }} disabled={approving === tr.route.id}><CheckCircle className="w-3 h-3" /> Approve</Button>
                      <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, false); }} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Reject</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* If no panels open, show a hint */}
          {!leftPanelRouteId && !rightPanelRouteId && visibleRoutes.length > 0 && (
            <div className="w-48 shrink-0 border-r border-border/60 flex flex-col items-center justify-center text-center p-4 bg-background/50">
              <p className="text-xs text-muted-foreground/40 leading-relaxed">
                Click a route on the map to view it here.
              </p>
              <p className="text-[10px] text-muted-foreground/30 mt-2">
                Hold <kbd className="bg-accent/50 px-1 rounded border border-border/30">L</kbd> + click → left panel<br/>
                Hold <kbd className="bg-accent/50 px-1 rounded border border-border/30">R</kbd> + click → right panel
              </p>
            </div>
          )}
          {/* MAP — center, fill all remaining space */}
          <div className="flex-1 relative bg-accent/5 min-h-0 min-w-0">
            {/* Generation progress overlay */}
            {generating && (
              <div className="absolute inset-0 z-20 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center animate-fade-in">
                <div className="bg-card border border-border/60 rounded-xl shadow-2xl shadow-black/30 p-8 max-w-sm w-full mx-4 text-center">
                  <div className="w-12 h-12 mx-auto mb-4 relative">
                    <div className="absolute inset-0 border-2 border-blue-500/20 rounded-full" />
                    <div className="absolute inset-0 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <Wand2 className="w-5 h-5 text-blue-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                  </div>
                  <p className="text-sm font-semibold text-foreground mb-2">Generating Routes</p>
                  <p className="text-xs text-blue-400 animate-pulse min-h-[1.25rem]">{genStage}</p>
                  <div className="mt-4 flex items-center gap-1 justify-center">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: "300ms" }} />
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: "600ms" }} />
                  </div>
                </div>
              </div>
            )}

            {mapError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center mb-4">
                  <AlertTriangle className="w-5 h-5 text-yellow-400" />
                </div>
                <p className="font-medium text-sm">Google Maps not configured</p>
                <p className="text-sm text-muted-foreground/60 mt-1.5 max-w-xs">
                  Add <code className="bg-accent/50 px-1.5 py-0.5 rounded text-xs">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to .env.local
                </p>
              </div>
            ) : (
              <div id="route-map" className="absolute inset-0" />
            )}
          </div>

          {/* RIGHT PANEL — shows route assigned via R+click */}
          {rightPanelRouteId && (() => {
            const tr = allRoutes.find(r => r.route.id === rightPanelRouteId);
            if (!tr) return null;
            const panelJobs = getJobsForRoute(tr);
            return (
              <div className="w-72 shrink-0 border-l border-border/60 overflow-y-auto bg-background animate-fade-in">
                <div className="flex items-center justify-between p-2 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: tr.color }} />
                    <span className="text-xs font-semibold text-foreground truncate">{tr.tech.name}</span>
                    <span className="text-[10px] text-muted-foreground/50">{tr.route.date}</span>
                  </div>
                  <button onClick={() => setRightPanelRouteId(null)} className="p-1 hover:bg-accent/50 rounded text-muted-foreground/40 hover:text-foreground transition-colors">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
                {editMode && (
                  <div className="px-2 py-1.5 bg-orange-500/10 border-b border-orange-500/20 text-orange-400 text-[10px] flex items-center gap-1.5">
                    <Pencil className="w-2.5 h-2.5" /> Edit mode active
                  </div>
                )}
                <div className="p-2">
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => handleDragEnd(tr.route.id, e)}>
                    <SortableContext items={tr.route.stopSequence} strategy={verticalListSortingStrategy}>
                      {panelJobs.map((job, idx) => (
                        <SortableStop
                          key={job.id} job={job} index={idx} color={tr.color}
                          onHoverStart={() => setHoveredStop(job.id)}
                          onHoverEnd={() => setHoveredStop(null)}
                          onRemove={editMode ? () => handleRemoveStop(tr, job.id) : undefined}
                          moveTargets={editMode ? visibleRoutes.filter(o => o.route.id !== tr.route.id).map(o => ({ routeId: o.route.id, techName: o.tech.name, color: o.color, date: o.route.date })) : undefined}
                          onMoveTo={editMode ? (tid) => handleMoveStop(job.id, tr.route.id, tid) : undefined}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                  {panelJobs.length === 0 && <p className="text-xs text-muted-foreground/50 text-center py-4">{tr.route.stopSequence.length} stops</p>}
                </div>
                <div className="p-2 border-t border-border/40 flex flex-wrap gap-1">
                  {!editMode && (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handlePrint(tr)}><Printer className="w-3 h-3" /> Print</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground/60" onClick={() => handleShare(tr)}><Share2 className="w-3 h-3" /> Share</Button>
                    </>
                  )}
                  {!tr.route.approved && (
                    <>
                      <Button size="sm" className="h-6 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, true); }} disabled={approving === tr.route.id}><CheckCircle className="w-3 h-3" /> Approve</Button>
                      <Button size="sm" variant="outline" className="h-6 text-[10px] text-red-400 border-red-500/20 hover:bg-red-500/10" onClick={() => { const tidx = visibleRoutes.indexOf(tr); if (tidx >= 0) handleApprove(tidx, false); }} disabled={approving === tr.route.id}><XCircle className="w-3 h-3" /> Reject</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

        </div>
      </div>
    </div>
  );
}
