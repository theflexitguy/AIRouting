"use client";

import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, collection, getDocs, addDoc, deleteDoc, updateDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Technician } from "@/types";
import { Loader2, Plus, Trash2, Save, ExternalLink, Key, Users, CreditCard, Bell, SlidersHorizontal, Gauge, RefreshCw, Download, Check } from "lucide-react";
import { toast } from "sonner";

// Headroom under FieldRoutes' account-wide 3,000 reads/day limit. Mirrors
// DEFAULT_API_DAILY_CAP in src/lib/fieldroutes/usage.ts.
const DEFAULT_API_DAILY_CAP = 2500;

function centralTodayISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export default function SettingsPage() {
  const { userProfile } = useAuth();
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [gpcRouteGroupId, setGpcRouteGroupId] = useState("");
  const [gpcRouteTemplateId, setGpcRouteTemplateId] = useState("");
  const [generalPestServiceId, setGeneralPestServiceId] = useState("");
  const [mosquitoServiceId, setMosquitoServiceId] = useState("");
  const [outdoorPackageServiceId, setOutdoorPackageServiceId] = useState("");
  const [serviceIdMap, setServiceIdMap] = useState<Array<{ name: string; id: string }>>([]);
  const [newService, setNewService] = useState({ name: "", id: "" });
  const [pullingServices, setPullingServices] = useState(false);
  const [availableServices, setAvailableServices] = useState<Array<{ id: string; description: string; selected: boolean }> | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [newTech, setNewTech] = useState({ name: "", employeeId: "", maxStopsPerDay: 15 });
  const [addingTech, setAddingTech] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [allowCrossTechRouteEdits, setAllowCrossTechRouteEdits] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [apiDailyCap, setApiDailyCap] = useState("");
  const [apiCapSaving, setApiCapSaving] = useState(false);
  const [apiUsage, setApiUsage] = useState<{ date: string; reads: number; writes: number } | null>(null);

  useEffect(() => {
    if (!userProfile?.companyId || settingsLoaded) return;
    loadSettings(userProfile.companyId);
    loadTechs(userProfile.companyId);
  }, [userProfile, settingsLoaded]);

  // Live FieldRoutes API usage counter for today, written by the sync/approve flows.
  useEffect(() => {
    if (!userProfile?.companyId) return;
    const ref = doc(db, `companies/${userProfile.companyId}/fieldRoutesState/apiUsage`);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const d = snap.exists() ? snap.data() : null;
        setApiUsage({
          date: String(d?.date || ""),
          reads: Number(d?.reads) || 0,
          writes: Number(d?.writes) || 0,
        });
      },
      () => setApiUsage({ date: "", reads: 0, writes: 0 }),
    );
    return () => unsub();
  }, [userProfile?.companyId]);

  async function loadSettings(companyId: string) {
    try {
      const snap = await getDoc(doc(db, "companies", companyId));
      if (snap.exists()) {
        const data = snap.data();
        setApiKey(data.fieldRoutesApiKey ? "••••••••" + data.fieldRoutesApiKey.slice(-4) : "");
        setApiSecret(data.fieldRoutesApiSecret ? "••••" : "");
        setGpcRouteGroupId(String(data.fieldRoutesGpcRouteGroupId || ""));
        setGpcRouteTemplateId(String(data.fieldRoutesGpcRouteTemplateId || ""));
        setGeneralPestServiceId(String(data.fieldRoutesGeneralPestServiceId || ""));
        setMosquitoServiceId(String(data.fieldRoutesMosquitoServiceId || ""));
        setOutdoorPackageServiceId(String(data.fieldRoutesOutdoorPackageServiceId || ""));
        setAllowCrossTechRouteEdits(data.allowCrossTechRouteEdits !== false);
        setApiDailyCap(data.fieldRoutesApiDailyCap ? String(data.fieldRoutesApiDailyCap) : "");
        if (data.fieldRoutesServiceIdMap && typeof data.fieldRoutesServiceIdMap === "object") {
          setServiceIdMap(
            Object.entries(data.fieldRoutesServiceIdMap).map(([name, id]) => ({ name, id: String(id) }))
          );
        }
      }
      setSettingsLoaded(true);
    } catch { }
  }

  async function saveApiCap() {
    if (!userProfile?.companyId) return;
    const n = parseInt(apiDailyCap, 10);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a positive number of API calls for the daily cap.");
      return;
    }
    if (n > 3000) {
      toast.error("FieldRoutes allows at most 3,000 reads/day for the whole account. Set the cap at or below 3,000.");
      return;
    }
    setApiCapSaving(true);
    try {
      await setDoc(doc(db, "companies", userProfile.companyId), { fieldRoutesApiDailyCap: n }, { merge: true });
      toast.success(`Daily API cap set to ${n.toLocaleString()} calls`);
    } catch (err) {
      console.error("Save API cap error:", err);
      toast.error("Failed to save the API cap. Check your connection.");
    } finally {
      setApiCapSaving(false);
    }
  }

  async function loadTechs(companyId: string) {
    try {
      const snap = await getDocs(collection(db, `companies/${companyId}/technicians`));
      setTechs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Technician)));
    } catch {
      setTechs([
        { id: "t1", companyId: "demo", name: "Marcus Johnson", employeeId: "EMP-001", active: true, maxStopsPerDay: 15 },
        { id: "t2", companyId: "demo", name: "Sarah Chen", employeeId: "EMP-002", active: true, maxStopsPerDay: 12 },
        { id: "t3", companyId: "demo", name: "David Torres", employeeId: "EMP-003", active: true, maxStopsPerDay: 18 },
      ]);
    }
  }

  async function saveApiCredentials() {
    if (!userProfile?.companyId) return;
    setSaving(true);
    try {
      const updateData: Record<string, unknown> = {};
      if (apiKey && !apiKey.startsWith("••")) updateData.fieldRoutesApiKey = apiKey;
      if (apiSecret && apiSecret !== "••••") updateData.fieldRoutesApiSecret = apiSecret;
      updateData.fieldRoutesGpcRouteGroupTitle = "GPC";
      updateData.fieldRoutesGpcRouteGroupId = gpcRouteGroupId.trim();
      updateData.fieldRoutesGpcRouteTemplateId = gpcRouteTemplateId.trim();
      updateData.fieldRoutesGeneralPestServiceId = generalPestServiceId.trim();
      updateData.fieldRoutesMosquitoServiceId = mosquitoServiceId.trim();
      updateData.fieldRoutesOutdoorPackageServiceId = outdoorPackageServiceId.trim();
      const mapObj: Record<string, number> = {};
      for (const entry of serviceIdMap) {
        const n = entry.name.trim();
        const v = parseInt(entry.id, 10);
        if (n && Number.isFinite(v) && v > 0) mapObj[n] = v;
      }
      updateData.fieldRoutesServiceIdMap = mapObj;
      if (Object.keys(updateData).length === 0) {
        toast.error("No changes to save. Clear the field and enter your key.");
        setSaving(false);
        return;
      }
      await setDoc(doc(db, "companies", userProfile.companyId), updateData, { merge: true });
      toast.success("FieldRoutes settings saved successfully");
      setSettingsLoaded(false);
    } catch (err) {
      console.error("Save credentials error:", err);
      toast.error("Failed to save. Check Firestore connection.");
    } finally {
      setSaving(false);
    }
  }

  async function pullServiceTypes() {
    if (!userProfile?.companyId) return;
    setPullingServices(true);
    try {
      const res = await fetch("/api/fieldroutes/service-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: userProfile.companyId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch service types");
      const existing = new Set(serviceIdMap.map(s => s.id));
      setAvailableServices(
        (data.serviceTypes as Array<{ id: string; description: string }>).map(s => ({
          ...s,
          selected: existing.has(s.id),
        }))
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to pull service types");
    } finally {
      setPullingServices(false);
    }
  }

  function applySelectedServices() {
    if (!availableServices) return;
    const selected = availableServices.filter(s => s.selected);
    setServiceIdMap(selected.map(s => ({ name: s.description, id: s.id })));
    setAvailableServices(null);
    toast.success(`${selected.length} service${selected.length !== 1 ? "s" : ""} selected — click Save to persist`);
  }

  async function addTechnician() {
    if (!userProfile?.companyId || !newTech.name || !newTech.employeeId) return;
    setAddingTech(true);
    try {
      const techData: Omit<Technician, "id"> = {
        ...newTech,
        companyId: userProfile.companyId,
        active: true,
      };
      const ref = await addDoc(collection(db, `companies/${userProfile.companyId}/technicians`), techData);
      setTechs(prev => [...prev, { id: ref.id, ...techData }]);
      setNewTech({ name: "", employeeId: "", maxStopsPerDay: 15 });
      toast.success(`${newTech.name} added successfully`);
    } catch {
      toast.error("Failed to add technician. Check Firestore connection.");
    } finally {
      setAddingTech(false);
    }
  }

  async function deleteTechnician(techId: string, techName: string) {
    if (!userProfile?.companyId) return;
    try {
      await deleteDoc(doc(db, `companies/${userProfile.companyId}/technicians`, techId));
      setTechs(prev => prev.filter(t => t.id !== techId));
      toast.success(`${techName} removed`);
    } catch {
      toast.error("Failed to remove technician.");
    }
  }

  async function toggleTechActive(tech: Technician) {
    if (!userProfile?.companyId) return;
    try {
      await updateDoc(doc(db, `companies/${userProfile.companyId}/technicians`, tech.id), { active: !tech.active });
      setTechs(prev => prev.map(t => t.id === tech.id ? { ...t, active: !t.active } : t));
    } catch { }
  }

  async function saveRoutingSettings() {
    if (!userProfile?.companyId) return;
    setSavingRouting(true);
    try {
      await setDoc(
        doc(db, "companies", userProfile.companyId),
        { allowCrossTechRouteEdits },
        { merge: true },
      );
      toast.success("Routing settings saved");
    } catch (err) {
      console.error("Save routing settings error:", err);
      toast.error("Failed to save routing settings.");
    } finally {
      setSavingRouting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Settings" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 animate-fade-in">
        <Tabs defaultValue="api">
          <TabsList className="mb-6">
            <TabsTrigger value="api"><Key className="w-4 h-4 mr-2" />API Keys</TabsTrigger>
            <TabsTrigger value="techs"><Users className="w-4 h-4 mr-2" />Technicians</TabsTrigger>
            <TabsTrigger value="routing"><SlidersHorizontal className="w-4 h-4 mr-2" />Routing</TabsTrigger>
            <TabsTrigger value="billing"><CreditCard className="w-4 h-4 mr-2" />Billing</TabsTrigger>
            <TabsTrigger value="notifications"><Bell className="w-4 h-4 mr-2" />Notifications</TabsTrigger>
          </TabsList>

          <TabsContent value="api" className="space-y-4">
            <Card className="border-border/40">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">FieldRoutes Integration</CardTitle>
                <CardDescription className="text-xs">Connect your FieldRoutes account to sync jobs automatically</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm">API Key</Label>
                  <Input value={apiKey} onChange={e => setApiKey(e.target.value)} onFocus={() => { if (apiKey.startsWith("••")) setApiKey(""); }} placeholder="Enter FieldRoutes API key" type="text" className="h-10" />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">API Secret</Label>
                  <Input value={apiSecret} onChange={e => setApiSecret(e.target.value)} onFocus={() => { if (apiSecret === "••••") setApiSecret(""); }} placeholder="Enter FieldRoutes API secret" type="password" className="h-10" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-sm">GPC Route Group ID</Label>
                    <Input value={gpcRouteGroupId} onChange={e => setGpcRouteGroupId(e.target.value)} placeholder="FieldRoutes group ID" inputMode="numeric" className="h-10" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">GPC Route Template ID</Label>
                    <Input value={gpcRouteTemplateId} onChange={e => setGpcRouteTemplateId(e.target.value)} placeholder="Optional template ID" inputMode="numeric" className="h-10" />
                  </div>
                </div>
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-semibold">Service ID Mappings</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground/50">{serviceIdMap.length} service{serviceIdMap.length !== 1 ? "s" : ""}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        disabled={pullingServices}
                        onClick={pullServiceTypes}
                      >
                        {pullingServices ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                        Pull from FieldRoutes
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground/50">Select which FieldRoutes service types to map. When a route is approved, the matching ID is sent to FieldRoutes.</p>

                  {availableServices !== null ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-blue-400">{availableServices.length} service types found</p>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setAvailableServices(prev => prev?.map(s => ({ ...s, selected: true })) ?? null)}
                          >
                            Select all
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setAvailableServices(prev => prev?.map(s => ({ ...s, selected: false })) ?? null)}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                      <div className="max-h-64 overflow-y-auto rounded-lg border border-border/30 divide-y divide-border/20">
                        {availableServices.map((svc, i) => (
                          <label
                            key={svc.id}
                            className="flex items-center gap-3 px-3 py-2 hover:bg-accent/15 cursor-pointer transition-colors"
                          >
                            <div
                              className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                                svc.selected
                                  ? "bg-blue-500 border-blue-500"
                                  : "border-muted-foreground/30"
                              }`}
                              onClick={() => setAvailableServices(prev =>
                                prev?.map((s, j) => j === i ? { ...s, selected: !s.selected } : s) ?? null
                              )}
                            >
                              {svc.selected && <Check className="w-3 h-3 text-white" />}
                            </div>
                            <span className="text-sm flex-1 truncate">{svc.description}</span>
                            <span className="text-xs text-muted-foreground/40 tabular-nums">{svc.id}</span>
                          </label>
                        ))}
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => setAvailableServices(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 text-xs bg-blue-500 hover:bg-blue-600 text-white"
                          onClick={applySelectedServices}
                        >
                          Apply {availableServices.filter(s => s.selected).length} selected
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {serviceIdMap.map((entry, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <Input
                            value={entry.name}
                            onChange={e => setServiceIdMap(prev => prev.map((s, j) => j === i ? { ...s, name: e.target.value } : s))}
                            placeholder="Service name"
                            className="h-9 flex-1"
                          />
                          <Input
                            value={entry.id}
                            onChange={e => setServiceIdMap(prev => prev.map((s, j) => j === i ? { ...s, id: e.target.value.replace(/[^0-9]/g, "") } : s))}
                            placeholder="ID"
                            inputMode="numeric"
                            className="h-9 w-24"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground/30 hover:text-red-400 h-8 w-8 shrink-0"
                            onClick={() => setServiceIdMap(prev => prev.filter((_, j) => j !== i))}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                      <div className="flex gap-2 items-center">
                        <Input
                          value={newService.name}
                          onChange={e => setNewService(prev => ({ ...prev, name: e.target.value }))}
                          placeholder="New service name"
                          className="h-9 flex-1"
                        />
                        <Input
                          value={newService.id}
                          onChange={e => setNewService(prev => ({ ...prev, id: e.target.value.replace(/[^0-9]/g, "") }))}
                          placeholder="ID"
                          inputMode="numeric"
                          className="h-9 w-24"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-blue-400 hover:text-blue-300 h-8 w-8 shrink-0"
                          disabled={!newService.name.trim() || !newService.id.trim()}
                          onClick={() => {
                            setServiceIdMap(prev => [...prev, { name: newService.name.trim(), id: newService.id.trim() }]);
                            setNewService({ name: "", id: "" });
                          }}
                        >
                          <Plus className="w-4 h-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                <Button onClick={saveApiCredentials} disabled={saving} className="bg-blue-500 hover:bg-blue-600 text-white">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save FieldRoutes Settings
                </Button>
              </CardContent>
            </Card>

            <ApiUsageCard
              apiUsage={apiUsage}
              apiDailyCap={apiDailyCap}
              setApiDailyCap={setApiDailyCap}
              apiCapSaving={apiCapSaving}
              saveApiCap={saveApiCap}
            />
          </TabsContent>

          <TabsContent value="techs" className="space-y-4">
            <Card className="border-border/40">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Add Technician</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground/60">Name</Label>
                    <Input value={newTech.name} onChange={e => setNewTech(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground/60">Employee ID</Label>
                    <Input value={newTech.employeeId} onChange={e => setNewTech(p => ({ ...p, employeeId: e.target.value }))} placeholder="EMP-001" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground/60">Max Stops/Day</Label>
                    <Input value={newTech.maxStopsPerDay} onChange={e => setNewTech(p => ({ ...p, maxStopsPerDay: parseInt(e.target.value) || 15 }))} type="number" min={1} max={50} />
                  </div>
                </div>
                <Button
                  onClick={addTechnician}
                  disabled={addingTech || !newTech.name || !newTech.employeeId}
                  className="mt-3 bg-blue-500 hover:bg-blue-600 text-white"
                >
                  {addingTech ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add Technician
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border/40">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Technicians ({techs.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/30">
                  {techs.map(tech => (
                    <div key={tech.id} className="flex items-center gap-3 p-4 hover:bg-accent/15 transition-colors">
                      <div className="w-8 h-8 rounded-full bg-blue-500/15 flex items-center justify-center text-blue-400 text-xs font-bold shrink-0">
                        {tech.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{tech.name}</p>
                        <p className="text-xs text-muted-foreground/50">ID: {tech.employeeId} · Max {tech.maxStopsPerDay} stops/day</p>
                      </div>
                      <Switch checked={tech.active} onCheckedChange={() => toggleTechActive(tech)} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground/30 hover:text-red-400 h-8 w-8 transition-colors"
                        onClick={() => deleteTechnician(tech.id, tech.name)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  {techs.length === 0 && (
                    <div className="flex flex-col items-center text-center py-12">
                      <Users className="w-8 h-8 text-muted-foreground/20 mb-3" />
                      <p className="text-sm text-muted-foreground">No technicians yet</p>
                      <p className="text-xs text-muted-foreground/50 mt-1">Add one above to start generating routes.</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="routing" className="space-y-4">
            <Card className="border-border/40">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Route Editing</CardTitle>
                <CardDescription className="text-xs">Control how strictly RouteIQ enforces technician assignment while manually editing routes.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4 rounded-lg bg-accent/15 p-4">
                  <div>
                    <Label htmlFor="allowCrossTechRouteEdits" className="font-medium text-sm cursor-pointer">Allow cross-technician route edits</Label>
                    <p className="text-xs text-muted-foreground/50 mt-1">
                      When enabled, stops can be dragged or added to any editable route even if FieldRoutes assigned them to another technician.
                    </p>
                  </div>
                  <Switch
                    id="allowCrossTechRouteEdits"
                    checked={allowCrossTechRouteEdits}
                    onCheckedChange={setAllowCrossTechRouteEdits}
                  />
                </div>
                <Button onClick={saveRoutingSettings} disabled={savingRouting} className="bg-blue-500 hover:bg-blue-600 text-white">
                  {savingRouting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Routing Settings
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="billing" className="space-y-4">
            <Card className="border-border/40">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Current Plan</CardTitle>
                <CardDescription className="text-xs">Manage your RouteIQ subscription</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-accent/20 rounded-lg">
                  <div>
                    <p className="font-semibold text-sm">Pro Plan</p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5">Unlimited routes · AI learning · Up to 10 technicians</p>
                  </div>
                  <Badge variant="success" className="text-[11px]">Active</Badge>
                </div>
                <Button variant="outline" className="gap-2">
                  <ExternalLink className="w-4 h-4" />
                  Open Stripe Billing Portal
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            <Card className="border-border/40">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Notification Preferences</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { id: "email", label: "Email Notifications", desc: "Receive daily route summaries by email", value: emailNotifications, onChange: setEmailNotifications },
                ].map(pref => (
                  <div key={pref.id} className="flex items-center justify-between p-3.5 bg-accent/15 rounded-lg">
                    <div>
                      <Label htmlFor={pref.id} className="font-medium text-sm cursor-pointer">{pref.label}</Label>
                      <p className="text-xs text-muted-foreground/50 mt-0.5">{pref.desc}</p>
                    </div>
                    <Switch id={pref.id} checked={pref.value} onCheckedChange={pref.onChange} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ApiUsageCard({
  apiUsage,
  apiDailyCap,
  setApiDailyCap,
  apiCapSaving,
  saveApiCap,
}: {
  apiUsage: { date: string; reads: number; writes: number } | null;
  apiDailyCap: string;
  setApiDailyCap: (value: string) => void;
  apiCapSaving: boolean;
  saveApiCap: () => void;
}) {
  // Counters reset at midnight Central; ignore a stored doc from a previous day.
  const isToday = apiUsage?.date === centralTodayISO();
  const reads = isToday ? apiUsage!.reads : 0;
  const writes = isToday ? apiUsage!.writes : 0;
  const used = reads + writes;

  const parsedCap = parseInt(apiDailyCap, 10);
  const cap = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : DEFAULT_API_DAILY_CAP;
  const usingDefaultCap = !(Number.isFinite(parsedCap) && parsedCap > 0);
  const remaining = Math.max(0, cap - used);
  const pct = Math.min(100, cap > 0 ? Math.round((used / cap) * 100) : 0);
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <Card className="border-border/40">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Gauge className="w-4 h-4 text-blue-400" />
          API Usage &amp; Daily Limit
        </CardTitle>
        <CardDescription className="text-xs">
          FieldRoutes allows 3,000 API reads per day across <span className="font-medium">all</span> software on your account.
          Set a hard cap for RouteIQ so it leaves room for everything else — once it&apos;s hit, RouteIQ stops calling the API
          until midnight Central.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Today's usage */}
        <div className="space-y-2">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-muted-foreground/60">Used today (resets midnight Central)</p>
              <p className="text-2xl font-bold tabular-nums">
                {used.toLocaleString()}
                <span className="text-sm font-normal text-muted-foreground/50"> / {cap.toLocaleString()}</span>
              </p>
            </div>
            <p className="text-xs text-muted-foreground/60 text-right">{remaining.toLocaleString()} left</p>
          </div>
          <div className="h-2.5 w-full rounded-full bg-accent/30 overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground/60">
            <span><span className="font-medium text-foreground/80 tabular-nums">{reads.toLocaleString()}</span> reads</span>
            <span><span className="font-medium text-foreground/80 tabular-nums">{writes.toLocaleString()}</span> writes</span>
            <span className="ml-auto inline-flex items-center gap-1"><RefreshCw className="w-3 h-3" /> live</span>
          </div>
        </div>

        {/* Hard cap */}
        <div className="space-y-2 pt-1 border-t border-border/30">
          <Label className="text-sm pt-3 block">Daily API cap (reads + writes)</Label>
          <p className="text-xs text-muted-foreground/50">
            Maximum FieldRoutes calls RouteIQ may make per day. Must be 3,000 or less.
            {usingDefaultCap && ` Defaults to ${DEFAULT_API_DAILY_CAP.toLocaleString()} when unset.`}
          </p>
          <div className="flex gap-2">
            <Input
              value={apiDailyCap}
              onChange={(e) => setApiDailyCap(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={String(DEFAULT_API_DAILY_CAP)}
              inputMode="numeric"
              className="h-10 max-w-[180px]"
            />
            <Button onClick={saveApiCap} disabled={apiCapSaving} className="bg-blue-500 hover:bg-blue-600 text-white">
              {apiCapSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Cap
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
