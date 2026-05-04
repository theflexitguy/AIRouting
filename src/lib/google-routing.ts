export type RoutePoint = {
  id?: string;
  lat?: number | null;
  lng?: number | null;
  duration?: number | null;
  assignedTechId?: string | null;
  allowedVehicleIndices?: number[];
};

export type MatrixSource = "routes_api_matrix" | "haversine_fallback";
export type PolylineSource = "routes_api_polyline" | "haversine_fallback";

export interface RouteMatrixResult {
  matrix: number[][];
  source: MatrixSource;
  failedElements: number;
  warnings: string[];
}

export interface RouteGeometryResult {
  encodedPolyline?: string;
  path: Array<{ lat: number; lng: number }>;
  driveMinutes: number;
  distanceMeters?: number;
  status: string;
  failedSegments: number;
  driveTimeSource: "routes_api_polyline" | "haversine_fallback";
  polylineSource: PolylineSource;
  warnings: string[];
}

export interface RouteOptimizationShadowVehicle {
  date: string;
  techId: string;
  techName?: string;
  maxStops?: number;
}

export interface RouteOptimizationShadowRoute {
  id?: string;
  date?: string;
  techId?: string;
  techName?: string;
  totalDriveMinutes?: number;
  totalWorkMinutes?: number;
  stops?: RoutePoint[];
}

export interface RouteOptimizationShadowResult {
  status: "disabled" | "ok" | "failed";
  runId?: string;
  score?: number;
  googleDriveMinutes?: number;
  customDriveMinutes?: number;
  routeCount?: number;
  warnings: string[];
  rawStatus?: string;
}

const MATRIX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const POLYLINE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 600;
const DEFAULT_TRAFFIC_MODE = "TRAFFIC_AWARE";
const MAX_COMPUTE_ROUTES_STOPS = 27;

type CacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

type RouteMatrixElement = {
  originIndex?: number;
  destinationIndex?: number;
  status?: { code?: number; message?: string } | string;
  condition?: string;
  duration?: string;
  distanceMeters?: number;
};

