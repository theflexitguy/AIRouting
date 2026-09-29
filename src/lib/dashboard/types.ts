// Extracted VERBATIM from src/app/(dashboard)/dashboard/page.tsx so the dashboard and the
// MCP server compute every number with the same code. Do not fork the logic — change it here.

import type { RouteLike, JobLike, LineTarget, MonthlyPace } from "@/lib/metrics/operational";

export interface WeekKpis {
  stopsPerRoute: number | null;
  stopsPerHour: number | null;
  avgDriveTime: number | null;
  routeCount: number;
}

export interface TrendRow {
  label: string; // week start, e.g. "Jun 1"
  routeCount: number;
  stopsPerRoute: number | null;
  avgDriveTime: number | null;
  stopsPerHour: number | null;
}

export interface DashboardStats {
  todayRoutes: number;
  totalStops: number;
  completedToday: number;
  completedInScope: number;
  stopsLeftToday: number;
  estimatedDriveTime: number;
  totalRouteValue: number;
  avgRouteValue: number;
  todayStopsPerHour: number | null;
  overdueStops: number;
  weekKpis: WeekKpis;
  weekStopsBooked: number;
  stopsLeftWeek: number;
  lineTargets: LineTarget[];
  monthScheduledByLine: Record<string, number>;
  monthScheduledTotal: number;
  weekScheduled: number;
  todayScheduled: number;
  monthlyTarget: number;
  weeklyTarget: number;
  dailyTarget: number;
  // Per-service-line week/day segmentation: target (monthly ÷ 4 / ÷ working
  // days), done (completed in the window), booked (appointments on the books).
  lineWeekDay: Record<string, {
    weekTarget: number; weekDone: number; weekBooked: number;
    dayTarget: number; todayDone: number; todayBooked: number;
  }>;
  pace: MonthlyPace;
  weekPace: MonthlyPace;
  trend: TrendRow[];
  jobsDueThisWeek: Array<{ date: string; count: number }>;
}

// Raw doc shapes the dashboard fetches once, then filters/derives client-side.
export interface RouteStopDetail {
  id: string;
  customerName?: string;
  value?: number;
  completed?: boolean; // stamped by the historical reconcile (appointment status 1)
  // What the stop IS, as opposed to which subscription it hangs off: a General
  // Pest regular service, a General Pest initial and a General Pest reservice
  // all share one subscription type, so only the appointment separates them.
  kind?: string; // "regular" | "initial" | "reservice"
  serviceType?: string;
}
export interface RouteRec extends RouteLike {
  date: string;
  techId?: string;
  techName?: string;
  routeGroupTitle?: string;
  routeTemplateTitle?: string; // FieldRoutes route template ("Regular", "Rain Day", …)
  routeValue?: number;
  completedStops?: number; // stamped by the historical reconcile (appointment status 1)
  stopSequence?: string[];
  stops?: RouteStopDetail[]; // light per-stop detail persisted by the sync/reconcile
  driveTimeSource?: string; // "routes_api_matrix" = real Google drive time, else straight-line estimate
}
/** One past-due subscription in the Overdue Stops audit view. */
export interface OverdueRow {
  docId: string;
  customerId: string;
  customerName: string;
  address: string;
  balance: number;
  serviceType: string;
  frequencyLabel: string;
  serviceLine: string;
  dueDate: string;
  daysOverdue: number;
  graceDays: number; // the frequency-scaled window this sub had to be serviced in
  lastCompleted: string;
  reasons: string[]; // empty when counted; why it did NOT count otherwise
}

export interface JobRec extends JobLike {
  docId?: string; // Firestore doc id (sub_<subscriptionId>), stamped at load
  status?: string;
  overdueActionable?: boolean;
  // Audit fields behind the Overdue Stops drill-down. All already stored on the
  // job docs by the sync; declared here so the drill can read them typed.
  subscriptionBalance?: string; // stored as a string
  schedulingRequest?: string; // special-scheduling note; any text blocks routing
  potentialCustomer?: boolean;
  serviceType?: string;
  fieldRoutesStopKind?: string; // "regular" | "initial" | "reservice" on the booked appointment
  fieldRoutesRouteGroup?: string;
  fieldRoutesRouteTemplate?: string;
  scheduledTech?: string; // FieldRoutes tech name on the booked appointment
  customerName?: string;
  address?: string;
  duration?: number; // service minutes for the stop
  // Billing fields feeding calculateStopProductionValue (per-stop route value
  // fallback when a route doc's stops detail predates the value field).
  recurringPrice?: string;
  billingPrice?: string;
  billingFrequency?: string;
  revenue?: number | string;
  productionValue?: number | string;
}
export interface TechOption {
  id: string;
  name: string;
  employeeId?: string;
  fieldRoutesEmployeeId?: string;
  fieldRoutesTechId?: string;
}

/** Cached per-period sums of monthlyDone documents (the History selector's data). */
export interface RangeDone {
  byLine: Record<string, number>;
  initials: number;
  initialsByLine: Record<string, number>;
  reservices: number;
  followups: number;
  specialty: number;
  wildlife: number;
  newCustomers: number;
  newSubscriptions: number;
  completedAppointments: number;
  monthsAvailable: number;
  monthsTotal: number;
}

/** Calendar boundaries (compared as YYYY-MM-DD strings). */
export interface DashboardBounds {
  weekStart: string;
  weekEnd: string;
  monthStart: string;
  monthEnd: string;
  monthIndex: number;
  trendStart: string;
}
