import { createHash } from "crypto";

const STREET_ABBREVIATIONS: Record<string, string> = {
  st: "street",
  str: "street",
  rd: "road",
  ave: "avenue",
  av: "avenue",
  dr: "drive",
  ln: "lane",
  blvd: "boulevard",
  ct: "court",
  cir: "circle",
  pl: "place",
  ter: "terrace",
  trl: "trail",
  tr: "trail",
  hwy: "highway",
  pkwy: "parkway",
  pky: "parkway",
  sq: "square",
  cv: "cove",
};

export function normalizeAddress(raw: string): string {
  if (!raw) return "";

  let s = raw.toLowerCase();
  s = s.replace(/[.,]/g, " ");
  s = s.replace(/[\u2013\u2014]/g, "-");
  s = s.replace(/\s+/g, " ").trim();

  const parts = s.split(" ").map((p) => STREET_ABBREVIATIONS[p] ?? p);
  return parts.join(" ");
}

export function normalizeServiceDate(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();

  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const mdyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdyMatch) {
    const [, m, d, yRaw] = mdyMatch;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return trimmed;
}

export function normalizeServiceType(raw: string): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeJobId(
  address: string,
  serviceDue: string,
  serviceType: string,
): string {
  const addr = normalizeAddress(address);
  const date = normalizeServiceDate(serviceDue);
  const svc = normalizeServiceType(serviceType);

  if (!addr || !date || !svc) {
    throw new Error(
      `computeJobId requires address, serviceDue, serviceType; got addr=${!!addr} date=${!!date} svc=${!!svc}`,
    );
  }

  const key = `${addr}|${date}|${svc}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 20);
}
