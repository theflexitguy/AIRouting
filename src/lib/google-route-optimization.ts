// Google Route Optimization API — the REAL optimizer.
//
// This is a different product from the Routes API used elsewhere in this repo:
//   Routes API              -> "how long from A to B" (matrix/directions), API key auth
//   Route Optimization API  -> "which tech gets which stops, in what order" (VRP solver),
//                              OAuth service-account auth. A Maps Platform API key does
//                              NOT work here; the request must carry a Bearer token.
//
// Assignment used to be a straight-line (haversine) heuristic, which is the single
// biggest lever on total drive time. This module hands that decision to Google's
// solver under the caps and pins the app already enforces.

import { GoogleAuth } from "google-auth-library";
import { serviceAccountCredentials } from "@/lib/firebase-admin";
import { departureTimeForRouteDate } from "@/lib/google-routing";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const ENDPOINT = "https://routeoptimization.googleapis.com/v1";

// Cost knobs. The solver minimizes total cost, so to minimize DRIVE TIME we put
// essentially all cost on travel: 60 cost units per traveled hour == 1 unit per
// traveled minute. DROP_PENALTY is what it "costs" to leave a job unrouted —
// far above any realistic detour, so a job is only dropped when capacity or the
// drive cap genuinely makes it infeasible (those come back as skipped shipments
// and are deferred by the caller, exactly like the custom engine's deferrals).
const COST_PER_TRAVELED_HOUR = 60;
const DROP_PENALTY = 100_000;
// Extra reluctance to drop a stop the caller marked as high priority (overdue).
const PRIORITY_DROP_PENALTY = 900_000;

export interface OptimizationStop {
  id: string;
  lat: number | null;
  lng: number | null;
  durationMinutes: number;
  /** Indices into the vehicles array this stop may be served by. Empty = any. */
  allowedVehicleIndices: number[];
  /** Overdue/protected work — much more expensive to leave unrouted. */
  priority?: boolean;
}

export interface OptimizationVehicle {
  /** Caller's slot key (tech+date); echoed back so results map home cleanly. */
  slotKey: string;
  /** Route date (YYYY-MM-DD) — sets this vehicle's shift window for traffic. */
  date?: string;
  maxStops: number;
  /** Tech start/end location. Omitted when the tech has no home coordinates. */
  start?: { lat: number; lng: number } | null;
  end?: { lat: number; lng: number } | null;
}

export interface OptimizationPlan {
  status: "ok" | "disabled" | "failed";
  /** slotKey -> ordered stop ids. Only present when status is "ok". */
  orderBySlotKey: Map<string, string[]>;
  /** Stop ids the solver could not fit (capacity / drive cap). */
  skippedStopIds: string[];
  googleDriveMinutes?: number;
  credentialSource?: string;
  projectId?: string;
  warnings: string[];
}

function emptyPlan(status: "disabled" | "failed", warnings: string[], extra: Partial<OptimizationPlan> = {}): OptimizationPlan {
  return { status, orderBySlotKey: new Map(), skippedStopIds: [], warnings, ...extra };
}

// --- Credentials -----------------------------------------------------------

interface Credential {
  source: string;
  projectId: string;
  /** Service-account identity, so a permission error can name the principal. */
  clientEmail?: string;
  auth?: GoogleAuth;
  staticToken?: string;
}

let cachedCredential: Credential | null | undefined;

function parseJsonCredential(raw: string) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const encoding of ["base64url", "base64"] as const) {
      try {
        return JSON.parse(Buffer.from(trimmed, encoding).toString("utf-8"));
      } catch {
        // try next
      }
    }
  }
  return null;
}

/**
 * Resolve credentials, preferring a dedicated service account, then the Firebase
 * one already in the environment (same GCP project, no new secret), then a raw
 * access token for backwards compatibility. Raw tokens expire in ~1 hour, so
 * they are a last resort, not the intended path.
 */
function resolveCredential(): Credential | null {
  if (cachedCredential !== undefined) return cachedCredential;

  const explicitProject = (
    process.env.GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    ""
  ).trim();

  const dedicatedRaw = (process.env.GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT || "").trim();
  if (dedicatedRaw) {
    const parsed = parseJsonCredential(dedicatedRaw);
    if (parsed?.client_email && parsed?.private_key) {
      if (typeof parsed.private_key === "string") parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      cachedCredential = {
        source: "GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT",
        projectId: explicitProject || String(parsed.project_id || ""),
        clientEmail: String(parsed.client_email || ""),
        auth: new GoogleAuth({ credentials: parsed, scopes: [SCOPE] }),
      };
      return cachedCredential;
    }
  }

  const firebaseCred = serviceAccountCredentials();
  if (firebaseCred?.client_email && firebaseCred?.private_key) {
    cachedCredential = {
      source: "FIREBASE_SERVICE_ACCOUNT",
      projectId: explicitProject || String(firebaseCred.project_id || ""),
      clientEmail: String(firebaseCred.client_email || ""),
      auth: new GoogleAuth({ credentials: firebaseCred, scopes: [SCOPE] }),
    };
    return cachedCredential;
  }

  const staticToken = (
    process.env.GOOGLE_ROUTE_OPTIMIZATION_ACCESS_TOKEN ||
    process.env.GOOGLE_CLOUD_ACCESS_TOKEN ||
    ""
  ).trim();
  if (staticToken && explicitProject) {
    cachedCredential = { source: "GOOGLE_ROUTE_OPTIMIZATION_ACCESS_TOKEN", projectId: explicitProject, staticToken };
    return cachedCredential;
  }

  cachedCredential = null;
  return cachedCredential;
}

