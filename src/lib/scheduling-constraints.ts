/**
 * Scheduling Constraints Parser (TypeScript port)
 * Ported from backend/scheduling_constraints.py
 *
 * Parses free-text scheduling requests from FieldRoutes
 * into structured constraint classifications.
 */

const WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

const WEEKDAY_INDEX_BY_TOKEN: Record<string, number> = {
  mon: 0, monday: 0, mondays: 0,
  tue: 1, tues: 1, tuesday: 1, tuesdays: 1,
  wed: 2, weds: 2, wednesday: 2, wednesdays: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3, thursdays: 3,
  fri: 4, friday: 4, fridays: 4,
  sat: 5, saturday: 5, saturdays: 5,
  sun: 6, sunday: 6, sundays: 6,
};

const PHONE_CONFIRM = /\b(call|contact|phone|text|speak|confirm|week\s*notice|week'?s?\s+notice)\b/i;
const DO_NOT_SCHEDULE = /\b(do\s*not\s*schedule|don't\s*schedule|dont\s*schedule|do\s*not\s*scheduel|do\s*not\s*book)\b/i;
const PAYMENT_HOLD = /\b(payment|past\s*due|collections?|account\s*hold|hold\s*account|declined|nsf)\b/i;
const MOVE_ADDRESS_HOLD = /\b(moved?|move[d]?\s*out|wrong\s*address|invalid\s*address|vacant|foreclosure|out\s*of\s*state)\b/i;
const TIME_WINDOW = /\b(before|after|morning|afternoon|evening|am|pm|time\s*window|between)\b/i;
const ONLY_WEEKDAY = /\b(?:only|must|strictly|schedule\s+only|only\s+schedule\s+on|only\s+on)\b/i;
const BLOCKED_WEEKDAY = /\b(no|not\s+on|except)\s+([a-z,\s/&-]+)/gi;

export type SchedulingClass =
  | "DO_NOT_SCHEDULE"
  | "PAYMENT_OR_ACCOUNT_HOLD"
  | "MOVE_OR_ADDRESS_HOLD"
  | "HARD_WEEKDAY_ONLY"
  | "HARD_WEEKDAY_EXCLUDE"
  | "CALL_REQUIRED"
  | "SOFT_WEEKDAY_PREFERENCE"
  | "TIME_WINDOW_REQUEST"
  | "FREE_TEXT"
  | "";

export const CRITICAL_CLASSES = new Set<SchedulingClass>([
  "DO_NOT_SCHEDULE",
  "PAYMENT_OR_ACCOUNT_HOLD",
  "MOVE_OR_ADDRESS_HOLD",
]);

export interface SchedulingConstraint {
  schedulingRequestRaw: string;
  schedulingRequestClass: SchedulingClass;
  schedulingAllowedWeekdays: string;
  schedulingBlockedWeekdays: string;
  schedulingRequiresPhoneConfirm: boolean;
  schedulingCritical: boolean;
  schedulingConstraintNote: string;
}

function extractWeekdayIndices(text: string): Set<number> {
  const out = new Set<number>();
  const matches = text.toLowerCase().match(/\b[a-z]{3,10}\b/g) || [];
  for (const token of matches) {
    const idx = WEEKDAY_INDEX_BY_TOKEN[token];
    if (idx !== undefined) out.add(idx);
  }
  return out;
}

function serializeWeekdays(values: Set<number>): string {
  return [...values]
    .filter(v => v >= 0 && v <= 6)
    .sort((a, b) => a - b)
    .map(v => WEEKDAY_LABELS[v])
    .join(",");
}

export function parseSchedulingRequest(value: string | undefined | null): SchedulingConstraint {
  const raw = (value ?? "").trim();
  const empty: SchedulingConstraint = {
    schedulingRequestRaw: raw,
    schedulingRequestClass: "",
    schedulingAllowedWeekdays: "",
    schedulingBlockedWeekdays: "",
    schedulingRequiresPhoneConfirm: false,
    schedulingCritical: false,
    schedulingConstraintNote: "",
  };

  if (!raw || raw.toLowerCase() === "nan" || raw.toLowerCase() === "null" || raw.toLowerCase() === "none") {
    return empty;
  }

  const lowered = raw.toLowerCase();
  const allWeekdays = extractWeekdayIndices(lowered);
  const blocked = new Set<number>();
  const allowed = new Set<number>();

  // Extract blocked weekdays
  BLOCKED_WEEKDAY.lastIndex = 0;
  let match;
  while ((match = BLOCKED_WEEKDAY.exec(lowered)) !== null) {
    for (const idx of extractWeekdayIndices(match[2])) {
      blocked.add(idx);
    }
  }

  // Extract allowed weekdays
  if (ONLY_WEEKDAY.test(lowered) && allWeekdays.size > 0) {
    for (const idx of allWeekdays) allowed.add(idx);
  }
  if (lowered.includes("only") && allWeekdays.size > 0 && allowed.size === 0) {
    for (const idx of allWeekdays) allowed.add(idx);
  }

  const requiresPhone = PHONE_CONFIRM.test(raw);
  const doNotSchedule = DO_NOT_SCHEDULE.test(raw);
  const paymentHold = PAYMENT_HOLD.test(raw);
  const moveHold = MOVE_ADDRESS_HOLD.test(raw);
  const timeWindow = TIME_WINDOW.test(raw);
  const critical = doNotSchedule || paymentHold || moveHold;

  let className: SchedulingClass = "FREE_TEXT";
  if (doNotSchedule) className = "DO_NOT_SCHEDULE";
  else if (paymentHold) className = "PAYMENT_OR_ACCOUNT_HOLD";
  else if (moveHold) className = "MOVE_OR_ADDRESS_HOLD";
  else if (allowed.size > 0) className = "HARD_WEEKDAY_ONLY";
  else if (blocked.size > 0) className = "HARD_WEEKDAY_EXCLUDE";
  else if (requiresPhone) className = "CALL_REQUIRED";
  else if (allWeekdays.size > 0) className = "SOFT_WEEKDAY_PREFERENCE";
  else if (timeWindow) className = "TIME_WINDOW_REQUEST";

  const noteParts: string[] = [];
  if (allowed.size > 0) noteParts.push(`only ${serializeWeekdays(allowed)}`);
  if (blocked.size > 0) noteParts.push(`avoid ${serializeWeekdays(blocked)}`);
  if (requiresPhone) noteParts.push("phone confirm");
  if (critical) noteParts.push("critical hold");

  return {
    schedulingRequestRaw: raw,
    schedulingRequestClass: className,
    schedulingAllowedWeekdays: serializeWeekdays(allowed),
    schedulingBlockedWeekdays: serializeWeekdays(blocked),
    schedulingRequiresPhoneConfirm: requiresPhone,
    schedulingCritical: critical,
    schedulingConstraintNote: noteParts.join("; "),
  };
}