type ComputeRoutesPayload = {
  routes?: Array<{
    duration?: string;
    distanceMeters?: number;
    polyline?: {
      encodedPolyline?: string;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

const matrixCache = new Map<string, CacheEntry<RouteMatrixResult>>();
const polylineCache = new Map<string, CacheEntry<RouteGeometryResult>>();

export function getGoogleMapsServerApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    ""
  ).trim();
}

export function hasGoogleRoutesApiKey() {
  return getGoogleMapsServerApiKey().length > 0;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const radiusMiles = 3958.7613;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
  return radiusMiles * 2 * Math.asin(Math.sqrt(a));
}

function estimateDriveMinutes(a: RoutePoint, b: RoutePoint) {
  if (!isValidPoint(a) || !isValidPoint(b)) return 0;
  return (haversineMiles(a.lat, a.lng, b.lat, b.lng) / 30) * 60;
}

function fallbackDriveMatrix(points: RoutePoint[]) {
  return points.map((from, fromIdx) =>
    points.map((to, toIdx) =>
      fromIdx === toIdx ? 0 : estimateDriveMinutes(from, to),
    ),
  );
}

function fallbackRouteDriveMinutes(points: RoutePoint[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += estimateDriveMinutes(points[i - 1], points[i]);
  }
  return total;
}

function isValidPoint(point: RoutePoint): point is RoutePoint & {
  lat: number;
  lng: number;
} {
  return (
    typeof point.lat === "number" &&
    Number.isFinite(point.lat) &&
    typeof point.lng === "number" &&
    Number.isFinite(point.lng)
  );
}

function pointCacheKey(point: RoutePoint) {
  return isValidPoint(point)
    ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`
    : "invalid";
}

function routeCacheKey(points: RoutePoint[], routeDate?: string, trafficMode = DEFAULT_TRAFFIC_MODE) {
  return [
    routeDate || "now",
    trafficMode,
    points.map(pointCacheKey).join("|"),
  ].join("::");
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: Promise<T>, ttlMs: number) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
}

function parseDurationSeconds(value?: string | null) {
  if (!value) return 0;
  const match = String(value).match(/^(-?\d+(?:\.\d+)?)s$/);
  if (!match) return 0;
  return Math.max(0, Number(match[1]) || 0);
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

function departureTimeForRouteDate(routeDate?: string) {
  if (!routeDate || !/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return undefined;
  const [year, month, day] = routeDate.split("-").map(Number);
  const localHour = 8;
  const localMinute = 0;
  const timeZone = "America/Chicago";
  let utcDate = new Date(Date.UTC(year, month - 1, day, localHour, localMinute, 0));
  let offsetMinutes = getTimeZoneOffsetMinutes(utcDate, timeZone);
  utcDate = new Date(
    Date.UTC(year, month - 1, day, localHour, localMinute, 0) -
      offsetMinutes * 60000,
  );
  offsetMinutes = getTimeZoneOffsetMinutes(utcDate, timeZone);
  utcDate = new Date(
    Date.UTC(year, month - 1, day, localHour, localMinute, 0) -
      offsetMinutes * 60000,
  );
  if (utcDate.getTime() <= Date.now() + 5 * 60 * 1000) {
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }
  return utcDate.toISOString();
}

function latLng(point: RoutePoint) {
  return {
    latitude: Number(point.lat),
    longitude: Number(point.lng),
  };
}

function waypoint(point: RoutePoint) {
  return {
    location: {
      latLng: latLng(point),
    },
  };
}

function matrixWaypoint(point: RoutePoint) {
  return {
    waypoint: waypoint(point),
  };
}

function statusCode(value: RouteMatrixElement["status"]) {
  if (!value) return 0;
  if (typeof value === "string") return value === "OK" ? 0 : 1;
  return Number(value.code || 0);
}

function warningFromGoogleError(prefix: string, payload: unknown) {
  const error = payload as {
    error?: { status?: string; message?: string; code?: number };
    status?: string;
    message?: string;
  };
  const status = error.error?.status || error.status || "UNKNOWN";
  const message = error.error?.message || error.message || "Google Routes request failed";
  return `${prefix}: ${status} ${message}`.trim();
}

export async function computeRouteMatrix(
  points: RoutePoint[],
  options: { routeDate?: string; trafficMode?: string } = {},
): Promise<RouteMatrixResult> {
  const fallback = fallbackDriveMatrix(points);
  if (points.length <= 1) {
    return { matrix: fallback, source: "haversine_fallback", failedElements: 0, warnings: [] };
  }
  if (!hasGoogleRoutesApiKey()) {
    return {
      matrix: fallback,
      source: "haversine_fallback",
      failedElements: Math.max(0, points.length * points.length - points.length),
      warnings: ["GOOGLE_MAPS_API_KEY is not configured; using haversine_fallback drive estimates."],
    };
  }
  if (points.some((point) => !isValidPoint(point))) {
    return {
      matrix: fallback,
      source: "haversine_fallback",
      failedElements: Math.max(0, points.length * points.length - points.length),
      warnings: ["One or more stops are missing coordinates; using haversine_fallback drive estimates."],
    };
  }

  const trafficMode = options.trafficMode || DEFAULT_TRAFFIC_MODE;
  const key = routeCacheKey(points, options.routeDate, trafficMode);
  const cached = getCached(matrixCache, key);
  if (cached) return cached;

  const promise = (async (): Promise<RouteMatrixResult> => {
    try {
      const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": getGoogleMapsServerApiKey(),
          "X-Goog-FieldMask": "originIndex,destinationIndex,status,condition,distanceMeters,duration",
        },
        body: JSON.stringify({
          origins: points.map(matrixWaypoint),
          destinations: points.map(matrixWaypoint),
          travelMode: "DRIVE",
          routingPreference: trafficMode,
          departureTime: departureTimeForRouteDate(options.routeDate),
        }),
        signal: AbortSignal.timeout(30000),
      });

      const payload = (await res.json().catch(() => null)) as RouteMatrixElement[] | unknown;
      if (!res.ok || !Array.isArray(payload)) {
        return {
          matrix: fallback,
          source: "haversine_fallback",
          failedElements: Math.max(0, points.length * points.length - points.length),
          warnings: [warningFromGoogleError(`Routes API Compute Route Matrix HTTP ${res.status}`, payload)],
        };
      }

      const matrix = fallback.map((row) => [...row]);
      let failedElements = 0;

      payload.forEach((element) => {
        const originIndex = Number(element.originIndex);
        const destinationIndex = Number(element.destinationIndex);
        if (
          !Number.isInteger(originIndex) ||
          !Number.isInteger(destinationIndex) ||
          !matrix[originIndex]
        ) {
          failedElements++;
          return;
        }
        if (originIndex === destinationIndex) {
          matrix[originIndex][destinationIndex] = 0;
          return;
        }
        const seconds = parseDurationSeconds(element.duration);
        const elementStatus = statusCode(element.status);
        if (elementStatus !== 0 || seconds <= 0) {
          failedElements++;
          return;
        }
        matrix[originIndex][destinationIndex] = seconds / 60;
      });

      return {
        matrix,
        source: "routes_api_matrix",
        failedElements,
        warnings:
          failedElements > 0
            ? [`Routes API Compute Route Matrix missed ${failedElements} element(s); missing elements used haversine_fallback estimates.`]
            : [],
      };
    } catch (error) {
      return {
        matrix: fallback,
        source: "haversine_fallback",
        failedElements: Math.max(0, points.length * points.length - points.length),
        warnings: [`Routes API Compute Route Matrix failed; using haversine_fallback estimates. ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  })();

  setCached(matrixCache, key, promise, MATRIX_CACHE_TTL_MS);
  return promise;
}

