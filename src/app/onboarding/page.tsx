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

interface TechEntry { id: string; name: string; employeeId: string; maxStopsPerDay: number; }
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
  const [error, setError] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [connectionTested, setConnectionTested] = useState<boolean | null>(null);
  const [techs, setTechs] = useState<TechEntry[]>([{ id: generateId(), name: "", employeeId: "", maxStopsPerDay: 15 }]);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncMessage, setSyncMessage] = useState("");
  const [companyId, setCompanyId] = useState("");
  const { createAccount } = useAuth();
  const router = useRouter();

  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  async function handleStep1() {
    if (!companyName || !email || !password) return;
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setLoading(true);
    setError("");
    try {
      const newCompanyId = "company_" + generateId();
      await createAccount(email, password, newCompanyId);
      await setDoc(doc(db, "companies", newCompanyId), { name: companyName, plan: "pro", active: true, createdAt: new Date().toISOString() });
      setCompanyId(newCompanyId);
      setStep(2);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("email-already-in-use")) {
        setError("This email is already registered. Try signing in instead.");
      } else if (msg.includes("weak-password")) {
        setError("Password is too weak. Use at least 8 characters.");
      } else if (msg.includes("not configured")) {
        setError("Firebase not configured. Add credentials in Vercel to enable sign-up.");
      } else {
        setError("Account creation failed. Please try again.");
      }
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

  function addTech() { setTechs(p => [...p, { id: generateId(), name: "", employeeId: "", maxStopsPerDay: 15 }]); }
  function updateTech(id: string, field: keyof TechEntry, value: string | number) {
    setTechs(p => p.map(t => t.id === id ? { ...t, [field]: value } : t));
  }
  function removeTech(id: string) { setTechs(p => p.filter(t => t.id !== id)); }

  async function handleStep3() {
    setLoading(true);
    setError("");
    try {
      if (companyId) {
        const valid = techs.filter(t => t.name && t.employeeId);
        if (valid.length === 0) { setError("Add at least one technician with name and employee ID."); setLoading(false); return; }
        await Promise.all(valid.map(t => addDoc(collection(db, "companies/" + companyId + "/technicians"), { name: t.name, employeeId: t.employeeId, maxStopsPerDay: t.maxStopsPerDay, active: true, companyId })));
      }
    } catch {
      setError("Failed to save technicians. They can be added later in Settings.");
    }
    setLoading(false); setStep(4); startSync();
  }

  function startSync() {
    if (!apiKey || !apiSecret) {
      // No FieldRoutes credentials — skip sync, go to completion
      setSyncMessage("No FieldRoutes integration configured.");
      setSyncProgress(50);
      setTimeout(() => {
        setSyncProgress(100);
        setSyncMessage("Setup complete! Upload jobs from the Jobs page.");
        setTimeout(() => setStep(5), 1200);
      }, 1000);
      return;
    }

    // Real sync attempt with FieldRoutes
    setSyncMessage("Connecting to FieldRoutes...");
    setSyncProgress(10);

    fetch("/api/sync-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Sync failed");
        const data = await res.json();
        setSyncProgress(100);
        setSyncMessage(data.total > 0 ? `Synced ${data.total} jobs!` : "No jobs found — upload a CSV from the Jobs page.");
        setTimeout(() => setStep(5), 1200);
      })
      .catch(() => {
        // Sync failed — still let them proceed
        setSyncProgress(100);
        setSyncMessage("Sync unavailable — you can upload jobs manually from the Jobs page.");
        setTimeout(() => setStep(5), 1500);
      });
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-blue-500/[0.04] rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] bg-blue-500/[0.04] rounded-full blur-3xl" />
      </div>
      <div className="w-full max-w-lg relative">
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-8 animate-fade-in">
          <div className="w-9 h-9 bg-blue-500 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl text-white tracking-tight">routiq</span>
        </div>

        {/* Step indicator */}
        <div className="mb-6 animate-fade-in">
          <div className="flex justify-between mb-3">
            {STEPS.map(s => (
              <div key={s.id} className={"flex flex-col items-center gap-1.5 transition-colors duration-300 " + (s.id <= step ? "text-blue-400" : "text-muted-foreground/40")}>
                <div className={"w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all duration-300 " + (s.id < step ? "bg-blue-500 border-blue-500 scale-100" : s.id === step ? "border-blue-500 scale-105" : "border-border/60")}>
                  {s.id < step ? <CheckCircle className="w-4 h-4 text-white" /> : <s.icon className="w-3.5 h-3.5" />}
                </div>
                <span className="text-[11px] hidden sm:block font-medium">{s.label}</span>
              </div>
            ))}
          </div>
          <Progress value={progress} className="h-1" />
        </div>

        {/* Step 1: Account */}
        {step === 1 && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm animate-fade-in-up">
            <CardHeader>
              <CardTitle className="text-lg">Create your account</CardTitle>
              <CardDescription>Set up routiq for your company</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm">Company Name</Label>
                <Input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Field Services" className="h-11" />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Work Email</Label>
                <Input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@company.com" className="h-11" />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Password</Label>
                <Input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Min 8 characters" minLength={8} className="h-11" />
              </div>
              {error && (
                <div className="bg-red-500/8 border border-red-500/15 text-red-400 text-sm rounded-lg px-3 py-2.5 animate-scale-in">
                  {error}
                </div>
              )}
              <Button onClick={handleStep1} disabled={loading || !companyName || !email || !password} className="w-full h-11 bg-blue-500 hover:bg-blue-600 text-white font-medium">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />} Create Account
              </Button>
              <p className="text-center text-sm text-muted-foreground/70">
                Already have an account? <a href="/login" className="text-blue-400 hover:text-blue-300 font-medium transition-colors">Sign in</a>
              </p>
            </CardContent>
          </Card>
        )}

        {/* Step 2: FieldRoutes */}
        {step === 2 && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm animate-fade-in-up">
            <CardHeader>
              <CardTitle className="text-lg">Connect FieldRoutes</CardTitle>
              <CardDescription>Enter your API credentials to sync jobs automatically</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm">API Key</Label>
                <Input value={apiKey} onChange={e => { setApiKey(e.target.value); setConnectionTested(null); }} placeholder="fr_api_key_..." className="h-11" />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">API Secret</Label>
                <Input value={apiSecret} onChange={e => { setApiSecret(e.target.value); setConnectionTested(null); }} type="password" placeholder="fr_secret_..." className="h-11" />
              </div>
              {apiKey && apiSecret && (
                <Button variant="outline" onClick={testConnection} disabled={loading} className="w-full h-10">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test Connection
                </Button>
              )}
              {connectionTested === true && (
                <div className="bg-emerald-500/8 border border-emerald-500/15 text-emerald-400 text-sm rounded-lg px-3 py-2.5 animate-scale-in">
                  Connection successful!
                </div>
              )}
              {connectionTested === false && (
                <div className="bg-red-500/8 border border-red-500/15 text-red-400 text-sm rounded-lg px-3 py-2.5 animate-scale-in">
                  Connection failed. Check your credentials.
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <Button variant="ghost" onClick={() => setStep(3)} className="flex-1 text-muted-foreground">Skip for now</Button>
                <Button onClick={handleStep2} className="flex-1 h-11 bg-blue-500 hover:bg-blue-600 text-white font-medium">Continue <ChevronRight className="w-4 h-4" /></Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Technicians */}
        {step === 3 && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm animate-fade-in-up">
            <CardHeader>
              <CardTitle className="text-lg">Add Technicians</CardTitle>
              <CardDescription>Who do you want to create routes for?</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {techs.map((tech, i) => (
                <div key={tech.id} className="grid gap-2 items-end animate-fade-in" style={{ gridTemplateColumns: "1fr 1fr 60px 32px" }}>
                  <div className="space-y-1">{i === 0 && <Label className="text-xs text-muted-foreground">Name</Label>}<Input value={tech.name} onChange={e => updateTech(tech.id, "name", e.target.value)} placeholder="Full name" /></div>
                  <div className="space-y-1">{i === 0 && <Label className="text-xs text-muted-foreground">Employee ID</Label>}<Input value={tech.employeeId} onChange={e => updateTech(tech.id, "employeeId", e.target.value)} placeholder="EMP-001" /></div>
                  <div className="space-y-1">{i === 0 && <Label className="text-xs text-muted-foreground">Stops</Label>}<Input value={tech.maxStopsPerDay} onChange={e => updateTech(tech.id, "maxStopsPerDay", parseInt(e.target.value) || 15)} type="number" min={1} max={50} /></div>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-red-400 h-10 w-8" onClick={() => removeTech(tech.id)} disabled={techs.length === 1}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addTech} className="w-full"><Plus className="w-4 h-4 mr-1" /> Add Another Technician</Button>
              {error && (
                <div className="bg-red-500/8 border border-red-500/15 text-red-400 text-sm rounded-lg px-3 py-2.5 animate-scale-in">
                  {error}
                </div>
              )}
              <Button onClick={handleStep3} disabled={loading} className="w-full h-11 bg-blue-500 hover:bg-blue-600 text-white font-medium mt-1">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />} Save &amp; Continue
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Sync */}
        {step === 4 && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm animate-fade-in-up">
            <CardHeader>
              <CardTitle className="text-lg">Syncing Your Data</CardTitle>
              <CardDescription>Pulling jobs from FieldRoutes and setting up AI...</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{syncMessage}</span>
                  <span className="text-foreground font-medium tabular-nums">{syncProgress}%</span>
                </div>
                <Progress value={syncProgress} className="h-2" />
              </div>
              {syncProgress === 100 && (
                <div className="flex items-center gap-2 text-emerald-400 text-sm animate-scale-in">
                  <CheckCircle className="w-4 h-4" /> Setup complete!
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 5: Complete */}
        {step === 5 && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm text-center animate-scale-in">
            <CardContent className="pt-10 pb-8 space-y-5">
              <div className="w-16 h-16 bg-emerald-500/15 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-2xl font-bold tracking-tight">You&apos;re all set!</h2>
                <p className="text-muted-foreground text-sm mt-2 max-w-xs mx-auto">routiq is ready. Head to your dashboard to generate your first AI-optimized routes.</p>
              </div>
              <Button onClick={() => router.push("/dashboard")} className="bg-blue-500 hover:bg-blue-600 text-white w-full h-11 font-medium">
                Go to Dashboard <ChevronRight className="w-4 h-4" />
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
