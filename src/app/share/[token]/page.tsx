"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapPin, Clock, CheckCircle, AlertTriangle } from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";

interface SharedRoute {
  companyId: string;
  routeId: string;
  techName: string;
  date: string;
  expiresAt: string;
  totalStops: number;
  totalDriveTimeMinutes: number;
  confidence: number;
  approved: boolean;
  stops: Array<{
    customerName: string;
    address: string;
    serviceType: string;
    duration: number;
  }>;
}

export default function SharedRoutePage() {
  const params = useParams();
  const token = params.token as string;
  const [route, setRoute] = useState<SharedRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    loadSharedRoute(token);
  }, [token]);

  async function loadSharedRoute(shareToken: string) {
    try {
      const shareDoc = await getDoc(doc(db, "sharedRoutes", shareToken));
      if (!shareDoc.exists()) {
        setError("This route link is invalid or has expired.");
        setLoading(false);
        return;
      }

      const data = shareDoc.data() as SharedRoute;

      if (new Date(data.expiresAt) < new Date()) {
        setError("This route link has expired.");
        setLoading(false);
        return;
      }

      setRoute(data);
    } catch {
      setError("Failed to load route. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full border-border/40">
          <CardContent className="pt-10 pb-8 text-center space-y-4">
            <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto" />
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!route) return null;

  const formatTime = (min: number) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border/60 px-4 py-4">
        <div className="max-w-lg mx-auto flex items-center gap-2.5">
          <Image src="/icons/icon-512.png" alt="routiq" width={32} height={32} className="w-8 h-8 rounded-lg shadow-lg shadow-black/30" />
          <span className="font-bold text-lg text-foreground">routiq</span>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Route info */}
        <Card className="border-border/40">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{route.techName}</CardTitle>
              <Badge variant={route.approved ? "success" : "warning"}>
                {route.approved ? "Approved" : "Pending"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{route.date}</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-accent/30 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-foreground">{route.totalStops}</p>
                <p className="text-[11px] text-muted-foreground/60">Stops</p>
              </div>
              <div className="bg-accent/30 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-foreground">{formatTime(route.totalDriveTimeMinutes)}</p>
                <p className="text-[11px] text-muted-foreground/60">Drive Time</p>
              </div>
              <div className="bg-accent/30 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-foreground">{Math.round(route.confidence * 100)}%</p>
                <p className="text-[11px] text-muted-foreground/60">Confidence</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stop list */}
        <Card className="border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Stop Sequence</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/30">
              {route.stops.map((stop, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3">
                  <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-[11px] font-bold text-white shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-foreground">{stop.customerName}</p>
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground/60">
                      <MapPin className="w-3 h-3 shrink-0" />
                      <span className="truncate">{stop.address}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground/50">
                      {stop.serviceType && <span>{stop.serviceType}</span>}
                      {stop.duration > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {stop.duration}m
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground/40 pb-6">
          <CheckCircle className="w-3 h-3 inline mr-1" />
          Shared via routiq
        </p>
      </div>
    </div>
  );
}
