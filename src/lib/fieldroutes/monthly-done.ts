// Monthly "completed this month" aggregate, built from FieldRoutes appointments.
//
// The recurring job docs can't answer "how many did we DO this month" for
// one-time / specialty work or for new-signup Initials — those roll off the
// subscription book once completed. The throughput truth lives on COMPLETED
// APPOINTMENTS, so this pulls the month's completed appointments, classifies each
// by its own service type, and aggregates:
//   - recurringDoneByLine: General Pest / Mosquito / Lawn / Termite / Commercial
//   - initialsByLine:      new-signup Initials per line
//   - reserviceDone:       reservices / retreats / callbacks (GPC workload)
//   - followupDone:        follow-ups (own bucket; also GPC workload)
//   - specialtyDone:       German Roach + one-time / flea / bed bug / etc.
//   - wildlifeDone:        wildlife exclusion work
//   - newCustomers / newSubscriptions: records created this month (drive the
//     forecast growth rate via year-over-year trend)
// Result is cached in companies/{id}/fieldRoutesState/monthlyDone for the dashboard.

import { FieldRoutesClient } from "./client";
import { centralTodayISO, toDateOnly, num } from "./scope";
import { deriveServiceLine, ServiceLine } from "@/lib/routing/service-line";

const str = (v: unknown): string => String(v ?? "").trim();
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

const isInitialLabel = (s: string) => /initial/i.test(s);

