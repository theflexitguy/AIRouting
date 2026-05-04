export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { CRITICAL_CLASSES, parseSchedulingRequest } from "@/lib/scheduling-constraints";
import { routeAddressKey, serviceDueAlreadyCompleted } from "@/lib/route-bundles";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const APPOINTMENT_ID_FIELDS = ["appointmentID", "appointmentId", "appointment_id", "id"];
const ROUTE_ID_FIELDS = ["routeID", "routeId", "route_id", "id"];
const GROUP_ID_FIELDS = ["groupID", "groupId", "routeGroupID", "routeGroupId"];
const ASSIGNED_TECH_FIELDS = ["assignedTech", "assignedTechID", "assignedTechId"];
const CUSTOMER_FIELDS = ["customerID", "customerId", "customer_id", "customer", "accountID", "accountId"];
const SUBSCRIPTION_FIELDS = ["subscriptionID", "subscriptionId", "subscription_id", "subscription", "subscriptionIDFk"];
const APPOINTMENT_DATE_FIELDS = ["date", "dateStart", "serviceDate", "scheduledDate", "appointmentDate"];
const SEQUENCE_FIELDS = ["sequence", "sortOrder", "order"];
const SERVICE_TYPE_FIELDS = ["serviceID", "serviceId", "serviceTypeID", "serviceTypeId", "type"];
const GPC_GROUP_TITLE = "GPC";
const WEEKDAY_LABEL_BY_JS_DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const GPC_SERVICE_CONFIG = [
  {
    key: "general_pest",
    envKeys: ["FIELDROUTES_GENERAL_PEST_SERVICE_ID", "FIELDROUTES_GPC_GENERAL_PEST_SERVICE_ID"],
    companyFields: ["fieldRoutesGeneralPestServiceId", "fieldRoutesGpcGeneralPestServiceId"],
    patterns: [/general\s+pest/i, /\bgpc\b/i],
  },
  {
    key: "mosquito",
    envKeys: ["FIELDROUTES_MOSQUITO_SERVICE_ID", "FIELDROUTES_GPC_MOSQUITO_SERVICE_ID"],
    companyFields: ["fieldRoutesMosquitoServiceId", "fieldRoutesGpcMosquitoServiceId"],
    patterns: [/mosquito/i],
  },
  {
    key: "outdoor_package",
    envKeys: ["FIELDROUTES_OUTDOOR_PACKAGE_SERVICE_ID", "FIELDROUTES_GPC_OUTDOOR_PACKAGE_SERVICE_ID"],
    companyFields: ["fieldRoutesOutdoorPackageServiceId", "fieldRoutesGpcOutdoorPackageServiceId"],
    patterns: [/outdoor\s+package/i],
  },
] as const;

type FieldRoutesPayload = Record<string, string | number | boolean | null | undefined>;
type FieldRoutesRecord = Record<string, unknown>;
type JobRecord = { id: string; data: FirebaseFirestore.DocumentData };

class ApproveRouteError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class FieldRoutesClient {
  private baseUrl: string;
  private authKey: string;
  private authToken: string;

  constructor({ baseUrl, authKey, authToken }: { baseUrl: string; authKey: string; authToken: string }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authKey = authKey;
    this.authToken = authToken;
  }

