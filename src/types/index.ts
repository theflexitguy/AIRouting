export interface Company {
  id: string;
  name: string;
  plan: 'starter' | 'pro' | 'enterprise';
  fieldRoutesApiKey?: string;
  fieldRoutesApiSecret?: string;
  fieldRoutesGpcRouteGroupTitle?: string;
  fieldRoutesGpcRouteGroupId?: string;
  fieldRoutesGpcRouteTemplateId?: string;
  fieldRoutesGeneralPestServiceId?: string;
  fieldRoutesMosquitoServiceId?: string;
  fieldRoutesOutdoorPackageServiceId?: string;
  fieldRoutesDefaultServiceId?: string;
  fieldRoutesServiceIdMap?: Record<string, number>;
  fieldRoutesRouteGroups?: string[]; // route-group titles used as dashboard filters
  allowCrossTechRouteEdits?: boolean;
  routingBalanceGate?: number; // customer balance ($) at/above which a stop is not scheduled (default 420)
  routingBalanceAgeDays?: number; // max balance age (days) allowed before blocking; 0 = unenforced
  createdAt: string;
  active: boolean;
}

export interface Technician {
  id: string;
  companyId: string;
  name: string;
  employeeId: string;
  active: boolean;
  maxStopsPerDay: number;
  workDays?: string[]; // e.g. ["Mon","Tue","Wed","Thu","Fri"]
  serviceArea?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
}

export interface Job {
  id: string;
  companyId: string;
  customerId: string;
  customerName: string;
  address: string;
  lat?: number;
  lng?: number;
  scheduledDate: string;
  serviceType: string;
  duration: number; // minutes
  assignedTechId?: string;
  status: 'pending' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  completedAt?: string;
  notes?: string;
  subscriptionId?: string;
  schedulingRequest?: string;
  billingFrequency?: string;
  billingPrice?: string;
  recurringFrequency?: string;
  recurringPrice?: string;
  subscriptionStatus?: string;
  subscriptionBalance?: string;
  subscriptionOnHold?: string;
  initialServiceDate?: string;
  subscriptionLastServiced?: string;
  subscriptionLastCompletedDate?: string;
  serviceDueAlreadyCompleted?: boolean;
  seasonalStartMonth?: number | null; // 1–12, null when not seasonal
  seasonalEndMonth?: number | null;
  isSeasonal?: boolean;
  // Service-line segregation + interval-deadline model (Sensei v2 Router rules).
  serviceLine?: string; // general | gr | termite | lawn | mosquito | commercial | wildlife
  serviceIntervalDays?: number; // effective service interval in days
  serviceDeadline?: string; // YYYY-MM-DD hard deadline (last completed + interval)
  daysUntilDeadline?: number | null; // deadline − today (negative = past)
  pastDeadline?: boolean; // today is past the service deadline
  deadlineFlagZone?: boolean; // within the line's flag-lead window of the deadline
  grEscalation?: boolean; // German Roach past its 14-day deadline (always urgent)
  serviceDueCompletionCheck?: string;
  pendingCancel?: boolean;
  potentialCustomer?: boolean;
  fieldRoutesScheduled?: boolean;
  fieldRoutesScheduledDate?: string;
  fieldRoutesServicedBy?: string;
  fieldRoutesServicedById?: string;
  fieldRoutesRouteId?: string;
  fieldRoutesRouteGroup?: string; // route.groupTitle for the scheduled route
  revenue?: string;
  productionValue?: string;
  subscriptionCategory?: string;
  csvColumns?: string[];
  csvFields?: Array<{ name: string; value: string }>;
  rawCsv?: Record<string, string>;
  source?: 'csv_upload' | 'api' | 'manual';
  createdAt: string;
  updatedAt: string;
}

export interface Route {
  id: string;
  companyId: string;
  date: string;
  techId: string;
  stopSequence: string[]; // array of jobIds in order
  totalDriveTimeMinutes: number;
  totalWorkMinutes?: number;
  totalServiceMinutes?: number;
  totalStops: number;
  routeGroupTitle?: string; // FieldRoutes route.groupTitle (dashboard filter)
  routeValue?: number; // sum of stop production values on the route
  driveTimeSource?: string;
  polylineSource?: string;
  encodedPolyline?: string;
  routePolyline?: Array<{ lat: number; lng: number }>;
  polylineStatus?: string;
  failedRouteSegments?: number;
  googleRouteOptimizationShadowScore?: number;
  googleRouteOptimizationRunId?: string;
  googleRouteOptimizationSummary?: Record<string, unknown>;
  maxStopsParam?: number;
  targetStopsParam?: number;
  baseMaxStopsParam?: number;
  tuesdayStopReduction?: number;
  generatedBy: 'human' | 'ai';
  confidence: number; // 0-1
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
  fieldRoutesSync?: {
    uploadedAt?: string;
    routeId?: string;
    updated?: number;
    created?: number;
    unchanged?: number;
    total?: number;
    assignedTech?: string;
    routeStatus?: string;
    routeDate?: string;
    routeTime?: string;
    routeFoundAt?: string;
    verifiedAt?: string;
    dateInputUsed?: string;
    routeGroupTitle?: string;
    routeGroupId?: string;
    appointmentIds?: string[];
    uploadedAppointments?: Array<{
      appointmentId: string;
      jobId: string;
      customerName?: string;
      sequence?: number;
      action?: string;
      before?: {
        routeId?: string;
        assignedTech?: string;
        date?: string;
        sequence?: number | null;
        status?: string;
      };
      after?: {
        routeId?: string;
        assignedTech?: string;
        date?: string;
        sequence?: number | null;
        status?: string;
      };
    }>;
    bundledSameAddressStops?: number;
  };
  createdAt: string;
  updatedAt?: string;
}

export interface RouteHistory {
  id: string;
  companyId: string;
  originalRoute: Route;
  modifiedRoute: Route;
  modifiedBy: string;
  modifiedAt: string;
  deltaStops: {
    moved: Array<{ jobId: string; fromIndex: number; toIndex: number }>;
    added: string[];
    removed: string[];
  };
  feedbackProcessed: boolean;
}

export interface ModelMetrics {
  lastTrainedAt: string;
  accuracy: number;
  totalRoutesLearned: number;
  avgConfidence: number;
  accuracyHistory: Array<{ date: string; accuracy: number }>;
}

export interface User {
  uid: string;
  email: string;
  displayName?: string;
  companyId: string;
  role: 'admin' | 'dispatcher' | 'viewer';
}
