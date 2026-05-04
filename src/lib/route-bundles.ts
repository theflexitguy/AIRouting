type CsvBackedRecord = {
  address?: unknown;
  addressRaw?: unknown;
  scheduledDate?: unknown;
  subscriptionLastServiced?: unknown;
  subscriptionLastCompletedDate?: unknown;
  lastServiced?: unknown;
  lastServiceDate?: unknown;
  csvFields?: Array<{ name?: unknown; value?: unknown }>;
  rawCsv?: Record<string, unknown>;
};

const LAST_SERVICED_FIELD_NAMES = [
  "Subscription Last Serviced",
  "Subscription Last Completed",
  "subscriptionLastServiced",
  "subscriptionLastCompleted",
  "Subscription Last Service",
  "Last Serviced",
  "lastServiced",
  "Last Service Date",
  "lastServiceDate",
  "Last Completed",
  "lastCompleted",
];

function normalizeFieldName(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function csvFieldValue(record: CsvBackedRecord, names: string[]) {
  const wanted = new Set(names.map(normalizeFieldName));
  for (const field of record.csvFields || []) {
    if (wanted.has(normalizeFieldName(field.name))) {
      const value = String(field.value || "").trim();
      if (value) return value;
    }
  }

  for (const [name, value] of Object.entries(record.rawCsv || {})) {
    if (wanted.has(normalizeFieldName(name))) {
      const clean = String(value || "").trim();
      if (clean) return clean;
    }
  }

  return "";
}

export function getSubscriptionLastServiced(record: CsvBackedRecord) {
  return (
    String(record.subscriptionLastCompletedDate || "").trim() ||
    String(record.subscriptionLastServiced || "").trim() ||
    String(record.lastServiced || "").trim() ||
    String(record.lastServiceDate || "").trim() ||
    csvFieldValue(record, LAST_SERVICED_FIELD_NAMES)
  );
}

export function normalizeRouteDateValue(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function serviceDueAlreadyCompleted(record: CsvBackedRecord) {
  const dueDate = normalizeRouteDateValue(record.scheduledDate);
  const lastCompleted = normalizeRouteDateValue(getSubscriptionLastServiced(record));
  return Boolean(dueDate && lastCompleted && lastCompleted >= dueDate);
}

export function normalizeRouteAddress(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/#\s*/g, " unit ")
    .replace(/[.,]/g, " ")
    .replace(/\b(street|st\.)\b/g, "st")
    .replace(/\b(avenue|ave\.)\b/g, "ave")
    .replace(/\b(road|rd\.)\b/g, "rd")
    .replace(/\b(drive|dr\.)\b/g, "dr")
    .replace(/\b(lane|ln\.)\b/g, "ln")
    .replace(/\b(court|ct\.)\b/g, "ct")
    .replace(/\b(circle|cir\.)\b/g, "cir")
    .replace(/\b(parkway|pkwy\.)\b/g, "pkwy")
    .replace(/\s+/g, " ")
    .trim();
}

export function routeAddressKey(record: CsvBackedRecord) {
  return normalizeRouteAddress(record.addressRaw || record.address);
}
