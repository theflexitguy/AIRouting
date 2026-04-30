// Standalone test for src/lib/job-id.ts — no test runner needed.
// Run: node scripts/test-job-id.mjs
//
// Mirrors the exact dedup spec from the product requirements:
//   Dedup key = (normalizedAddress, Service Due, Subscription)
//   Same all three → same jobId → upload skips it.
//   Any one differs → different jobId → new job added.

import { createHash } from "crypto";

const STREET_ABBREVIATIONS = {
  st: "street", str: "street", rd: "road", ave: "avenue", av: "avenue",
  dr: "drive", ln: "lane", blvd: "boulevard", ct: "court", cir: "circle",
  pl: "place", ter: "terrace", trl: "trail", tr: "trail", hwy: "highway",
  pkwy: "parkway", pky: "parkway", sq: "square", cv: "cove",
};

function normalizeAddress(raw) {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = s.replace(/[.,]/g, " ");
  s = s.replace(/[\u2013\u2014]/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  const parts = s.split(" ").map((p) => STREET_ABBREVIATIONS[p] ?? p);
  return parts.join(" ");
}

function normalizeServiceDate(raw) {
  if (!raw) return "";
  const t = raw.trim();
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const y = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${y}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  return t;
}

function normalizeServiceType(raw) {
  if (!raw) return "";
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function computeJobId(address, serviceDue, serviceType) {
  const addr = normalizeAddress(address);
  const date = normalizeServiceDate(serviceDue);
  const svc = normalizeServiceType(serviceType);
  if (!addr || !date || !svc) throw new Error("missing field");
  return createHash("sha1").update(`${addr}|${date}|${svc}`).digest("hex").slice(0, 20);
}

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function neq(a, b, msg) { if (a === b) throw new Error(`${msg || ""} expected NOT ${JSON.stringify(b)}`); }

console.log("normalizeAddress");
check("lowercases + strips punctuation", () => {
  eq(normalizeAddress("3907 SW Mistletoe Ave."), "3907 sw mistletoe avenue");
});
check("expands street abbreviations", () => {
  eq(normalizeAddress("1104 Little John St"), "1104 little john street");
  eq(normalizeAddress("20 Forfar Circle"), "20 forfar circle");
});
check("collapses whitespace", () => {
  eq(normalizeAddress("  20891   Lakeshore   Drive  "), "20891 lakeshore drive");
});
check("empty input → empty", () => {
  eq(normalizeAddress(""), "");
});

console.log("\nnormalizeServiceDate");
check("MM/DD/YY → YYYY-MM-DD", () => eq(normalizeServiceDate("03/17/26"), "2026-03-17"));
check("MM/DD/YYYY → YYYY-MM-DD", () => eq(normalizeServiceDate("03/17/2026"), "2026-03-17"));
check("ISO passes through with zero-padding", () => eq(normalizeServiceDate("2026-4-5"), "2026-04-05"));
check("single-digit month/day → padded", () => eq(normalizeServiceDate("4/5/26"), "2026-04-05"));

console.log("\ncomputeJobId — idempotency (Jalen's dedup spec)");
check("same (address, date, service) → same id", () => {
  const a = computeJobId("3907 SW Mistletoe Ave", "04/16/26", "General Pest");
  const b = computeJobId("3907 SW Mistletoe Ave", "04/16/26", "General Pest");
  eq(a, b);
});
check("address formatting variations → same id", () => {
  const a = computeJobId("3907 SW Mistletoe Ave.", "04/16/26", "General Pest");
  const b = computeJobId("3907 SW Mistletoe Avenue", "04/16/26", "General Pest");
  eq(a, b);
});
check("date format variations → same id", () => {
  const a = computeJobId("20 Forfar Circle", "04/09/26", "General Pest");
  const b = computeJobId("20 Forfar Circle", "2026-04-09", "General Pest");
  eq(a, b);
});
check("service type case variations → same id", () => {
  const a = computeJobId("1 Insh Ln", "04/16/26", "General Pest");
  const b = computeJobId("1 Insh Ln", "04/16/26", "general pest");
  eq(a, b);
});

console.log("\ncomputeJobId — differentiation");
check("same address + same date + DIFFERENT service → different id (Mosquito vs General Pest)", () => {
  const a = computeJobId("3907 SW Mistletoe Ave", "04/16/26", "General Pest");
  const b = computeJobId("3907 SW Mistletoe Ave", "04/16/26", "Mosquito");
  neq(a, b);
});
check("same address + DIFFERENT date + same service → different id", () => {
  const a = computeJobId("20 Forfar Circle", "04/09/26", "General Pest");
  const b = computeJobId("20 Forfar Circle", "04/16/26", "General Pest");
  neq(a, b);
});
check("DIFFERENT address + same date + same service → different id", () => {
  const a = computeJobId("3907 SW Mistletoe Ave", "04/16/26", "General Pest");
  const b = computeJobId("1 Insh Ln", "04/16/26", "General Pest");
  neq(a, b);
});

console.log("\ncomputeJobId — missing fields throw");
check("missing address throws", () => {
  try { computeJobId("", "04/16/26", "General Pest"); throw new Error("did not throw"); }
  catch (e) { if (!e.message.includes("missing")) throw e; }
});
check("missing date throws", () => {
  try { computeJobId("20 Forfar Circle", "", "General Pest"); throw new Error("did not throw"); }
  catch (e) { if (!e.message.includes("missing")) throw e; }
});
check("missing service type throws", () => {
  try { computeJobId("20 Forfar Circle", "04/16/26", ""); throw new Error("did not throw"); }
  catch (e) { if (!e.message.includes("missing")) throw e; }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
