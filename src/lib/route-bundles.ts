type CsvBackedRecord = {
  address?: unknown;
  addressRaw?: unknown;
  subscriptionLastServiced?: unknown;
  lastServiced?: unknown;
  lastServiceDate?: unknown;
  csvFields?: Array<{ name?: unknown; value?: unknown }>;
  rawCsv?: Record<string, unknown>;
};

const LAST_SERVICED_FIELD_NAMES = [
  "Subscription Last Serviced",
  "subscriptionLastServiced",
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
    String(record.subscriptionLastServiced || "").trim() ||
    String(record.lastServiced || "").trim() ||
    String(record.lastServiceDate || "").trim() ||
    csvFieldValue(record, LAST_SERVICED_FIELD_NAMES)
  );
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
