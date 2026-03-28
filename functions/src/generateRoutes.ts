import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import axios from "axios";

const db = admin.firestore();

interface Job {
  id: string;
  lat: number;
  lng: number;
  address: string;
  customerName: string;
  duration: number;
  serviceType: string;
  scheduledDate: string;
  assignedTechId?: string;
  status: string;
}

interface Technician {
  id: string;
  name: string;
  maxStopsPerDay: number;
  serviceArea?: {
    north: number; south: number; east: number; west: number;
  };
}

interface DriveTimes {
  [fromId: string]: { [toId: string]: number }; // minutes
}

async function getDriveTimes(locations: Array<{ id: string; lat: number; lng: number }>, apiKey: string): Promise<DriveTimes> {
  const times: DriveTimes = {};

  if (locations.length === 0) return times;

  // Build the body for Google Routes API
  const origins = locations.map(loc => ({
    waypoint: { location: { latLng: { latitude: loc.lat, longitude: loc.lng } } }
  }));
  const destinations = [...origins];

  try {
    const response = await axios.post(
      "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
      {
        origins,
        destinations,
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      },
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,status",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const elements = response.data;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        if (element.status?.code !== undefined && element.status.code !== 0) continue;
        const fromId = locations[element.originIndex]?.id;
        const toId = locations[element.destinationIndex]?.id;
        if (!fromId || !toId) continue;
        if (!times[fromId]) times[fromId] = {};
        const seconds = parseInt(element.duration || "0");
        times[fromId][toId] = Math.ceil(seconds / 60);
      }
    }
  } catch (error) {
    console.error("Routes API error:", error);
    // Fallback: estimate based on Haversine distance
    for (const from of locations) {
      times[from.id] = {};
      for (const to of locations) {
        if (from.id === to.id) {
          times[from.id][to.id] = 0;
        } else {
          const dist = haversineKm(from.lat, from.lng, to.lat, to.lng);
          times[from.id][to.id] = Math.ceil((dist / 40) * 60); // ~40 km/h avg
        }
      }
    }
  }

  return times;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nearest-neighbor heuristic VRP solver (JS approximation of OR-Tools)
function solveVRP(
  jobs: Job[],
  techs: Technician[],
  driveTimes: DriveTimes
): { [techId: string]: string[] } {
  const assignment: { [techId: string]: string[] } = {};
  const assignedJobs = new Set<string>();

  // Initialize empty routes
  for (const tech of techs) {
    assignment[tech.id] = [];
  }

  // First, handle pre-assigned jobs
  for (const job of jobs) {
    if (job.assignedTechId && assignment[job.assignedTechId] !== undefined) {
      assignment[job.assignedTechId].push(job.id);
      assignedJobs.add(job.id);
    }
  }

  // Get unassigned jobs
  const unassigned = jobs.filter(j => !assignedJobs.has(j.id));

  // Cluster unassigned jobs to techs using nearest-neighbor
  for (const tech of techs) {
    const maxStops = tech.maxStopsPerDay || 20;
    const currentRoute = assignment[tech.id];

    while (currentRoute.length < maxStops && unassigned.length > 0) {
      let bestIdx = -1;
      let bestTime = Infinity;

      const lastJobId = currentRoute[currentRoute.length - 1];

      for (let i = 0; i < unassigned.length; i++) {
        const candidate = unassigned[i];

        // Check if job is within service area
        if (tech.serviceArea && candidate.lat && candidate.lng) {
          const { north, south, east, west } = tech.serviceArea;
          if (candidate.lat > north || candidate.lat < south || candidate.lng > east || candidate.lng < west) {
            continue;
          }
        }

        let time: number;
        if (lastJobId && driveTimes[lastJobId] && driveTimes[lastJobId][candidate.id] !== undefined) {
          time = driveTimes[lastJobId][candidate.id];
        } else if (currentRoute.length === 0) {
          // Use first job as anchor — pick the geographically leftmost (west)
          time = candidate.lng ? -candidate.lng : 0;
        } else {
          time = 30; // default estimate
        }

        if (time < bestTime) {
          bestTime = time;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) break;

      const chosen = unassigned.splice(bestIdx, 1)[0];
      currentRoute.push(chosen.id);
    }
  }

  // Assign remaining unassigned jobs to the tech with most capacity
  for (const job of unassigned) {
    let bestTech = techs[0];
    let minLoad = Infinity;
    for (const tech of techs) {
      const load = assignment[tech.id].length;
      if (load < (tech.maxStopsPerDay || 20) && load < minLoad) {
        minLoad = load;
        bestTech = tech;
      }
    }
    if (bestTech && assignment[bestTech.id].length < (bestTech.maxStopsPerDay || 20)) {
      assignment[bestTech.id].push(job.id);
    }
  }

  // Optimize each route with 2-opt
  for (const techId of Object.keys(assignment)) {
    assignment[techId] = twoOpt(assignment[techId], driveTimes);
  }

  return assignment;
}

function twoOpt(route: string[], driveTimes: DriveTimes): string[] {
  if (route.length <= 3) return route;
  let improved = true;
  let best = [...route];

  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const a = best[i], b = best[i + 1], c = best[j], d = best[j + 1] ?? null;
        const currentCost = (driveTimes[a]?.[b] ?? 30) + (d ? (driveTimes[c]?.[d] ?? 30) : 0);
        const newCost = (driveTimes[a]?.[c] ?? 30) + (d ? (driveTimes[b]?.[d] ?? 30) : 0);
        if (newCost < currentCost) {
          best = [...best.slice(0, i + 1), ...best.slice(i + 1, j + 1).reverse(), ...best.slice(j + 1)];
          improved = true;
        }
      }
    }
  }
  return best;
}