  async request(endpoint: string, payload: FieldRoutesPayload, write = false) {
    const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const form = new URLSearchParams();
    form.set("authenticationKey", this.authKey);
    form.set("authenticationToken", this.authToken);
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        form.set(key, String(value));
      }
    });

    let lastError = "";
    const maxAttempts = write ? 4 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${ep}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          signal: AbortSignal.timeout(30000),
        });
        const text = await response.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { raw: text };
        }

        const apiError = extractApiError(body);
        if (response.ok && !apiError) return body;

        lastError = apiError || `HTTP ${response.status}`;
        if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < maxAttempts) {
          await sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        throw new ApproveRouteError(`FieldRoutes ${ep} failed: ${lastError}`, 502, {
          endpoint: ep,
          status: response.status,
          response: body,
        });
      } catch (error) {
        if (error instanceof ApproveRouteError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt + 1 < maxAttempts) {
          await sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
      }
    }

    throw new ApproveRouteError(`FieldRoutes ${ep} failed: ${lastError || "request failed"}`, 502);
  }

  employeeSearch() {
    return this.request("/employee/search", { includeData: 1, active: 1 });
  }

  routeSearch({
    assignedTech,
    date,
    dateStart,
    dateEnd,
    groupTitle,
  }: {
    assignedTech?: string;
    date?: string;
    dateStart?: string;
    dateEnd?: string;
    groupTitle?: string;
  }) {
    return this.request("/route/search", {
      includeData: 1,
      ...(assignedTech ? { assignedTech } : {}),
      ...(date ? { date } : {}),
      ...(dateStart ? { dateStart } : {}),
      ...(dateEnd ? { dateEnd } : {}),
      ...(groupTitle ? { groupTitle } : {}),
    });
  }

  routeCreate({
    assignedTech,
    date,
    templateId,
    groupId,
  }: {
    assignedTech: string;
    date: string;
    templateId?: number;
    groupId?: string;
  }) {
    return this.request(
      "/route/create",
      {
        assignedTech,
        date,
        autoCreateGroup: 1,
        ...(templateId ? { templateID: templateId } : {}),
        ...(groupId ? { groupID: groupId } : {}),
      },
      true,
    );
  }

  appointmentSearch(dateStart: string, dateEnd: string, status: number | undefined, page: number) {
    return this.request("/appointment/search", {
      dateStart,
      dateEnd,
      includeData: 1,
      page,
      ...(status !== undefined ? { status } : {}),
    });
  }

  appointmentGet(appointmentIds: string[]) {
    return this.request("/appointment/get", {
      appointmentID: appointmentIds.join(","),
      includeData: 1,
    });
  }

  appointmentUpdate({
    appointmentId,
    routeId,
    assignedTech,
    sequence,
    duration,
  }: {
    appointmentId: string;
    routeId: string;
    assignedTech: string;
    sequence: number;
    duration?: number;
  }) {
    return this.request(
      "/appointment/update",
      {
        appointmentID: appointmentId,
        routeID: routeId,
        assignedTech,
        sequence,
        ...(duration ? { duration } : {}),
      },
      true,
    );
  }

  appointmentCreate({
    customerId,
    serviceType,
    routeId,
    assignedTech,
    subscriptionId,
    sequence,
    duration,
  }: {
    customerId: string;
    serviceType: number;
    routeId: string;
    assignedTech: string;
    subscriptionId?: string;
    sequence: number;
    duration?: number;
  }) {
    return this.request(
      "/appointment/create",
      {
        customerID: customerId,
        type: serviceType,
        employeeID: assignedTech,
        routeID: routeId,
        assignedTech,
        ...(subscriptionId ? { subscriptionID: subscriptionId } : {}),
        sequence,
        ...(duration ? { duration } : {}),
      },
      true,
    );
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeFieldName(value: unknown) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function csvFieldValue(record: FieldRoutesRecord, names: string[]) {
  const wanted = new Set(names.map(normalizeFieldName));
  const csvFields = record.csvFields;
  if (Array.isArray(csvFields)) {
    for (const field of csvFields) {
      if (!isRecord(field)) continue;
      if (wanted.has(normalizeFieldName(field.name))) {
        const value = clean(field.value);
        if (value) return value;
      }
    }
  }

  const rawCsv = record.rawCsv;
  if (isRecord(rawCsv)) {
    for (const [name, value] of Object.entries(rawCsv)) {
      if (wanted.has(normalizeFieldName(name))) {
        const raw = clean(value);
        if (raw) return raw;
      }
    }
  }

  return "";
}

function normalizeName(value: unknown) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDate(value: unknown) {
  const raw = clean(value);
  if (!raw) return "";
  if (raw.length >= 10 && raw[4] === "-" && raw[7] === "-") return raw.slice(0, 10);
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

function offsetDate(date: string, days: number) {
  const normalized = normalizeDate(date);
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return normalized;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dateVariants(date: string) {
  const normalized = normalizeDate(date);
  const variants = new Set<string>();
  if (normalized) variants.add(normalized);
  const parsed = new Date(`${normalized}T00:00:00`);
  if (!Number.isNaN(parsed.getTime())) {
    const month = parsed.getUTCMonth() + 1;
    const day = parsed.getUTCDate();
    const year = parsed.getUTCFullYear();
    variants.add(`${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`);
    variants.add(`${month}/${day}/${year}`);
    variants.add(`${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`);
  }
  return [...variants];
}

function firstPresent(record: FieldRoutesRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function deepFindFirstKey(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFindFirstKey(item, keys);
      if (hit !== undefined && hit !== null && hit !== "") return hit;
    }
  }
  if (value && typeof value === "object") {
    const record = value as FieldRoutesRecord;
    const direct = firstPresent(record, keys);
    if (direct !== undefined) return direct;
    for (const nested of Object.values(record)) {
      const hit = deepFindFirstKey(nested, keys);
      if (hit !== undefined && hit !== null && hit !== "") return hit;
    }
  }
  return undefined;
}

function extractRecords(payload: unknown, preferredKeys: string[] = []): FieldRoutesRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  for (const key of preferredKeys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      const nested = extractRecords(value);
      if (nested.length) return nested;
    }
  }

  const data = payload.data;
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data)) {
    for (const key of ["items", "rows", "results", "employees", "routes", "appointments"]) {
      const value = data[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
  }

  if (preferredKeys.includes("appointments") && firstPresent(payload, APPOINTMENT_ID_FIELDS)) {
    return [payload];
  }
  if (preferredKeys.includes("routes") && firstPresent(payload, ROUTE_ID_FIELDS)) {
    return [payload];
  }
  if (preferredKeys.includes("employees") && firstPresent(payload, ["employeeID", "employeeId", "id"])) {
    return [payload];
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.some(isRecord)) return value.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is FieldRoutesRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFieldRoutesEndpointNotFound(error: unknown, endpoint: string) {
  if (!(error instanceof ApproveRouteError)) return false;
  const details = isRecord(error.details) ? error.details : {};
  return (
    String(details.endpoint || "") === endpoint &&
    Number(details.status) === 404
  ) || error.message.includes(`FieldRoutes ${endpoint} failed: HTTP 404`);
}

function extractApiError(payload: unknown) {
  if (!isRecord(payload)) return "";
  const status = payload.status;
  const success = payload.success;
  const error = payload.error;
  const errors = payload.errors;
  if (success === false) return clean(error || errors || "API response marked unsuccessful.");
  if ([0, "0", "error", "failed", false].includes(status as never)) {
    return clean(error || errors || "API returned failure status.");
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  if (Array.isArray(errors) && errors.length) return errors.map(clean).join("; ");
  if (isRecord(errors) && Object.keys(errors).length) return JSON.stringify(errors);
  return "";
}

function extractId(record: FieldRoutesRecord, fields: string[]) {
  const value = firstPresent(record, fields);
  return clean(value);
}

function extractAppointmentDate(record: FieldRoutesRecord) {
  return normalizeDate(firstPresent(record, APPOINTMENT_DATE_FIELDS) || deepFindFirstKey(record, APPOINTMENT_DATE_FIELDS));
}

function extractSequence(record: FieldRoutesRecord) {
  const value = firstPresent(record, SEQUENCE_FIELDS);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function extractCustomerId(record: FieldRoutesRecord) {
  return clean(firstPresent(record, CUSTOMER_FIELDS) || deepFindFirstKey(record, CUSTOMER_FIELDS));
}

function extractSubscriptionId(record: FieldRoutesRecord) {
  return clean(firstPresent(record, SUBSCRIPTION_FIELDS) || deepFindFirstKey(record, SUBSCRIPTION_FIELDS));
}

function parseIntField(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function fieldFromJob(job: FirebaseFirestore.DocumentData, fields: string[]) {
  const direct = clean(firstPresent(job as FieldRoutesRecord, fields));
  if (direct) return direct;
  return csvFieldValue(job as FieldRoutesRecord, fields);
}

function serviceTextForJob(job: FirebaseFirestore.DocumentData) {
  return [
    job.serviceType,
    job.subscriptionCategory,
    job.subscriptionName,
    job.subscription,
    fieldFromJob(job, ["Subscription", "Service Type", "Subscription Category"]),
  ]
    .map(clean)
    .filter(Boolean)
    .join(" ");
}

function gpcServiceKey(job: FirebaseFirestore.DocumentData) {
  const text = serviceTextForJob(job);
  if (!text) return "";
  const normalized = normalizeName(text);
  const match = GPC_SERVICE_CONFIG.find((config) => {
    return config.patterns.some((pattern) => pattern.test(text)) || normalized.includes(config.key.replace(/_/g, " "));
  });
  return match?.key || "";
}

function isGpcServiceJob(job: FirebaseFirestore.DocumentData) {
  return Boolean(gpcServiceKey(job));
}

function parseServiceIdMap(value?: unknown) {
  if (isRecord(value)) {
    const out = new Map<string, number>();
    Object.entries(value).forEach(([key, rawValue]) => {
      const normalizedKey = normalizeName(key);
      const parsed = parseIntField(rawValue);
      if (normalizedKey && parsed) out.set(normalizedKey, parsed);
    });
    return out;
  }

  const raw = clean(value || process.env.FIELDROUTES_SERVICE_ID_MAP || process.env.FIELDROUTES_SERVICE_TYPE_MAP);
  if (!raw) return new Map<string, number>();

  const out = new Map<string, number>();
  const addEntry = (key: unknown, value: unknown) => {
    const normalizedKey = normalizeName(key);
    const parsed = parseIntField(value);
    if (normalizedKey && parsed) out.set(normalizedKey, parsed);
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      Object.entries(parsed).forEach(([key, value]) => addEntry(key, value));
      return out;
    }
  } catch {
    // Fall through to simple key=value parsing.
  }

  raw.split(/[;,]/).forEach((part) => {
    const [key, value] = part.split(/[:=]/);
    addEntry(key, value);
  });
  return out;
}

function mappedServiceTypeForJob(job: FirebaseFirestore.DocumentData) {
  const serviceText = serviceTextForJob(job);
  const normalizedServiceText = normalizeName(serviceText);
  const configuredMap = parseServiceIdMap(job.fieldRoutesServiceIdMap);
  const configuredMatch = [...configuredMap.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([key]) => {
      return Boolean(
        normalizedServiceText &&
          (normalizedServiceText === key || normalizedServiceText.includes(key) || key.includes(normalizedServiceText)),
      );
    });
  if (configuredMatch) return configuredMatch[1];

  const key = gpcServiceKey(job);
  const config = GPC_SERVICE_CONFIG.find((item) => item.key === key);
  if (config) {
    for (const field of config.companyFields) {
      const direct = parseIntField(job[field]);
      if (direct) return direct;
    }
    for (const envKey of config.envKeys) {
      const parsed = parseIntField(process.env[envKey]);
      if (parsed) return parsed;
    }
  }

  return parseIntField(job.fieldRoutesDefaultServiceId || process.env.FIELDROUTES_DEFAULT_SERVICE_ID);
}

function serviceTypeForJob(job: FirebaseFirestore.DocumentData) {
  for (const field of SERVICE_TYPE_FIELDS) {
    const parsed = parseIntField(fieldFromJob(job, [field]));
    if (parsed) return parsed;
  }
  const mapped = mappedServiceTypeForJob(job);
  if (mapped) return mapped;

  throw new ApproveRouteError(
    `No FieldRoutes service ID is configured for ${serviceTextForJob(job) || "this stop"}. Set FIELDROUTES_SERVICE_ID_MAP or the service-specific FieldRoutes service ID env vars.`,
    400,
  );
}

async function resolveFieldRoutesTechId(
  client: FieldRoutesClient,
  route: FirebaseFirestore.DocumentData,
  tech: FirebaseFirestore.DocumentData | undefined,
) {
  const directCandidates = [
    tech?.employeeId,
    tech?.fieldRoutesEmployeeId,
    tech?.fieldRoutesTechId,
    route.fieldRoutesEmployeeId,
    route.fieldRoutesTechId,
    /^\d+$/.test(clean(route.techId)) ? route.techId : "",
  ];
  const direct = directCandidates.map(clean).find(Boolean);
  if (direct) return direct;

  const name = clean(tech?.name || route.techName);
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    throw new ApproveRouteError("Technician is missing a FieldRoutes employee ID and name.", 400);
  }

  const employeePayload = await client.employeeSearch();
  const employees = extractRecords(employeePayload, ["employees", "results", "items", "data"]);
  const matches = employees.filter((employee) => {
    const first = clean(employee.fname || employee.firstName || employee.first_name);
    const last = clean(employee.lname || employee.lastName || employee.last_name);
    const fullName = first || last ? `${first} ${last}`.trim() : clean(employee.name || employee.fullName);
    return normalizeName(fullName) === normalizedName;
  });

  const ids = [...new Set(matches.map((employee) => clean(firstPresent(employee, ["employeeID", "employeeId", "id"]))).filter(Boolean))];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) throw new ApproveRouteError(`Multiple active FieldRoutes employees match ${name}. Set the technician employee ID.`, 409, { ids });
  throw new ApproveRouteError(`No active FieldRoutes employee matches ${name}. Set the technician employee ID in Settings.`, 404);
}

function routeGroupTitleForJobs(route: FirebaseFirestore.DocumentData, jobs: JobRecord[]) {
  const hasGpcJobs = jobs.some(({ data }) => isGpcServiceJob(data));
  if (hasGpcJobs) {
    return clean(
      route.fieldRoutesGpcRouteGroupTitle ||
        route.fieldRoutesRouteGroupTitleGpc ||
        process.env.FIELDROUTES_GPC_ROUTE_GROUP_TITLE ||
        process.env.FIELDROUTES_ROUTE_GROUP_TITLE_GPC,
    ) || GPC_GROUP_TITLE;
  }
  return clean(route.fieldRoutesDefaultRouteGroupTitle || process.env.FIELDROUTES_DEFAULT_ROUTE_GROUP_TITLE);
}

function routeGroupIdFromConfig(route: FirebaseFirestore.DocumentData) {
  return clean(
    route.fieldRoutesGroupID ||
      route.fieldRoutesGroupId ||
      route.fieldRoutesRouteGroupID ||
      route.fieldRoutesGpcRouteGroupId ||
      route.fieldRoutesGpcRouteGroupID ||
      process.env.FIELDROUTES_GPC_ROUTE_GROUP_ID ||
      process.env.FIELDROUTES_ROUTE_GROUP_ID_GPC ||
      process.env.FIELDROUTES_DEFAULT_ROUTE_GROUP_ID,
  );
}

function routeTemplateIdFromConfig(route: FirebaseFirestore.DocumentData) {
  return parseIntField(
    route.fieldRoutesTemplateID ||
      route.fieldRoutesTemplateId ||
      route.fieldRoutesGpcRouteTemplateId ||
      route.fieldRoutesGpcRouteTemplateID ||
      process.env.FIELDROUTES_GPC_ROUTE_TEMPLATE_ID ||
      process.env.FIELDROUTES_ROUTE_TEMPLATE_ID_GPC ||
      process.env.FIELDROUTES_ROUTE_TEMPLATE_ID_DEFAULT,
  );
}

async function discoverRouteGroupId(client: FieldRoutesClient, routeDate: string, groupTitle: string) {
  if (!groupTitle) return "";
  let payload: unknown;
  try {
    payload = await client.routeSearch({
      groupTitle,
      dateStart: offsetDate(routeDate, -365),
      dateEnd: offsetDate(routeDate, 365),
    });
  } catch (error) {
    if (isFieldRoutesEndpointNotFound(error, "/route/search")) return "";
    throw error;
  }
  const records = extractRecords(payload, ["routes", "results", "items", "data"]);
  const ids = records.map((record) => extractId(record, GROUP_ID_FIELDS)).filter(Boolean);
  return [...new Set(ids)][0] || "";
}

function inferExistingRouteFromAppointments(
  records: FieldRoutesRecord[],
  assignedTech: string,
  routeDate: string,
  groupTitle: string,
) {
  const byRouteId = new Map<string, { count: number; groupId: string }>();
  for (const record of records) {
    const routeId = extractId(record, ROUTE_ID_FIELDS);
    if (!routeId) continue;

    const recordDate = extractAppointmentDate(record) || routeDate;
    if (recordDate !== routeDate) continue;

    const recordTech = clean(firstPresent(record, ASSIGNED_TECH_FIELDS));
    if (recordTech && recordTech !== assignedTech) continue;

    const current = byRouteId.get(routeId) || { count: 0, groupId: "" };
    byRouteId.set(routeId, {
      count: current.count + 1,
      groupId: current.groupId || extractId(record, GROUP_ID_FIELDS),
    });
  }

  const best = [...byRouteId.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (!best) return null;
  return {
    routeId: best[0],
    dateInputUsed: routeDate,
    status: "existing_from_appointments" as const,
    routeGroupTitle: groupTitle,
    routeGroupId: best[1].groupId,
  };
}

async function resolveFieldRoutesRoute(
  client: FieldRoutesClient,
  assignedTech: string,
  routeDate: string,
  route: FirebaseFirestore.DocumentData,
  jobs: JobRecord[],
  appointmentRecords: FieldRoutesRecord[],
) {
  const groupTitle = routeGroupTitleForJobs(route, jobs);
  for (const date of dateVariants(routeDate)) {
    let payload: unknown;
    try {
      payload = await client.routeSearch({ assignedTech, date, groupTitle });
    } catch (error) {
      if (isFieldRoutesEndpointNotFound(error, "/route/search")) break;
      throw error;
    }
    const records = extractRecords(payload, ["routes", "results", "items", "data"]);
    for (const record of records) {
      const routeId = extractId(record, ROUTE_ID_FIELDS);
      const recordDate = normalizeDate(firstPresent(record, ["date", "routeDate", "serviceDate"])) || routeDate;
      const recordTech = clean(firstPresent(record, ASSIGNED_TECH_FIELDS));
      if (routeId && recordDate === routeDate && (!recordTech || recordTech === assignedTech)) {
        return {
          routeId,
          dateInputUsed: date,
          status: "existing" as const,
          routeGroupTitle: groupTitle,
          routeGroupId: extractId(record, GROUP_ID_FIELDS),
        };
      }
    }
    const direct = isRecord(payload) ? extractId(payload, ROUTE_ID_FIELDS) : "";
    if (direct) return { routeId: direct, dateInputUsed: date, status: "existing" as const, routeGroupTitle: groupTitle, routeGroupId: "" };
  }

  const routeFromAppointments = inferExistingRouteFromAppointments(
    appointmentRecords,
    assignedTech,
    routeDate,
    groupTitle,
  );
  if (routeFromAppointments) return routeFromAppointments;

  const templateId = routeTemplateIdFromConfig(route);
  const groupId = routeGroupIdFromConfig(route) || (groupTitle ? await discoverRouteGroupId(client, routeDate, groupTitle) : "");
  if (groupTitle && !groupId && !templateId) {
    throw new ApproveRouteError(
      `No ${groupTitle} FieldRoutes route exists for this technician/date, and no route group ID or template ID is configured to create one.`,
      400,
      {
        requiredEnv: [
          "FIELDROUTES_GPC_ROUTE_GROUP_ID",
          "FIELDROUTES_GPC_ROUTE_TEMPLATE_ID",
        ],
      },
    );
  }

  for (const date of dateVariants(routeDate)) {
    const payload = await client.routeCreate({ assignedTech, date, templateId, groupId });
    const records = extractRecords(payload, ["routes", "results", "items", "data"]);
    const fromRecord = records.map((record) => extractId(record, ROUTE_ID_FIELDS)).find(Boolean);
    const direct = isRecord(payload) ? extractId(payload, ROUTE_ID_FIELDS) : "";
    const routeId = fromRecord || direct;
    if (routeId) return { routeId, dateInputUsed: date, status: "created" as const, routeGroupTitle: groupTitle, routeGroupId: groupId };
  }

  throw new ApproveRouteError("FieldRoutes route/create did not return a route ID.", 502);
}

async function fetchAppointmentsForDate(client: FieldRoutesClient, routeDate: string) {
  const combined = new Map<string, FieldRoutesRecord>();
  for (const date of dateVariants(routeDate)) {
    for (const status of [0, undefined]) {
      for (let page = 1; page <= 40; page++) {
        const payload = await client.appointmentSearch(date, date, status, page);
        const records = extractRecords(payload, ["appointments", "results", "items", "data"]);
        let newCount = 0;
        for (const record of records) {
          const id = extractId(record, APPOINTMENT_ID_FIELDS);
          if (!id) continue;
          if (!combined.has(id)) newCount++;
          combined.set(id, record);
        }
        if (records.length === 0 || (page > 1 && newCount === 0)) break;
        const totalPagesRaw = isRecord(payload) ? firstPresent(payload, ["totalPages", "pages", "lastPage"]) : undefined;
        const totalPages = Number(totalPagesRaw);
        if (Number.isFinite(totalPages) && page >= totalPages) break;
      }
    }
  }

  const records = [...combined.values()];
  const needsHydration = records.some((record) => {
    return !extractAppointmentDate(record) || (!extractSubscriptionId(record) && !extractCustomerId(record));
  });
  if (!needsHydration) return records;

  const ids = records.map((record) => extractId(record, APPOINTMENT_ID_FIELDS)).filter(Boolean);
  for (let i = 0; i < ids.length; i += 500) {
    const payload = await client.appointmentGet(ids.slice(i, i + 500));
    for (const record of extractRecords(payload, ["appointments", "results", "items", "data"])) {
      const id = extractId(record, APPOINTMENT_ID_FIELDS);
      if (id) combined.set(id, record);
    }
  }
  return [...combined.values()];
}

function buildAppointmentIndexes(records: FieldRoutesRecord[], routeDate: string) {
  const byId = new Map<string, FieldRoutesRecord>();
  const bySubscription = new Map<string, FieldRoutesRecord[]>();
  const byCustomer = new Map<string, FieldRoutesRecord[]>();

  for (const record of records) {
    const id = extractId(record, APPOINTMENT_ID_FIELDS);
    if (id) byId.set(id, record);
    const date = extractAppointmentDate(record) || routeDate;
    const subscriptionId = extractSubscriptionId(record);
    const customerId = extractCustomerId(record);
    if (subscriptionId) {
      const key = `${subscriptionId}|${date}`;
      bySubscription.set(key, [...(bySubscription.get(key) || []), record]);
    }
    if (customerId) {
      const key = `${customerId}|${date}`;
      byCustomer.set(key, [...(byCustomer.get(key) || []), record]);
    }
  }
  return { byId, bySubscription, byCustomer };
}

function getAppointmentCandidates(
  job: FirebaseFirestore.DocumentData,
  indexes: ReturnType<typeof buildAppointmentIndexes>,
  routeDate: string,
) {
  const directId = fieldFromJob(job, ["appointmentID", "appointmentId", "fieldRoutesAppointmentId"]);
  if (directId) {
    const direct = indexes.byId.get(directId);
    if (direct) return { matchKey: "appointmentID", candidates: [direct] };
  }

  const subscriptionId = clean(job.subscriptionId || job.subscriptionID);
  if (subscriptionId) {
    const candidates = indexes.bySubscription.get(`${subscriptionId}|${routeDate}`) || [];
    if (candidates.length) return { matchKey: "subscriptionID", candidates };
  }

  const customerId = clean(job.customerId || job.customerID);
  if (customerId) {
    const candidates = indexes.byCustomer.get(`${customerId}|${routeDate}`) || [];
    if (candidates.length) return { matchKey: "customerID", candidates };
  }

  return { matchKey: "", candidates: [] };
}

function weekdaySet(value: string) {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

function weekdayLabelForDate(dateStr: string) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return WEEKDAY_LABEL_BY_JS_DAY[date.getUTCDay()] || "";
}

function jobScheduleBlockReason(job: FirebaseFirestore.DocumentData, routeDate: string) {
  const parsed = parseSchedulingRequest(clean(job.schedulingRequest || fieldFromJob(job, ["Special Scheduling", "Scheduling Request"])));
  if (!parsed.schedulingRequestClass) return "";

  if (CRITICAL_CLASSES.has(parsed.schedulingRequestClass)) {
    return parsed.schedulingConstraintNote || parsed.schedulingRequestClass;
  }

  const weekday = weekdayLabelForDate(routeDate);
  const allowed = weekdaySet(parsed.schedulingAllowedWeekdays);
  if (allowed.size > 0 && !allowed.has(weekday)) {
    return `requires ${parsed.schedulingAllowedWeekdays}`;
  }

  const blocked = weekdaySet(parsed.schedulingBlockedWeekdays);
  if (blocked.has(weekday)) {
    return `no ${weekday}`;
  }

  return "";
}

function assignedTechMatchesRoute(
  job: FirebaseFirestore.DocumentData,
  route: FirebaseFirestore.DocumentData,
  tech: FirebaseFirestore.DocumentData | undefined,
) {
  const assigned = clean(job.assignedTechId || fieldFromJob(job, ["Preferred Tech", "assigned_tech", "Tech"]));
  if (!assigned) return true;
  const assignedNormalized = normalizeName(assigned);
  const tokens = [
    route.techId,
    route.techName,
    route.fieldRoutesEmployeeId,
    route.fieldRoutesTechId,
    tech?.id,
    tech?.name,
    tech?.employeeId,
    tech?.fieldRoutesEmployeeId,
    tech?.fieldRoutesTechId,
  ]
    .map(clean)
    .filter(Boolean);
  return tokens.some((token) => token === assigned || normalizeName(token) === assignedNormalized);
}

function sameAddressBundleEligible({
  candidate,
  route,
  tech,
  routeDate,
  alreadyInRoute,
}: {
  candidate: FirebaseFirestore.DocumentData;
  route: FirebaseFirestore.DocumentData;
  tech?: FirebaseFirestore.DocumentData;
  routeDate: string;
  alreadyInRoute: boolean;
}) {
  if (!isGpcServiceJob(candidate)) return false;
  const status = clean(candidate.status || "pending").toLowerCase();
  if (status === "completed" || status === "cancelled") return false;
  if (candidate.serviceDueAlreadyCompleted || serviceDueAlreadyCompleted(candidate)) return false;
  if (!alreadyInRoute && clean(candidate.fieldRoutesUploadedAt || candidate.fieldRoutesRouteId)) return false;
  const dueDate = normalizeDate(candidate.scheduledDate || fieldFromJob(candidate, ["Service Due"]));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;
  const bundleHorizon = offsetDate(routeDate, 14);
  const routeMonth = routeDate.slice(0, 7);
  if (dueDate > bundleHorizon && dueDate.slice(0, 7) !== routeMonth) return false;
  if (!assignedTechMatchesRoute(candidate, route, tech)) return false;
  return !jobScheduleBlockReason(candidate, routeDate);
}

async function expandSameAddressGpcJobs({
  db,
  companyId,
  route,
  tech,
  jobs,
}: {
  db: FirebaseFirestore.Firestore;
  companyId: string;
  route: FirebaseFirestore.DocumentData;
  tech?: FirebaseFirestore.DocumentData;
  jobs: JobRecord[];
}) {
  const routeDate = normalizeDate(route.date);
  const anchors = jobs.filter(({ data }) => isGpcServiceJob(data));
  if (!routeDate || anchors.length === 0) return { jobs, added: 0 };

  const allJobsSnap = await db.collection(`companies/${companyId}/jobs`).get();
  const allJobs = allJobsSnap.docs.map((docSnap) => ({ id: docSnap.id, data: docSnap.data() || {} }));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const byAddress = new Map<string, JobRecord[]>();
  for (const candidate of allJobs) {
    const key = routeAddressKey(candidate.data);
    if (!key) continue;
    byAddress.set(key, [...(byAddress.get(key) || []), candidate]);
  }

  const expanded: JobRecord[] = [];
  const pushed = new Set<string>();
  const originalIds = new Set(jobs.map((job) => job.id));

  for (const job of jobs) {
    if (!pushed.has(job.id)) {
      expanded.push(job);
      pushed.add(job.id);
    }

    if (!isGpcServiceJob(job.data)) continue;
    const addressKey = routeAddressKey(job.data);
    const siblings = (byAddress.get(addressKey) || [])
      .filter((candidate) => {
        if (pushed.has(candidate.id)) return false;
        if (candidate.id === job.id) return false;
        return sameAddressBundleEligible({
          candidate: candidate.data,
          route,
          tech,
          routeDate,
          alreadyInRoute: originalIds.has(candidate.id),
        });
      })
      .sort((a, b) => {
        const dueDiff = normalizeDate(a.data.scheduledDate).localeCompare(normalizeDate(b.data.scheduledDate));
        if (dueDiff !== 0) return dueDiff;
        return serviceTextForJob(a.data).localeCompare(serviceTextForJob(b.data));
      });

    for (const sibling of siblings) {
      const resolved = byId.get(sibling.id) || sibling;
      expanded.push(resolved);
      pushed.add(sibling.id);
      byId.set(sibling.id, resolved);
    }
  }

  return { jobs: expanded, added: expanded.length - jobs.length };
}

async function uploadRouteToFieldRoutes({
  client,
  route,
  tech,
  jobs,
}: {
  client: FieldRoutesClient;
  route: FirebaseFirestore.DocumentData;
  tech?: FirebaseFirestore.DocumentData;
  jobs: JobRecord[];
}) {
  const routeDate = normalizeDate(route.date);
  if (!routeDate) throw new ApproveRouteError("Route is missing a valid date.", 400);

  const assignedTech = await resolveFieldRoutesTechId(client, route, tech);
  const appointmentRecords = await fetchAppointmentsForDate(client, routeDate);
  const routeInfo = await resolveFieldRoutesRoute(
    client,
    assignedTech,
    routeDate,
    route,
    jobs,
    appointmentRecords,
  );
  const indexes = buildAppointmentIndexes(appointmentRecords, routeDate);
  const createMissing = clean(process.env.FIELDROUTES_CREATE_MISSING_APPOINTMENTS || "true").toLowerCase() !== "false";

  const plan: Array<{
    jobId: string;
    customerName: string;
    sequence: number;
    action: "update" | "create" | "unchanged";
    appointmentId?: string;
    customerId?: string;
    subscriptionId?: string;
    serviceType?: number;
    duration?: number;
  }> = [];
  const errors: Array<{ jobId: string; customerName: string; reason: string }> = [];
  const claimedAppointments = new Set<string>();

  jobs.forEach(({ id, data }, index) => {
    const sequence = index + 1;
    const customerName = clean(data.customerName || id);
    const duration = parseIntField(data.duration);
    const { matchKey, candidates } = getAppointmentCandidates(data, indexes, routeDate);

    if (candidates.length > 1) {
      errors.push({ jobId: id, customerName, reason: `${matchKey} matched ${candidates.length} FieldRoutes appointments.` });
      return;
    }

    if (candidates.length === 0) {
      if (!createMissing) {
        errors.push({ jobId: id, customerName, reason: "No FieldRoutes appointment matched this stop." });
        return;
      }
      const customerId = clean(data.customerId || data.customerID);
      if (!customerId) {
        errors.push({ jobId: id, customerName, reason: "Cannot create appointment without customer ID." });
        return;
      }
      plan.push({
        jobId: id,
        customerName,
        sequence,
        action: "create",
        customerId,
        subscriptionId: clean(data.subscriptionId || data.subscriptionID) || undefined,
        serviceType: serviceTypeForJob(data),
        duration,
      });
      return;
    }

    const appointment = candidates[0];
    const appointmentId = extractId(appointment, APPOINTMENT_ID_FIELDS);
    if (!appointmentId) {
      errors.push({ jobId: id, customerName, reason: "Matched appointment has no appointment ID." });
      return;
    }
    if (claimedAppointments.has(appointmentId)) {
      errors.push({ jobId: id, customerName, reason: `Appointment ${appointmentId} is matched by multiple stops.` });
      return;
    }
    claimedAppointments.add(appointmentId);

    const currentRouteId = extractId(appointment, ROUTE_ID_FIELDS);
    const currentTech = clean(firstPresent(appointment, ASSIGNED_TECH_FIELDS));
    const currentSequence = extractSequence(appointment);
    const unchanged =
      currentRouteId === routeInfo.routeId &&
      currentTech === assignedTech &&
      currentSequence === sequence;

    plan.push({
      jobId: id,
      customerName,
      sequence,
      action: unchanged ? "unchanged" : "update",
      appointmentId,
      duration,
    });
  });

  if (errors.length) {
    throw new ApproveRouteError("FieldRoutes upload blocked by unmatched or ambiguous stops.", 409, { errors });
  }

  const summary = {
    routeId: routeInfo.routeId,
    routeStatus: routeInfo.status,
    dateInputUsed: routeInfo.dateInputUsed,
    routeGroupTitle: routeInfo.routeGroupTitle,
    routeGroupId: routeInfo.routeGroupId,
    assignedTech,
    updated: 0,
    created: 0,
    unchanged: 0,
    total: plan.length,
  };

  for (const item of plan) {
    if (item.action === "unchanged") {
      summary.unchanged++;
      continue;
    }
    if (item.action === "create") {
      const payload = await client.appointmentCreate({
        customerId: item.customerId!,
        serviceType: item.serviceType!,
        routeId: routeInfo.routeId,
        assignedTech,
        subscriptionId: item.subscriptionId,
        sequence: item.sequence,
        duration: item.duration,
      });
      const created = extractRecords(payload, ["appointments", "results", "items", "data"])
        .map((record) => extractId(record, APPOINTMENT_ID_FIELDS))
        .find(Boolean);
      const direct = isRecord(payload) ? extractId(payload, APPOINTMENT_ID_FIELDS) : "";
      if (!created && !direct) {
        throw new ApproveRouteError(`FieldRoutes appointment/create did not return an appointment ID for ${item.customerName}.`, 502);
      }
      summary.created++;
      continue;
    }

    await client.appointmentUpdate({
      appointmentId: item.appointmentId!,
      routeId: routeInfo.routeId,
      assignedTech,
      sequence: item.sequence,
      duration: item.duration,
    });
    summary.updated++;
  }

  return summary;
}

export async function POST(request: NextRequest) {
  try {
    const { companyId, routeId, approvedBy } = await request.json();
    if (!companyId || !routeId) {
      return NextResponse.json({ error: "companyId and routeId are required" }, { status: 400 });
    }

    const db = adminDb();
    const [companyDoc, routeDoc] = await Promise.all([
      db.doc(`companies/${companyId}`).get(),
      db.doc(`companies/${companyId}/routes/${routeId}`).get(),
    ]);
    if (!companyDoc.exists) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    if (!routeDoc.exists) return NextResponse.json({ error: "Route not found" }, { status: 404 });

    const company = companyDoc.data() || {};
    const route = routeDoc.data() || {};
    const stopSequence = Array.isArray(route.stopSequence) ? route.stopSequence.map(clean).filter(Boolean) : [];
    if (stopSequence.length === 0) {
      return NextResponse.json({ error: "Route has no stops to approve" }, { status: 400 });
    }

    const authKey = clean(company.fieldRoutesApiKey || process.env.FIELDROUTES_AUTH_KEY || process.env.FIELDROUTES_API_KEY);
    const authToken = clean(company.fieldRoutesApiSecret || process.env.FIELDROUTES_AUTH_TOKEN || process.env.FIELDROUTES_API_SECRET);
    if (!authKey || !authToken) {
      return NextResponse.json({ error: "FieldRoutes credentials are not configured" }, { status: 400 });
    }

    const jobRefs = stopSequence.map((jobId) => db.doc(`companies/${companyId}/jobs/${jobId}`));
    const [techDoc, ...jobDocs] = await Promise.all([
      db.doc(`companies/${companyId}/technicians/${clean(route.techId)}`).get(),
      ...jobRefs.map((ref) => ref.get()),
    ]);

    const missingJobs = jobDocs
      .map((docSnap, index) => ({ exists: docSnap.exists, jobId: stopSequence[index] }))
      .filter((item) => !item.exists)
      .map((item) => item.jobId);
    if (missingJobs.length) {
      return NextResponse.json({ error: "Route contains missing job records", missingJobs }, { status: 409 });
    }

    const fieldRoutesConfig = {
      fieldRoutesGpcRouteGroupId: company.fieldRoutesGpcRouteGroupId,
      fieldRoutesGpcRouteGroupTitle: company.fieldRoutesGpcRouteGroupTitle,
      fieldRoutesGpcRouteTemplateId: company.fieldRoutesGpcRouteTemplateId,
      fieldRoutesServiceIdMap: company.fieldRoutesServiceIdMap,
      fieldRoutesGeneralPestServiceId: company.fieldRoutesGeneralPestServiceId,
      fieldRoutesMosquitoServiceId: company.fieldRoutesMosquitoServiceId,
      fieldRoutesOutdoorPackageServiceId: company.fieldRoutesOutdoorPackageServiceId,
      fieldRoutesDefaultServiceId: company.fieldRoutesDefaultServiceId,
    };
    const routeWithConfig = {
      ...route,
      ...fieldRoutesConfig,
    };
    const initialJobs = jobDocs.map((docSnap) => ({ id: docSnap.id, data: docSnap.data() || {} }));
    const initialJobsWithConfig = initialJobs.map((job) => ({
      ...job,
      data: {
        ...job.data,
        ...fieldRoutesConfig,
      },
    }));
    const tech = techDoc.exists ? techDoc.data() || undefined : undefined;
    const expanded = await expandSameAddressGpcJobs({
      db,
      companyId,
      route: routeWithConfig,
      tech,
      jobs: initialJobsWithConfig,
    });
    const jobs = expanded.jobs;
    const expandedStopSequence = jobs.map((job) => job.id);
    const totalServiceMinutes = jobs.reduce((sum, job) => sum + (parseIntField(job.data.duration) || 25), 0);
    const totalDriveTimeMinutes = Number(route.totalDriveTimeMinutes || 0);
    const totalWorkMinutes = Math.round((totalDriveTimeMinutes + totalServiceMinutes) * 10) / 10;

    const client = new FieldRoutesClient({
      baseUrl: clean(process.env.FIELDROUTES_BASE_URL || "https://api.fieldroutes.com"),
      authKey,
      authToken,
    });
    const syncSummary = await uploadRouteToFieldRoutes({
      client,
      route: routeWithConfig,
      tech,
      jobs,
    });

    const responseSync = {
      bundledSameAddressStops: expanded.added,
      ...syncSummary,
    };
    const now = new Date().toISOString();
    const batch = db.batch();
    batch.update(routeDoc.ref, {
      approved: true,
      approvedAt: now,
      approvedBy: clean(approvedBy),
      updatedAt: now,
      stopSequence: expandedStopSequence,
      totalStops: expandedStopSequence.length,
      totalServiceMinutes,
      totalWorkMinutes,
      fieldRoutesSync: {
        uploadedAt: now,
        ...responseSync,
      },
    });
    jobs.forEach(({ id }, index) => {
      batch.update(db.doc(`companies/${companyId}/jobs/${id}`), {
        status: "scheduled",
        assignedTechId: clean(route.techId),
        fieldRoutesRouteId: syncSummary.routeId,
        fieldRoutesSequence: index + 1,
        fieldRoutesUploadedAt: now,
        updatedAt: now,
      });
    });
    await batch.commit();

    return NextResponse.json({
      success: true,
      approved: true,
      routeId,
      stopSequence: expandedStopSequence,
      totalStops: expandedStopSequence.length,
      totalServiceMinutes,
      totalWorkMinutes,
      bundledSameAddressStops: expanded.added,
      sync: responseSync,
    });
  } catch (error) {
    console.error("Approve route error:", error);
    if (error instanceof ApproveRouteError) {
      return NextResponse.json({ error: error.message, details: error.details }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to approve route", details: String(error) }, { status: 500 });
  }
}