async function getAccessToken(credential: Credential): Promise<string> {
  if (credential.staticToken) return credential.staticToken;
  if (!credential.auth) return "";
  // GoogleAuth caches and refreshes the token internally.
  const client = await credential.auth.getClient();
  const token = await client.getAccessToken();
  return typeof token === "string" ? token : token?.token || "";
}

/** Is the Route Optimization API usable in this environment? */
export function routeOptimizationConfig(): {
  configured: boolean;
  source: string;
  projectId: string;
  serviceAccountEmail: string;
} {
  const credential = resolveCredential();
  return {
    configured: Boolean(credential && credential.projectId),
    source: credential?.source || "none",
    projectId: credential?.projectId || "",
    // Named so an IAM denial says exactly WHICH principal needs the role.
    serviceAccountEmail: credential?.clientEmail || "",
  };
}

// --- Solver ----------------------------------------------------------------

const seconds = (minutes: number) => `${Math.max(1, Math.round(minutes * 60))}s`;
/**
 * ISO timestamp truncated to WHOLE SECONDS. Route Optimization maps these to
 * protobuf Timestamps and rejects any sub-second precision with
 * "`nanos` must be unset", so the milliseconds a JS toISOString() always emits
 * have to go.
 */
const isoSeconds = (value: string | number | Date) =>
  new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
const latLng = (p: { lat: number | null; lng: number | null }) => ({
  latitude: Number(p.lat),
  longitude: Number(p.lng),
});
const validPoint = (p: { lat: number | null; lng: number | null }) =>
  typeof p.lat === "number" && typeof p.lng === "number" &&
  Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0);

interface ShipmentRouteVisit { shipmentIndex?: number; isPickup?: boolean }
interface ShipmentRoute {
  vehicleIndex?: number;
  visits?: ShipmentRouteVisit[];
  metrics?: { travelDuration?: unknown };
  travelDuration?: unknown;
}

function durationSeconds(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replace(/s$/, "")) || 0;
  if (value && typeof value === "object" && "seconds" in value) {
    return Number((value as { seconds?: unknown }).seconds) || 0;
  }
  return 0;
}

/**
 * Solve assignment + sequencing for one generation run.
 *
 * Returns ordered stop ids per vehicle slot. Stops the solver could not fit come
 * back as skippedStopIds so the caller can defer them the same way its own
 * engine does. Any failure returns a non-"ok" status — callers MUST fall back to
 * the existing engine rather than treating this as authoritative.
 */
