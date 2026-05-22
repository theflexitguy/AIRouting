"use client";

import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, collection, getDocs, addDoc, deleteDoc, updateDoc } from "firebase/firestore";
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
import { Loader2, Plus, Trash2, Save, ExternalLink, Key, Users, CreditCard, Bell, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

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
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [newTech, setNewTech] = useState({ name: "", employeeId: "", maxStopsPerDay: 15 });
  const [addingTech, setAddingTech] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [allowCrossTechRouteEdits, setAllowCrossTechRouteEdits] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);

  useEffect(() => {
    if (!userProfile?.companyId || settingsLoaded) return;
    loadSettings(userProfile.companyId);
    loadTechs(userProfile.companyId);
  }, [userProfile, settingsLoaded]);

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
      }
      setSettingsLoaded(true);
    } catch { }
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
                  <div className="space-y-2">
                    <Label className="text-sm">General Pest Service ID</Label>
                    <Input value={generalPestServiceId} onChange={e => setGeneralPestServiceId(e.target.value)} placeholder="Service ID" inputMode="numeric" className="h-10" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">Mosquito Service ID</Label>
                    <Input value={mosquitoServiceId} onChange={e => setMosquitoServiceId(e.target.value)} placeholder="Service ID" inputMode="numeric" className="h-10" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">Outdoor Package Service ID</Label>
                    <Input value={outdoorPackageServiceId} onChange={e => setOutdoorPackageServiceId(e.target.value)} placeholder="Service ID" inputMode="numeric" className="h-10" />
                  </div>
                </div>
                <Button onClick={saveApiCredentials} disabled={saving} className="bg-blue-500 hover:bg-blue-600 text-white">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save FieldRoutes Settings
                </Button>
              </CardContent>
            </Card>
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
