"use client";

import { useEffect, useState, useCallback } from "react";
import { collection, getDocs, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Route, Job, Technician } from "@/types";
import { formatTime, getConfidenceColor, cn } from "@/lib/utils";
import {
  Loader2, Wand2, CheckCircle, XCircle, GripVertical,
  MapPin, Clock, ChevronDown, ChevronUp, Printer, AlertTriangle
} from "lucide-react";
import { format } from "date-fns";
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

const TECH_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

interface TechRoute {
  route: Route;
  tech: Technician;
  jobs: Job[];
  color: string;
  expanded: boolean;
}

function SortableStop({ job, index, color }: { job: Job; index: number; color: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: job.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn(
        "flex items-center gap-2 p-3 rounded-lg bg-accent/30 border border-border/50 mb-2 cursor-default touch-manipulation",
        isDragging && "shadow-lg border-blue-500/50"
      )}
    >
      <div {...attributes} {...listeners} className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none">
        <GripVertical className="w-4 h-4" />
      </div>
      <div
        className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
        style={{ background: color }}
      >
        {index + 1}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{job.customerName}</p>
        <p className="text-xs text-muted-foreground truncate">{job.address}</p>
      </div>
      <div className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
        <Clock className="w-3 h-3" />
        {job.duration}m
      </div>
    </div>
  );
}