// Non-recurring / oddment work that belongs in the Specialty tracker (alongside
// German Roach). Matched on the normalized service-type description.
const SPECIALTY_KEYWORDS = [
  "onetime", "flea", "bedbug", "mole", "rodent", "inspection", "bird",
  "habitat", "baitbox", "baitstation", "custom", "paymentplan",
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Reservice / callback work: unscheduled returns between regular services.
// Follow-ups are tracked as their OWN bucket (the owner treats them separately),
// though both feed the Technicians Needed forecast as GPC workload. Neither is
// counted in the recurring done totals. "retreat" must not catch "Pre-Treatment"
// — new-construction termite work normalizes to "pretreatment", which contains
// the substring "retreat".
const isFollowupLabel = (n: string): boolean => n.includes("followup");
const isReserviceLabel = (n: string): boolean =>
  n.includes("reservice") ||
  (n.includes("retreat") && !n.includes("pretreat")) ||
  n.includes("callback");

export interface TrackingClass {
  line: ServiceLine;
  isInitial: boolean;
  isFollowup: boolean;
  isReservice: boolean;
  isWildlife: boolean;
  isSpecialty: boolean;
}

/** Classify a service-type description for the dashboard trackers. */
export function classifyServiceForTracking(description: string): TrackingClass {
  const line = deriveServiceLine(description);
  const n = normalize(description);
  const isInitial = isInitialLabel(description);
  const isFollowup = !isInitial && isFollowupLabel(n);
  const isReservice = !isInitial && !isFollowup && isReserviceLabel(n);
  const isWildlife = line === "wildlife";
  const isSpecialty =
    !isWildlife && !isFollowup && !isReservice && (line === "gr" || SPECIALTY_KEYWORDS.some((k) => n.includes(k)));
  return { line, isInitial, isFollowup, isReservice, isWildlife, isSpecialty };
}

export interface MonthlyDone {
  month: string; // YYYY-MM
  monthStart: string;
  monthEnd: string; // last day of the month (or today, for the current month)
  today: string;
  computedAt: string;
  completedAppointments: number;
  recurringDoneByLine: Record<string, number>; // general/mosquito/lawn/termite/commercial
  recurringDoneTotal: number;
  initialsByLine: Record<string, number>;
  initialsTotal: number;
  reserviceDone: number; // reservices / retreats / callbacks — kept OUT of the
  // recurring done counts; feeds the tech forecast as GPC workload
  followupDone: number; // follow-ups — own bucket (owner tracks separately); also GPC
  specialtyDone: number;
  grDone: number; // GR completions (also counted inside specialtyDone) — split out
  // so the tech forecast can use GR's recurring TARGET without double-counting
  // GR actuals in the one-time run rate.
  wildlifeDone: number;
  // New-business counts, from customer/subscription records created in the month
  // (not appointment-derived). Drive the forecast's growth rate via YoY trend.
  newCustomers: number;
  newSubscriptions: number;
  unclassified: number;
}

const RECURRING_LINES: ServiceLine[] = ["general", "mosquito", "lawn", "termite", "commercial"];

/** Last calendar day of a YYYY-MM month, as YYYY-MM-DD. */
function lastDayOfMonth(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return `${monthKey}-28`;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

/**
 * Pull a month's completed appointments and aggregate the done-counts. Defaults
 * to the current month; pass monthKey ("YYYY-MM") for any historical month (the
 * window is bounded to that month, and to `today` for the current month so we
 * never count the future). Returns the aggregate plus a small raw sample for
 * verification. Metered: ~1 serviceType catalog read + 1 appointment search + a
 * couple of get chunks.
 */
export async function computeMonthlyDone(
  client: FieldRoutesClient,
  today: string = centralTodayISO(),
  monthKey?: string,
): Promise<{ done: MonthlyDone; sample: { keys: string[]; rows: Record<string, unknown>[]; serviceTypeFieldUsed: string } }> {
  const month = monthKey && /^\d{4}-\d{2}$/.test(monthKey) ? monthKey : today.slice(0, 7);
  const monthStart = `${month}-01`;
  const isCurrentMonth = month === today.slice(0, 7);
  // For a past month, count the whole month; for the current month, stop at today.
  const monthEnd = isCurrentMonth ? today : lastDayOfMonth(month);

  // 1) serviceType catalog: typeID -> description.
  const catalog = new Map<string, string>();
  try {
    const serviceTypes = await client.searchWithData("serviceType");
    for (const s of serviceTypes) {
      const id = str(rec(s).typeID);
      const desc = str(rec(s).description);
      if (id) catalog.set(id, desc);
    }
  } catch {
    // Catalog optional; we fall back to any description on the appointment itself.
  }

  // 2) Completed appointments in [monthStart, monthEnd] (status 1 = Completed).
  const apptIds = await client.searchIds("appointment", {
    status: 1,
    date: { operator: "BETWEEN", value: [monthStart, monthEnd] },
  });
  const appts = apptIds.length ? await client.getEntities("appointment", apptIds) : [];

  // Resolve a service-type description for an appointment: prefer the catalog via
  // the appointment's type/serviceID, else any description field on the appt.
  let serviceTypeFieldUsed = "";
  const describe = (ar: Record<string, unknown>): string => {
    for (const f of ["type", "serviceID", "serviceTypeID", "subscriptionServiceID"]) {
      const id = str(ar[f]);
      if (id && catalog.has(id)) {
        if (!serviceTypeFieldUsed) serviceTypeFieldUsed = `${f}->catalog`;
        return catalog.get(id) || "";
      }
    }
    for (const f of ["serviceType", "description", "type"]) {
      const v = str(ar[f]);
      if (v && !/^\d+$/.test(v)) {
        if (!serviceTypeFieldUsed) serviceTypeFieldUsed = f;
        return v;
      }
    }
    return "";
  };

  const recurringDoneByLine: Record<string, number> = {};
  const initialsByLine: Record<string, number> = {};
  for (const l of RECURRING_LINES) {
    recurringDoneByLine[l] = 0;
    initialsByLine[l] = 0;
  }
  let reserviceDone = 0;
  let followupDone = 0;
  let specialtyDone = 0;
  let grDone = 0;
  let wildlifeDone = 0;
  let unclassified = 0;
  let completed = 0;

  for (const a of appts) {
    const ar = rec(a);
    if (num(ar.status) !== 1) continue; // defensive: completed only
    const date = toDateOnly(ar.date);
    if (!date || date < monthStart || date > monthEnd) continue;
    completed++;

    const desc = describe(ar);
    if (!desc) {
      unclassified++;
      continue;
    }
    const c = classifyServiceForTracking(desc);
    if (c.isInitial) {
      const base = c.line === "wildlife" ? "wildlife" : c.line;
      if (base in initialsByLine) initialsByLine[base]++;
      else initialsByLine[base] = (initialsByLine[base] || 0) + 1;
      continue;
    }
    if (c.isFollowup) {
      followupDone++;
      continue;
    }
    if (c.isReservice) {
      reserviceDone++;
      continue;
    }
    if (c.isWildlife) {
      wildlifeDone++;
      continue;
    }
    if (c.isSpecialty) {
      specialtyDone++;
      if (c.line === "gr") grDone++;
      continue;
    }
    if (c.line in recurringDoneByLine) recurringDoneByLine[c.line]++;
    else unclassified++;
  }

  const recurringDoneTotal = RECURRING_LINES.reduce((s, l) => s + recurringDoneByLine[l], 0);
  const initialsTotal = Object.values(initialsByLine).reduce((s, v) => s + v, 0);

  // 3) New-business counts: customer / subscription records CREATED this month
  // (dateAdded within the window). These aren't appointment-derived; they drive
  // the tech forecast's growth rate via its year-over-year trend. Each search is
  // isolated so a dropped filter (client throws on ignoredParams) or an API-cap
  // stop leaves the count at 0 rather than failing the whole aggregate.
  const countCreated = async (module: string): Promise<number> => {
    try {
      const ids = await client.searchIds(module, {
        dateAdded: { operator: "BETWEEN", value: [`${monthStart} 00:00:00`, `${monthEnd} 23:59:59`] },
      });
      return ids.length;
    } catch (err) {
      console.warn(`[monthly-done] ${module} new-business count failed for ${month}:`, String(err));
      return 0;
    }
  };
  const newCustomers = await countCreated("customer");
  const newSubscriptions = await countCreated("subscription");

  const done: MonthlyDone = {
    month,
    monthStart,
    monthEnd,
    today,
    computedAt: new Date().toISOString(),
    completedAppointments: completed,
    recurringDoneByLine,
    recurringDoneTotal,
    initialsByLine,
    initialsTotal,
    reserviceDone,
    followupDone,
    specialtyDone,
    grDone,
    wildlifeDone,
    newCustomers,
    newSubscriptions,
    unclassified,
  };

  const sample = {
    keys: appts.length ? Object.keys(rec(appts[0])).sort() : [],
    rows: appts.slice(0, 3).map((a) => {
      const ar = rec(a);
      return {
        appointmentID: str(ar.appointmentID),
        status: str(ar.status),
        date: str(ar.date),
        type: str(ar.type),
        serviceID: str(ar.serviceID),
        resolvedDescription: describe(ar),
      };
    }),
    serviceTypeFieldUsed: serviceTypeFieldUsed || "(none resolved)",
  };

  return { done, sample };
}
