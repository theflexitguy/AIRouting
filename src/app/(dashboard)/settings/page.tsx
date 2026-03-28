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
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Technician } from "@/types";
import { Loader2, Plus, Trash2, Save, ExternalLink, Key, Users, CreditCard, Bell } from "lucide-react";

export default function SettingsPage() {
  const { userProfile } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [techs, setTechs] = useState<Technician[]>([]);
  const [newTech, setNewTech] = useState({ name: "", email: "", maxStopsPerDay: 15 });
  const [addingTech, setAddingTech] = useState(false);
  const [emailNotifications, setEmailNotifications] = useState(true);

  useEffect(() => {
    if (!userProfile?.companyId) return;
    loadSettings(userProfile.companyId);
    loadTechs(userProfile.companyId);
  }, [userProfile]);

  async function loadSettings(companyId: string) {
    try {
      const snap = await getDoc(doc(db, "companies", companyId));
      if (snap.exists()) {
        const data = snap.data();
        setApiKey(data.fieldRoutesApiKey ? "••••••••" + data.fieldRoutesApiKey.slice(-4) : "");
        setApiSecret(data.fieldRoutesApiSecret ? "••••" : "");
      }
    } catch { }
  }

  async function loadTechs(companyId: string) {
    try {
      const snap = await getDocs(collection(db, `companies/${companyId}/technicians`));
      setTechs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Technician)));
    } catch {
      setTechs([
        { id: "t1", companyId: "demo", name: "Marcus Johnson", email: "marcus@company.com", active: true, maxStopsPerDay: 15 },
        { id: "t2", companyId: "demo", name: "Sarah Chen", email: "sarah@company.com", active: true, maxStopsPerDay: 12 },
        { id: "t3", companyId: "demo", name: "David Torres", email: "david@company.com", active: true, maxStopsPerDay: 18 },
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
      await updateDoc(doc(db, "companies", userProfile.companyId), updateData);
      setSaveResult({ success: true, message: "API credentials saved successfully" });
    } catch {
      setSaveResult({ success: false, message: "Failed to save. Check Firestore connection." });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  }

  async function addTechnician() {
    if (!userProfile?.companyId || !newTech.name || !newTech.email) return;
    setAddingTech(true);
    try {
      const techData: Omit<Technician, "id"> = {
        ...newTech,
        companyId: userProfile.companyId,
        active: true,
      };
      const ref = await addDoc(collection(db, `companies/${userProfile.companyId}/technicians`), techData);
      setTechs(prev => [...prev, { id: ref.id, ...techData }]);
      setNewTech({ name: "", email: "", maxStopsPerDay: 15 });
    } catch {
      alert("Failed to add technician. Check Firestore connection.");
    } finally {
      setAddingTech(false);
    }
  }

  async function deleteTechnician(techId: string) {
    if (!userProfile?.companyId) return;
    if (!confirm("Remove this technician?")) return;
    try {
      await deleteDoc(doc(db, `companies/${userProfile.companyId}/technicians`, techId));
      setTechs(prev => prev.filter(t => t.id !== techId));
    } catch {
      alert("Failed to remove technician.");
    }
  }

  async function toggleTechActive(tech: Technician) {
    if (!userProfile?.companyId) return;
    try {
      await updateDoc(doc(db, `companies/${userProfile.companyId}/technicians`, tech.id), { active: !tech.active });
      setTechs(prev => prev.map(t => t.id === tech.id ? { ...t, active: !t.active } : t));
    } catch { }
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Settings" />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 animate-fade-in">
        <Tabs defaultValue="api">
          <TabsList className="mb-6">
            <TabsTrigger value="api"><Key className="w-4 h-4 mr-2" />API Keys</TabsTrigger>
            <TabsTrigger value="techs"><Users className="w-4 h-4 mr-2" />Technicians</TabsTrigger>
            <TabsTrigger value="billing"><CreditCard className="w-4 h-4 mr-2" />Billing</TabsTrigger>
            <TabsTrigger value="notifications"><Bell className="w-4 h-4 mr-2" />Notifications</TabsTrigger>
          </TabsList>

          <TabsContent value="api" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-base">FieldRoutes Integration</CardTitle>
                <CardDescription>Connect your FieldRoutes account to sync jobs automatically</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>API Key</Label>
                  <Input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter FieldRoutes API key" type="text" />
                </div>
                <div className="space-y-2">
                  <Label>API Secret</Label>
                  <Input value={apiSecret} onChange={e => setApiSecret(e.target.value)} placeholder="Enter FieldRoutes API secret" type="password" />
                </div>
                {saveResult && (
                  <div className={`text-sm px-3 py-2 rounded-md border ${saveResult.success ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border-red-500/20 text-red-400"}`}>
                    {saveResult.message}
                  </div>
                )}
                <Button onClick={saveApiCredentials} disabled={saving} className="bg-blue-500 hover:bg-blue-600 text-white">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Credentials
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="techs" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-base">Add Technician</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input value={newTech.name} onChange={e => setNewTech(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Email</Label>
                    <Input value={newTech.email} onChange={e => setNewTech(p => ({ ...p, email: e.target.value }))} placeholder="email@company.com" type="email" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max Stops/Day</Label>
                    <Input value={newTech.maxStopsPerDay} onChange={e => setNewTech(p => ({ ...p, maxStopsPerDay: parseInt(e.target.value) || 15 }))} type="number" min={1} max={50} />
                  </div>
                </div>
                <Button
                  onClick={addTechnician}
                  disabled={addingTech || !newTech.name || !newTech.email}
                  className="mt-3 bg-blue-500 hover:bg-blue-600 text-white"
                >
                  {addingTech ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add Technician
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-base">Technicians ({techs.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {techs.map(tech => (
                    <div key={tech.id} className="flex items-center gap-3 p-4">
                      <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 text-xs font-bold shrink-0">
                        {tech.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{tech.name}</p>
                        <p className="text-xs text-muted-foreground">{tech.email} · Max {tech.maxStopsPerDay} stops/day</p>
                      </div>
                      <Switch checked={tech.active} onCheckedChange={() => toggleTechActive(tech)} />
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-red-400 h-8 w-8" onClick={() => deleteTechnician(tech.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  {techs.length === 0 && <p className="text-center text-muted-foreground py-8 text-sm">No technicians yet. Add one above.</p>}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="billing" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-base">Current Plan</CardTitle>
                <CardDescription>Manage your RouteIQ subscription</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-3 bg-accent/30 rounded-lg">
                  <div>
                    <p className="font-medium">Pro Plan</p>
                    <p className="text-sm text-muted-foreground">Unlimited routes · AI learning · Up to 10 technicians</p>
                  </div>
                  <Badge variant="success">Active</Badge>
                </div>
                <Button variant="outline" className="gap-2">
                  <ExternalLink className="w-4 h-4" />
                  Open Stripe Billing Portal
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-base">Notification Preferences</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {[
                  { label: "Email Notifications", desc: "Receive daily route summaries by email", value: emailNotifications, onChange: setEmailNotifications },
                ].map(pref => (
                  <div key={pref.label} className="flex items-center justify-between p-3 bg-accent/20 rounded-lg">
                    <div>
                      <Label className="font-medium">{pref.label}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">{pref.desc}</p>
                    </div>
                    <Switch checked={pref.value} onCheckedChange={pref.onChange} />
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