export default function RoutesPage() {
  const { userProfile } = useAuth();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [techs, setTechs] = useState<Technician[]>([]);
  const [selectedTechIds, setSelectedTechIds] = useState<string[]>([]);
  const [techRoutes, setTechRoutes] = useState<TechRoute[]>([]);
  const [allJobs, setAllJobs] = useState<{ [jobId: string]: Job }>({});
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadTechs(userProfile.companyId);
  }, [userProfile]);

  useEffect(() => {
    if (!userProfile?.companyId || !selectedDate) return;
    loadRoutesForDate(userProfile.companyId, selectedDate);
    loadJobsForDate(userProfile.companyId, selectedDate);
  }, [userProfile, selectedDate]);

  useEffect(() => {
    // Load Google Maps
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

  useEffect(() => {
    if (!mapLoaded || techRoutes.length === 0) return;
    initMap();
  }, [mapLoaded, techRoutes, allJobs]);

  function initMap() {
    const mapEl = document.getElementById("route-map");
    if (!mapEl || !window.google) return;

    const map = new window.google.maps.Map(mapEl, {
      center: { lat: 30.2672, lng: -97.7431 }, // Austin TX default
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

    const bounds = new window.google.maps.LatLngBounds();
    let hasCoords = false;

    techRoutes.forEach((tr, tidx) => {
      const color = tr.color;
      const path: google.maps.LatLng[] = [];

      tr.jobs.forEach((job, idx) => {
        if (!job.lat || !job.lng) return;
        const pos = new window.google.maps.LatLng(job.lat, job.lng);
        path.push(pos);
        bounds.extend(pos);
        hasCoords = true;

        // Numbered marker
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
          title: `${idx + 1}. ${job.customerName}`,
        });

        const infoWindow = new window.google.maps.InfoWindow({
          content: `<div style="color:#000;padding:4px"><b>${job.customerName}</b><br/>${job.address}<br/>${job.serviceType} · ${job.duration}min</div>`,
        });
        marker.addListener("click", () => infoWindow.open(map, marker));
      });

      // Draw polyline
      if (path.length > 1) {
        new window.google.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: color,
          strokeOpacity: 0.8,
          strokeWeight: 3,
          map,
        });
      }
    });

    if (hasCoords) map.fitBounds(bounds, 40);
  }

  async function loadTechs(companyId: string) {
    try {
      const snap = await getDocs(query(collection(db, `companies/${companyId}/technicians`), where("active", "==", true)));
      const techList = snap.docs.map(d => ({ id: d.id, ...d.data() } as Technician));
      setTechs(techList);
      setSelectedTechIds(techList.map(t => t.id));
    } catch {
      const demo = [
        { id: "tech-1", name: "Marcus Johnson", email: "marcus@co.com", active: true, maxStopsPerDay: 15, companyId: "demo" },
        { id: "tech-2", name: "Sarah Chen", email: "sarah@co.com", active: true, maxStopsPerDay: 12, companyId: "demo" },
        { id: "tech-3", name: "David Torres", email: "david@co.com", active: true, maxStopsPerDay: 18, companyId: "demo" },
      ] as Technician[];
      setTechs(demo);
      setSelectedTechIds(demo.map(t => t.id));
    }
  }

  async function loadJobsForDate(companyId: string, date: string) {
    try {
      const snap = await getDocs(query(
        collection(db, `companies/${companyId}/jobs`),
        where("scheduledDate", "==", date)
      ));
      const jobMap: { [id: string]: Job } = {};
      snap.docs.forEach(d => { jobMap[d.id] = { id: d.id, ...d.data() } as Job; });
      setAllJobs(jobMap);
    } catch {
      // Use demo jobs embedded in routes
    }
  }

  async function loadRoutesForDate(companyId: string, date: string) {
    try {
      const snap = await getDocs(query(
        collection(db, `companies/${companyId}/routes`),
        where("date", "==", date)
      ));
      if (snap.empty) { setTechRoutes([]); return; }

      const techSnap = await getDocs(collection(db, `companies/${companyId}/technicians`));
      const techMap: { [id: string]: Technician } = {};
      techSnap.docs.forEach(d => { techMap[d.id] = { id: d.id, ...d.data() } as Technician; });

      const routes = snap.docs.map((d, i) => {
        const route = { id: d.id, ...d.data() } as Route;
        const tech = techMap[route.techId] || { id: route.techId, name: route.techId, email: "", active: true, maxStopsPerDay: 20, companyId };
        return { route, tech, jobs: [], color: TECH_COLORS[i % TECH_COLORS.length], expanded: true };
      });
      setTechRoutes(routes);
    } catch { }
  }

  const generateRoutes = async () => {
    if (!userProfile?.companyId) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/generate-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: userProfile.companyId, date: selectedDate, techIds: selectedTechIds }),
      });
      const data = await res.json();
      if (data.success) {
        await loadRoutesForDate(userProfile.companyId, selectedDate);
      }
    } catch (e) {
      console.error("Generate routes error:", e);
    } finally {
      setGenerating(false);
    }
  };

  const handleDragEnd = async (techIndex: number, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const tr = techRoutes[techIndex];
    const oldSeq = tr.route.stopSequence;
    const oldIdx = oldSeq.indexOf(String(active.id));
    const newIdx = oldSeq.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;

    const newSeq = arrayMove(oldSeq, oldIdx, newIdx);
    const updatedRoutes = [...techRoutes];
    updatedRoutes[techIndex] = {
      ...tr,
      route: { ...tr.route, stopSequence: newSeq, generatedBy: "human" },
    };
    setTechRoutes(updatedRoutes);

    // Record feedback
    if (userProfile?.companyId) {
      try {
        await fetch("/api/record-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: userProfile.companyId,
            routeId: tr.route.id,
            originalRoute: tr.route,
            modifiedRoute: { ...tr.route, stopSequence: newSeq },
            modifiedBy: userProfile.email,
          }),
        });
      } catch { }
    }
  };

  const handleApprove = async (techIndex: number, approved: boolean) => {
    const tr = techRoutes[techIndex];
    setApproving(tr.route.id);
    // In production, update Firestore directly
    const updatedRoutes = [...techRoutes];
    updatedRoutes[techIndex] = { ...tr, route: { ...tr.route, approved } };
    setTechRoutes(updatedRoutes);
    setTimeout(() => setApproving(null), 500);
  };

  const handlePrint = () => window.print();

  const toggleTech = (techIndex: number) => {
    const updated = [...techRoutes];
    updated[techIndex] = { ...updated[techIndex], expanded: !updated[techIndex].expanded };
    setTechRoutes(updated);
  };

  const getJobsForRoute = (tr: TechRoute): Job[] => {
    return tr.route.stopSequence.map(id => allJobs[id] || tr.jobs.find(j => j.id === id)).filter(Boolean) as Job[];
  };

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Route Builder" />
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Controls bar */}
        <div className="p-4 border-b border-border flex flex-wrap gap-3 items-center bg-background/95">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="h-10 px-3 rounded-md border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex gap-1 flex-wrap">
            {techs.map(tech => (
              <button
                key={tech.id}
                onClick={() => setSelectedTechIds(prev =>
                  prev.includes(tech.id) ? prev.filter(id => id !== tech.id) : [...prev, tech.id]
                )}
                className={cn(
                  "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors min-h-[36px]",
                  selectedTechIds.includes(tech.id)
                    ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                    : "border-border text-muted-foreground hover:bg-accent"
                )}
              >
                {tech.name}
              </button>
            ))}
          </div>
          <Button
            onClick={generateRoutes}
            disabled={generating || selectedTechIds.length === 0}
            className="bg-blue-500 hover:bg-blue-600 text-white ml-auto"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            Generate Routes
          </Button>
          {techRoutes.length > 0 && (
            <Button variant="outline" size="sm" onClick={handlePrint}>
              <Printer className="w-4 h-4" />
              Export
            </Button>
          )}
        </div>

        {/* Main content: sidebar + map */}
        <div className="flex-1 overflow-hidden flex">
          {/* Left panel - stop lists */}
          <div className="w-80 shrink-0 border-r border-border overflow-y-auto bg-background">
            {techRoutes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-6">
                <Wand2 className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="text-muted-foreground text-sm">No routes for {selectedDate}.</p>
                <p className="text-xs text-muted-foreground mt-1">Select techs and click Generate Routes.</p>
              </div>
            ) : (
              <div className="p-3 space-y-3">
                {techRoutes.map((tr, tidx) => {
                  const jobs = getJobsForRoute(tr);
                  return (
                    <Card key={tr.route.id} className="border-border/50">
                      <CardHeader className="p-3 pb-2">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ background: tr.color }} />
                          <span className="font-medium text-sm flex-1 truncate">{tr.tech.name}</span>
                          <Badge variant={tr.route.approved ? "success" : "warning"} className="text-xs">
                            {tr.route.approved ? "Approved" : "Pending"}
                          </Badge>
                          <button onClick={() => toggleTech(tidx)}>
                            {tr.expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                          </button>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                          <span>{tr.route.totalStops} stops</span>
                          <span>{formatTime(tr.route.totalDriveTimeMinutes)}</span>
                          <span className={getConfidenceColor(tr.route.confidence)}>
                            {Math.round(tr.route.confidence * 100)}% confidence
                          </span>
                        </div>
                        {!tr.route.approved && (
                          <div className="flex gap-2 mt-2">
                            <Button
                              size="sm"
                              className="flex-1 h-8 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20"
                              onClick={() => handleApprove(tidx, true)}
                              disabled={approving === tr.route.id}
                            >
                              <CheckCircle className="w-3 h-3" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 h-8 text-red-400 border-red-500/20 hover:bg-red-500/10"
                              onClick={() => handleApprove(tidx, false)}
                              disabled={approving === tr.route.id}
                            >
                              <XCircle className="w-3 h-3" /> Reject
                            </Button>
                          </div>
                        )}
                      </CardHeader>
                      {tr.expanded && (
                        <CardContent className="p-3 pt-0">
                          <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragEnd={(e) => handleDragEnd(tidx, e)}
                          >
                            <SortableContext items={tr.route.stopSequence} strategy={verticalListSortingStrategy}>
                              {jobs.length > 0 ? jobs.map((job, idx) => (
                                <SortableStop key={job.id} job={job} index={idx} color={tr.color} />
                              )) : (
                                <p className="text-xs text-muted-foreground text-center py-4">
                                  {tr.route.stopSequence.length} stops (load jobs to view details)
                                </p>
                              )}
                            </SortableContext>
                          </DndContext>
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Map */}
          <div className="flex-1 relative bg-accent/10">
            {mapError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
                <AlertTriangle className="w-10 h-10 text-yellow-400 mb-3" />
                <p className="font-medium">Google Maps not configured</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Add your <code className="bg-accent px-1 rounded">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to .env.local
                </p>
                {techRoutes.length > 0 && (
                  <div className="mt-4 text-left w-full max-w-sm">
                    <p className="text-xs text-muted-foreground mb-2">Stop summary:</p>
                    {techRoutes.map(tr => (
                      <div key={tr.route.id} className="flex items-center gap-2 text-sm mb-1">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ background: tr.color }} />
                        <span>{tr.tech.name}: {tr.route.totalStops} stops · {formatTime(tr.route.totalDriveTimeMinutes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div id="route-map" className="absolute inset-0" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