export async function optimizeTours({
  stops,
  vehicles,
  maxDriveMinutes,
  timeoutSeconds = 20,
}: {
  stops: OptimizationStop[];
  vehicles: OptimizationVehicle[];
  maxDriveMinutes: number;
  timeoutSeconds?: number;
}): Promise<OptimizationPlan> {
  const credential = resolveCredential();
  if (!credential || !credential.projectId) {
    return emptyPlan("disabled", [
      "Route Optimization is not configured. Provide a service account (GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT) and a project id. Note: a Maps Platform API key does not work for this API.",
    ], { credentialSource: credential?.source || "none", projectId: credential?.projectId || "" });
  }

  const routable = stops.filter(validPoint);
  if (routable.length === 0 || vehicles.length === 0) {
    return emptyPlan("disabled", ["No routable stops or vehicles for Route Optimization."], {
      credentialSource: credential.source,
      projectId: credential.projectId,
    });
  }

  let accessToken = "";
  try {
    accessToken = await getAccessToken(credential);
  } catch (error) {
    return emptyPlan("failed", [
      `Route Optimization auth failed (${credential.source}). ${error instanceof Error ? error.message : String(error)}`,
    ], { credentialSource: credential.source, projectId: credential.projectId });
  }
  if (!accessToken) {
    return emptyPlan("failed", [`Route Optimization auth returned no token (${credential.source}).`], {
      credentialSource: credential.source,
      projectId: credential.projectId,
    });
  }

  // Traffic-aware solving REQUIRES a global start time, and Google rejects one
  // that is in the past — which regenerating a past day would otherwise always
  // produce. departureTimeForRouteDate models 8am Central on the route date and
  // clamps to now+5min once that has passed, the same rule the drive-time
  // matrix already uses, so both engines model the same departure.
  const vehicleWindows = vehicles.map((vehicle) => {
    const start = isoSeconds(departureTimeForRouteDate(vehicle.date) || Date.now() + 5 * 60_000);
    // A generous shift window: wide enough never to force a stop to be dropped,
    // narrow enough to keep the traffic model on the right day.
    const end = isoSeconds(Date.parse(start) + 16 * 3600_000);
    return { start, end };
  });
  const globalStartTime = vehicleWindows.reduce(
    (earliest, w) => (Date.parse(w.start) < Date.parse(earliest) ? w.start : earliest),
    vehicleWindows[0].start,
  );
  const globalEndTime = vehicleWindows.reduce(
    (latest, w) => (Date.parse(w.end) > Date.parse(latest) ? w.end : latest),
    vehicleWindows[0].end,
  );

  const body = {
    // Give the solver real time to work; this runs once per generation.
    timeout: seconds(timeoutSeconds / 60),
    considerRoadTraffic: true,
    populatePolylines: false,
    populateTransitionPolylines: false,
    model: {
      globalStartTime,
      globalEndTime,
      shipments: routable.map((stop, index) => ({
        label: stop.id || String(index),
        // Leaving a stop unrouted is expensive, so the solver only does it when
        // capacity or the drive cap makes it impossible.
        penaltyCost: stop.priority ? PRIORITY_DROP_PENALTY : DROP_PENALTY,
        ...(stop.allowedVehicleIndices.length > 0
          ? { allowedVehicleIndices: stop.allowedVehicleIndices }
          : {}),
        deliveries: [
          {
            arrivalLocation: latLng(stop),
            duration: seconds(stop.durationMinutes || 25),
          },
        ],
      })),
      vehicles: vehicles.map((vehicle, index) => ({
        label: vehicle.slotKey,
        // Per-vehicle shift so a multi-day run models each day's own traffic.
        startTimeWindows: [
          { startTime: vehicleWindows[index].start, endTime: vehicleWindows[index].end },
        ],
        // All cost on travel time == minimize drive.
        costPerTraveledHour: COST_PER_TRAVELED_HOUR,
        ...(vehicle.start && validPoint(vehicle.start) ? { startLocation: latLng(vehicle.start) } : {}),
        ...(vehicle.end && validPoint(vehicle.end) ? { endLocation: latLng(vehicle.end) } : {}),
        loadLimits: { stops: { maxLoad: String(Math.max(1, vehicle.maxStops)) } },
        // travelDurationLimit is DRIVE time only. (routeDurationLimit would also
        // count service time, which is not what maxDriveTime means in this app.)
        ...(maxDriveMinutes > 0
          ? { travelDurationLimit: { maxDuration: seconds(maxDriveMinutes) } }
          : {}),
      })),
    },
  };

  let payload: unknown;
  try {
    const response = await fetch(`${ENDPOINT}/projects/${credential.projectId}:optimizeTours`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((timeoutSeconds + 20) * 1000),
    });
    payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        (payload as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;
      return emptyPlan("failed", [`Route Optimization API error: ${message}`], {
        credentialSource: credential.source,
        projectId: credential.projectId,
      });
    }
  } catch (error) {
    return emptyPlan("failed", [
      `Route Optimization request failed. ${error instanceof Error ? error.message : String(error)}`,
    ], { credentialSource: credential.source, projectId: credential.projectId });
  }

  const parsed = payload as {
    routes?: ShipmentRoute[];
    shipmentRoutes?: ShipmentRoute[];
    skippedShipments?: Array<{ index?: number; label?: string }>;
  };
  const shipmentRoutes = parsed.routes || parsed.shipmentRoutes || [];

  const orderBySlotKey = new Map<string, string[]>();
  let travelSeconds = 0;
  for (const route of shipmentRoutes) {
    // proto3 omits zero-valued fields, so an absent index means 0.
    const vehicleIndex = Number(route.vehicleIndex ?? 0);
    const vehicle = vehicles[vehicleIndex];
    if (!vehicle) continue;
    travelSeconds += durationSeconds(route.metrics?.travelDuration) + durationSeconds(route.travelDuration);
    const ids: string[] = [];
    for (const visit of route.visits || []) {
      const shipmentIndex = Number(visit.shipmentIndex ?? 0);
      const stop = routable[shipmentIndex];
      if (stop) ids.push(stop.id);
    }
    if (ids.length > 0) orderBySlotKey.set(vehicle.slotKey, ids);
  }

  const skippedStopIds = (parsed.skippedShipments || [])
    .map((s) => routable[Number(s.index ?? 0)]?.id || String(s.label || ""))
    .filter(Boolean);

  if (orderBySlotKey.size === 0) {
    return emptyPlan("failed", ["Route Optimization returned no routes."], {
      credentialSource: credential.source,
      projectId: credential.projectId,
    });
  }

  return {
    status: "ok",
    orderBySlotKey,
    skippedStopIds,
    googleDriveMinutes: travelSeconds > 0 ? Math.round((travelSeconds / 60) * 10) / 10 : undefined,
    credentialSource: credential.source,
    projectId: credential.projectId,
    warnings: [],
  };
}