function appendDecodedPath(
  target: Array<{ lat: number; lng: number }>,
  encodedPolyline?: string,
) {
  if (!encodedPolyline) return;
  const decoded = decodeEncodedPolyline(encodedPolyline);
  if (target.length > 0 && decoded.length > 0) {
    target.push(...decoded.slice(1));
  } else {
    target.push(...decoded);
  }
}

async function computeRouteGeometryChunk(
  points: RoutePoint[],
  routeDate?: string,
  trafficMode = DEFAULT_TRAFFIC_MODE,
): Promise<RouteGeometryResult> {
  const fallbackDrive = fallbackRouteDriveMinutes(points);
  if (points.length < 2) {
    return {
      path: [],
      driveMinutes: 0,
      status: "NO_STOPS",
      failedSegments: 0,
      driveTimeSource: "haversine_fallback",
      polylineSource: "haversine_fallback",
      warnings: [],
    };
  }

  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleMapsServerApiKey(),
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: waypoint(points[0]),
        destination: waypoint(points[points.length - 1]),
        intermediates: points.slice(1, -1).map(waypoint),
        travelMode: "DRIVE",
        routingPreference: trafficMode,
        polylineQuality: "HIGH_QUALITY",
        polylineEncoding: "ENCODED_POLYLINE",
        departureTime: departureTimeForRouteDate(routeDate),
      }),
      signal: AbortSignal.timeout(30000),
    });

    const payload = (await res.json().catch(() => null)) as ComputeRoutesPayload | null;
    const route = payload?.routes?.[0];
    const encodedPolyline = route?.polyline?.encodedPolyline;
    const seconds = parseDurationSeconds(route?.duration);
    if (!res.ok || !route || !encodedPolyline || seconds <= 0) {
      return {
        path: [],
        driveMinutes: fallbackDrive,
        status: payload?.error?.status || `HTTP_${res.status}`,
        failedSegments: Math.max(0, points.length - 1),
        driveTimeSource: "haversine_fallback",
        polylineSource: "haversine_fallback",
        warnings: [warningFromGoogleError(`Routes API Compute Routes HTTP ${res.status}`, payload)],
      };
    }

    return {
      encodedPolyline,
      path: decodeEncodedPolyline(encodedPolyline),
      driveMinutes: seconds / 60,
      distanceMeters: route.distanceMeters,
      status: "OK",
      failedSegments: 0,
      driveTimeSource: "routes_api_polyline",
      polylineSource: "routes_api_polyline",
      warnings: [],
    };
  } catch (error) {
    return {
      path: [],
      driveMinutes: fallbackDrive,
      status: "REQUEST_FAILED",
      failedSegments: Math.max(0, points.length - 1),
      driveTimeSource: "haversine_fallback",
      polylineSource: "haversine_fallback",
      warnings: [`Routes API Compute Routes failed; using haversine_fallback drive estimates. ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export async function computeRouteGeometry(
  points: RoutePoint[],
  options: { routeDate?: string; trafficMode?: string } = {},
): Promise<RouteGeometryResult> {
  const fallbackDrive = fallbackRouteDriveMinutes(points);
  if (points.length < 2) {
    return {
      path: [],
      driveMinutes: 0,
      status: "NO_STOPS",
      failedSegments: 0,
      driveTimeSource: "haversine_fallback",
      polylineSource: "haversine_fallback",
      warnings: [],
    };
  }
  if (!hasGoogleRoutesApiKey()) {
    return {
      path: [],
      driveMinutes: fallbackDrive,
      status: "MISSING_GOOGLE_MAPS_API_KEY",
      failedSegments: Math.max(0, points.length - 1),
      driveTimeSource: "haversine_fallback",
      polylineSource: "haversine_fallback",
      warnings: ["GOOGLE_MAPS_API_KEY is not configured; route geometry cannot be snapped to roads."],
    };
  }
  if (points.some((point) => !isValidPoint(point))) {
    return {
      path: [],
      driveMinutes: fallbackDrive,
      status: "INVALID_COORDINATES",
      failedSegments: Math.max(0, points.length - 1),
      driveTimeSource: "haversine_fallback",
      polylineSource: "haversine_fallback",
      warnings: ["One or more stops are missing coordinates; route geometry cannot be snapped to roads."],
    };
  }

  const trafficMode = options.trafficMode || DEFAULT_TRAFFIC_MODE;
  const key = routeCacheKey(points, options.routeDate, trafficMode);
  const cached = getCached(polylineCache, key);
  if (cached) return cached;

  const promise = (async (): Promise<RouteGeometryResult> => {
    if (points.length <= MAX_COMPUTE_ROUTES_STOPS) {
      return computeRouteGeometryChunk(points, options.routeDate, trafficMode);
    }

    const path: Array<{ lat: number; lng: number }> = [];
    const encodedParts: string[] = [];
    let driveMinutes = 0;
    let distanceMeters = 0;
    let failedSegments = 0;
    const warnings: string[] = [];
    let status = "OK";

    for (let start = 0; start < points.length - 1; start += MAX_COMPUTE_ROUTES_STOPS - 1) {
      const chunk = points.slice(start, start + MAX_COMPUTE_ROUTES_STOPS);
      if (chunk.length < 2) break;
      const chunkResult = await computeRouteGeometryChunk(chunk, options.routeDate, trafficMode);
      if (chunkResult.polylineSource !== "routes_api_polyline") {
        failedSegments += chunkResult.failedSegments;
        warnings.push(...chunkResult.warnings);
        status = chunkResult.status;
        continue;
      }
      driveMinutes += chunkResult.driveMinutes;
      distanceMeters += chunkResult.distanceMeters || 0;
      if (chunkResult.encodedPolyline) encodedParts.push(chunkResult.encodedPolyline);
      appendDecodedPath(path, chunkResult.encodedPolyline);
    }

    if (failedSegments > 0 || path.length === 0) {
      return {
        path: [],
        driveMinutes: fallbackDrive,
        distanceMeters,
        status,
        failedSegments: Math.max(failedSegments, 1),
        driveTimeSource: "haversine_fallback",
        polylineSource: "haversine_fallback",
        warnings: warnings.length > 0 ? warnings : ["Routes API Compute Routes did not return road geometry for all route chunks."],
      };
    }

    return {
      encodedPolyline: encodedParts.join("|"),
      path,
      driveMinutes,
      distanceMeters,
      status: "OK",
      failedSegments: 0,
      driveTimeSource: "routes_api_polyline",
      polylineSource: "routes_api_polyline",
      warnings,
    };
  })();

  setCached(polylineCache, key, promise, POLYLINE_CACHE_TTL_MS);
  return promise;
}

export function decodeEncodedPolyline(encoded: string) {
  const path: Array<{ lat: number; lng: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    path.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return path;
}

function getRouteOptimizationAccessToken() {
  return (
    process.env.GOOGLE_ROUTE_OPTIMIZATION_ACCESS_TOKEN ||
    process.env.GOOGLE_CLOUD_ACCESS_TOKEN ||
    ""
  ).trim();
}

function getRouteOptimizationProjectId() {
  return (
    process.env.GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    ""
  ).trim();
}

function routeOptimizationParent() {
  const projectId = getRouteOptimizationProjectId();
  if (!projectId) return "";
  const location = (process.env.GOOGLE_ROUTE_OPTIMIZATION_LOCATION || "global").trim();
  return location && location !== "global"
    ? `projects/${projectId}/locations/${location}`
    : `projects/${projectId}`;
}

function routeOptimizationDuration(minutes: number) {
  return `${Math.max(1, Math.round(minutes * 60))}s`;
}

function numericDurationSeconds(value: unknown) {
  if (typeof value === "string") return parseDurationSeconds(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function routeOptimizationDriveSeconds(response: unknown) {
  const payload = response as {
    routes?: Array<{
      metrics?: Record<string, unknown>;
      travelDuration?: unknown;
      totalTravelDuration?: unknown;
    }>;
    shipmentRoutes?: Array<{
      metrics?: Record<string, unknown>;
      travelDuration?: unknown;
      totalTravelDuration?: unknown;
    }>;
  };
  const routes = payload.routes || payload.shipmentRoutes || [];
  return routes.reduce((total, route) => {
    const metrics = route.metrics || {};
    return (
      total +
      numericDurationSeconds(metrics.travelDuration) +
      numericDurationSeconds(route.travelDuration) +
      numericDurationSeconds(route.totalTravelDuration)
    );
  }, 0);
}

export async function runRouteOptimizationShadow({
  runId,
  jobs,
  vehicles,
  customRoutes,
  maxStops,
  maxDriveMinutes,
}: {
  runId?: string;
  jobs: RoutePoint[];
  vehicles: RouteOptimizationShadowVehicle[];
  customRoutes: RouteOptimizationShadowRoute[];
  maxStops: number;
  maxDriveMinutes: number;
}): Promise<RouteOptimizationShadowResult> {
  const parent = routeOptimizationParent();
  const accessToken = getRouteOptimizationAccessToken();
  if (!parent || !accessToken) {
    return {
      status: "disabled",
      runId,
      customDriveMinutes: customRoutes.reduce(
        (sum, route) => sum + Number(route.totalDriveMinutes || 0),
        0,
      ),
      routeCount: customRoutes.length,
      warnings: [
        "Route Optimization shadow mode skipped because GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID and GOOGLE_ROUTE_OPTIMIZATION_ACCESS_TOKEN are not both configured.",
      ],
    };
  }

  const validJobs = jobs.filter(isValidPoint);
  if (validJobs.length === 0 || vehicles.length === 0) {
    return {
      status: "disabled",
      runId,
      routeCount: customRoutes.length,
      warnings: ["Route Optimization shadow mode skipped because there are no routable jobs or vehicles."],
    };
  }

  try {
    const customDriveMinutes = customRoutes.reduce(
      (sum, route) => sum + Number(route.totalDriveMinutes || 0),
      0,
    );
    const response = await fetch(
      `https://routeoptimization.googleapis.com/v1/${parent}:optimizeTours`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          timeout: "8s",
          searchMode: "RETURN_FAST",
          considerRoadTraffic: true,
          populatePolylines: false,
          populateTransitionPolylines: false,
          label: runId || `routeiq-shadow-${Date.now()}`,
          model: {
            shipments: validJobs.map((job, index) => ({
              label: String(job.id || index),
              allowedVehicleIndices:
                job.allowedVehicleIndices && job.allowedVehicleIndices.length > 0
                  ? job.allowedVehicleIndices
                  : undefined,
              deliveries: [
                {
                  arrivalLocation: latLng(job),
                  duration: routeOptimizationDuration(Number(job.duration || 25)),
                },
              ],
            })),
            vehicles: vehicles.map((vehicle) => ({
              label: `${vehicle.techName || vehicle.techId}-${vehicle.date}`,
              loadLimits: {
                stops: {
                  maxLoad: String(vehicle.maxStops || maxStops),
                },
              },
              routeDurationLimit:
                maxDriveMinutes > 0
                  ? { maxDuration: routeOptimizationDuration(maxDriveMinutes) }
                  : undefined,
            })),
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      return {
        status: "failed",
        runId,
        customDriveMinutes,
        routeCount: customRoutes.length,
        rawStatus: `HTTP_${response.status}`,
        warnings: [warningFromGoogleError(`Route Optimization API HTTP ${response.status}`, payload)],
      };
    }

    const googleDriveMinutes = routeOptimizationDriveSeconds(payload) / 60;
    const score =
      customDriveMinutes > 0 && googleDriveMinutes > 0
        ? Math.round(((customDriveMinutes - googleDriveMinutes) / customDriveMinutes) * 1000) / 10
        : undefined;

    return {
      status: "ok",
      runId,
      score,
      googleDriveMinutes: googleDriveMinutes > 0 ? Math.round(googleDriveMinutes * 10) / 10 : undefined,
      customDriveMinutes: Math.round(customDriveMinutes * 10) / 10,
      routeCount: customRoutes.length,
      warnings: googleDriveMinutes > 0 ? [] : ["Route Optimization shadow response did not include travel duration metrics."],
    };
  } catch (error) {
    return {
      status: "failed",
      runId,
      routeCount: customRoutes.length,
      rawStatus: "REQUEST_FAILED",
      warnings: [`Route Optimization shadow mode failed. ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
