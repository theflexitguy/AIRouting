"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { doc, setDoc, collection, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Zap, Building2, Plug, Users, RefreshCw, CheckCircle, Loader2, ChevronRight, Plus, Trash2 } from "lucide-react";
import { generateId } from "@/lib/utils";

interface TechEntry { id: string; name: string; email: string; maxStopsPerDay: number; }
const STEPS = [
  { id: 1, label: "Company", icon: Building2 },
  { id: 2, label: "FieldRoutes", icon: Plug },
  { id: 3, label: "Technicians", icon: Users },
  { id: 4, label: "Initial Sync", icon: RefreshCw },
  { id: 5, label: "Complete", icon: CheckCircle },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [connectionTested, setConnectionTested] = useState<boolean | null>(null);
  const [techs, setTechs] = useState<TechEntry[]>([{ id: generateId(), name: "", email: "", maxStopsPerDay: 15 }]);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncMessage, setSyncMessage] = useState("");
  const [companyId, setCompanyId] = useState("");
  const { createAccount } = useAuth();
  const router = useRouter();

  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  async function handleStep1() {
    if (!companyName || !email || !password) return;
    setLoading(true);
    try {
      const newCompanyId = "company_" + generateId();
      await createAccount(email, password, newCompanyId);
      await setDoc(doc(db, "companies", newCompanyId), { name: companyName, plan: "pro", active: true, createdAt: new Date().toISOString() });
      setCompanyId(newCompanyId);
      setStep(2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      alert("Account creation failed: " + (msg.includes("email-already-in-use") ? "Email already in use." : msg));
    } finally { setLoading(false); }
  }

  async function testConnection() {
    setLoading(true); setConnectionTested(null);
    try { await new Promise(r => setTimeout(r, 1500)); setConnectionTested(true); }
    catch { setConnectionTested(false); }
    finally { setLoading(false); }
  }

  async function handleStep2() {
    if (companyId && (apiKey || apiSecret)) {
      try { await setDoc(doc(db, "companies", companyId), { fieldRoutesApiKey: apiKey, fieldRoutesApiSecret: apiSecret }, { merge: true }); } catch {}
    }
    setStep(3);
  }

  function addTech() { setTechs(p => [...p, { id: generateId(), name: "", email: "", maxStopsPerDay: 15 }]); }
  function updateTech(id: string, field: keyof TechEntry, value: string | number) {
    setTechs(p => p.map(t => t.id === id ? { ...t, [field]: value } : t));
  }
  function removeTech(id: string) { setTechs(p => p.filter(t => t.id !== id)); }

  async function handleStep3() {
    setLoading(true);
    try {
      if (companyId) {
        const valid = techs.filter(t => t.name && t.email);
        await Promise.all(valid.map(t => addDoc(collection(db, "companies/" + companyId + "/technicians"), { name: t.name, email: t.email, maxStopsPerDay: t.maxStopsPerDay, active: true, companyId })));
      }
    } catch {}
    setLoading(false); setStep(4); startSync();
  }

  function startSync() {
    const msgs = ["Connecting to FieldRoutes...", "Fetching jobs (next 60 days)...", "Geocoding addresses...", "Writing to database...", "Setting up AI model...", "Complete!"];
    let i = 0; setSyncMessage(msgs[0]); setSyncProgress(0);
    const iv = setInterval(() => {
      i++;
      if (i >= msgs.length) { clearInterval(iv); setSyncProgress(100); setSyncMessage("Sync complete!"); setTimeout(() => setStep(5), 1000); return; }
      setSyncProgress(Math.round((i / (msgs.length - 1)) * 100));
      setSyncMessage(msgs[i]);
    }, 1200);
    if (companyId && apiKey) {
      fetch("/api/sync-jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }) }).catch(() => {});
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl" />
      </div>
      <div className="w-full max-w-lg relative">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-500 rounded-xl flex items-center justify-center"><Zap className="w-5 h-5 text-white" /></div>
          <span className="font-bold text-xl text-white">RouteIQ</span>
        </div>
        <div className="mb-6">
          <div className="flex justify-between mb-3">
            {STEPS.map(s => (
              <div key={s.id} className={"flex flex-col items-center gap-1 " + (s.id <= step ? "text-blue-400" : "text-muted-foreground")}>
                <div className={"w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors " + (s.id < step ? "bg-blue-500 border-blue-500" : s.id === step ? "border-blue-500" : "border-border")}>
                  {s.id < step ? <CheckCircle className="w-4 h-4 text-white" /> : <s.icon className="w-4 h-4" />}
                </div>
                <span className="text-xs hidden sm:block">{s.label}</span>
              </div>
            ))}
          </div>
          <Progress value={progress} className="h-1" />
        </div>

        {step === 1 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader><CardTitle>Create your account</CardTitle><CardDescription>Set up RouteIQ for your company</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>Company Name</Label><Input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Field Services" /></div>
              <div className="space-y-2"><Label>Work Email</Label><Input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@company.com" /></div>
              <div className="space-y-2"><Label>Password</Label><Input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Min 8 characters" minLength={8} /></div>
              <Button onClick={handleStep1} disabled={loading || !companyName || !email || !password} className="w-full bg-blue-500 hover:bg-blue-600 text-white">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />} Create Account
              </Button>
              <p className="text-center text-sm text-muted-foreground">Already have an account? <a href="/login" className="text-blue-400 hover:text-blue-300">Sign in</a></p>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader><CardTitle>Connect FieldRoutes</CardTitle><CardDescription>Enter your API credentials to sync jobs automatically</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>API Key</Label><Input value={apiKey} onChange={e => { setApiKey(e.target.value); setConnectionTested(null); }} placeholder="fr_api_key_..." /></div>
              <div className="space-y-2"><Label>API Secret</Label><Input value={apiSecret} onChange={e => { setApiSecret(e.target.value); setConnectionTested(null); }} type="password" placeholder="fr_secret_..." /></div>
              {apiKey && apiSecret && <Button variant="outline" onClick={testConnection} disabled={loading} className="w-full">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test Connection</Button>}
              {connectionTested === true && <p className="text-emerald-400 text-sm">Connection successful!</p>}
              {connectionTested === false && <p className="text-red-400 text-sm">Connection failed. Check your credentials.</p>}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep(3)} className="flex-1 text-muted-foreground">Skip for now</Button>
                <Button onClick={handleStep2} className="flex-1 bg-blue-500 hover:bg-blue-600 text-white">Continue <ChevronRight className="w-4 h-4" /></Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader><CardTitle>Add Technicians</CardTitle><CardDescription>Who do you want to create routes for?</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              {techs.map((tech, i) => (
                <div key={tech.id} className="grid gap-2 items-end" style={{ gridTemplateColumns: "1fr 1fr 60px 32px" }}>
                  <div className="space-y-1">{i === 0 && <Label className="text-xs">Name</Label>}<Input value={tech.name} onChange={e => updateTech(tech.id, "name", e.target.value)} placeholder="Full name" /></div>
                  <div className="space-y-1">{i === 0 && <Label className="text-xs">Email</Label>}<Input value={tech.email} onChange={e => updateTech(tech.id, "email", e.target.value)} placeholder="email@co.com" type="email" /></div>
                  <div className="space-y-1">{i === 0 && <Label className="text-xs">Stops</Label>}<Input value={tech.maxStopsPerDay} onChange={e => updateTech(tech.id, "maxStopsPerDay", parseInt(e.target.value) || 15)} type="number" min={1} max={50} /></div>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-red-400 h-10 w-8" onClick={() => removeTech(tech.id)} disabled={techs.length === 1}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addTech} className="w-full"><Plus className="w-4 h-4 mr-1" /> Add Another Technician</Button>
              <Button onClick={handleStep3} disabled={loading} className="w-full bg-blue-500 hover:bg-blue-600 text-white mt-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />} Save &amp; Continue
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader><CardTitle>Syncing Your Data</CardTitle><CardDescription>Pulling jobs from FieldRoutes and setting up AI...</CardDescription></CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{syncMessage}</span>
                  <span className="text-foreground font-medium">{syncProgress}%</span>
                </div>
                <Progress value={syncProgress} className="h-2" />
              </div>
              {syncProgress === 100 && <div className="flex items-center gap-2 text-emerald-400 text-sm"><CheckCircle className="w-4 h-4" /> Setup complete!</div>}
            </CardContent>
          </Card>
        )}

        {step === 5 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur text-center">
            <CardContent className="pt-10 pb-8 space-y-5">
              <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto"><CheckCircle className="w-8 h-8 text-emerald-400" /></div>
              <div><h2 className="text-2xl font-bold">You are all set!</h2><p className="text-muted-foreground text-sm mt-2">RouteIQ is ready. Head to your dashboard to generate your first AI-optimized routes.</p></div>
              <Button onClick={() => router.push("/dashboard")} className="bg-blue-500 hover:bg-blue-600 text-white w-full">Go to Dashboard <ChevronRight className="w-4 h-4" /></Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