function calcTotalDriveTime(route: string[], driveTimes: DriveTimes): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += driveTimes[route[i]]?.[route[i + 1]] ?? 30;
  }
  return total;
}

function calcConfidence(totalRoutesLearned: number, jobCount: number): number {
  // Confidence increases with more historical data
  if (totalRoutesLearned === 0) return 0.3;
  if (totalRoutesLearned < 10) return 0.5;
  if (totalRoutesLearned < 50) return 0.65;
  if (totalRoutesLearned < 100) return 0.75;
  if (totalRoutesLearned < 500) return 0.87;
  return 0.92;
}

export const generateRoutes = functions
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { companyId, date, techIds } = req.body;
    if (!companyId || !date) {
      res.status(400).json({ error: "companyId and date are required" });
      return;
    }

    try {
      const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || "";

      // Fetch jobs for the given date
      const jobsSnapshot = await db
        .collection(`companies/${companyId}/jobs`)
        .where("scheduledDate", "==", date)
        .where("status", "in", ["pending", "scheduled"])
        .get();

      const jobs: Job[] = jobsSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Job))
        .filter(j => j.lat && j.lng);

      if (jobs.length === 0) {
        res.json({ success: true, message: "No jobs found for this date", routes: [] });
        return;
      }

      // Fetch technicians
      const techQuery = db.collection(`companies/${companyId}/technicians`).where("active", "==", true);
      const techsSnapshot = await techQuery.get();
      let techs: Technician[] = techsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Technician));

      if (techIds && techIds.length > 0) {
        techs = techs.filter(t => techIds.includes(t.id));
      }

      if (techs.length === 0) {
        res.status(400).json({ error: "No active technicians found" });
        return;
      }

      // Get drive times from Google Routes API
      const locations = jobs.map(j => ({ id: j.id, lat: j.lat, lng: j.lng }));
      const driveTimes = await getDriveTimes(locations, googleMapsKey);

      // Get historical routes count for confidence
      const metricsDoc = await db.doc(`companies/${companyId}/modelMetrics/current`).get();
      const totalRoutesLearned = metricsDoc.exists ? (metricsDoc.data()?.totalRoutesLearned || 0) : 0;

      // Solve VRP
      const routeAssignments = solveVRP(jobs, techs, driveTimes);

      // Save routes to Firestore
      const savedRoutes: Array<{ routeId: string; techId: string; stops: number }> = [];
      const batch = db.batch();

      for (const [techId, stopSequence] of Object.entries(routeAssignments)) {
        if (stopSequence.length === 0) continue;

        const totalDriveTimeMinutes = calcTotalDriveTime(stopSequence, driveTimes);
        const confidence = calcConfidence(totalRoutesLearned, stopSequence.length);
        const routeId = `${date}_${techId}_${Date.now()}`;

        const routeData = {
          date,
          techId,
          stopSequence,
          totalDriveTimeMinutes,
          totalStops: stopSequence.length,
          generatedBy: "ai",
          confidence,
          approved: confidence >= 0.85,
          companyId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const routeRef = db.doc(`companies/${companyId}/routes/${routeId}`);
        batch.set(routeRef, routeData);
        savedRoutes.push({ routeId, techId, stops: stopSequence.length });
      }

      await batch.commit();

      res.json({
        success: true,
        date,
        routesGenerated: savedRoutes.length,
        routes: savedRoutes,
        totalJobs: jobs.length,
      });
    } catch (error) {
      console.error("Route generation error:", error);
      res.status(500).json({ error: "Route generation failed", details: String(error) });
    }
  });
