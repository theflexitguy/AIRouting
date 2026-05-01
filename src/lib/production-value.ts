export interface ProductionValueInput {
  billingFrequency?: unknown;
  billingPrice?: unknown;
  recurringFrequency?: unknown;
  recurringPrice?: unknown;
  revenue?: unknown;
  productionValue?: unknown;
}

export interface StopProductionValue {
  value: number | null;
  calculatedValue: number | null;
  csvValue: number | null;
  price: number | null;
  multiplier: number | null;
  billingCycleMonths: number | null;
  serviceCycleMonths: number | null;
  source: "calculated" | "csv" | "missing";
  explanation: string;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function toText(value: unknown) {
  return String(value ?? "").trim();
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = toText(value);
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[,$\s]/g, "").replace(/^\((.*)\)$/, "$1");
  if (!cleaned) return null;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return currencyFormatter.format(value);
}

function isPerServiceBilling(value: unknown) {
  const text = toText(value).toLowerCase();
  return (
    text.includes("after each service") ||
    text.includes("per service") ||
    text.includes("per-service") ||
    text.includes("each service")
  );
}

export function parseFrequencyDays(value: unknown): number | null {
  const text = toText(value).toLowerCase();
  if (!text || text.includes("custom")) return null;

  const everyMatch = text.match(/every\s+(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years)/);
  const bareMatch = text.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years)/);
  const match = everyMatch || bareMatch;
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (unit.startsWith("day")) return amount;
    if (unit.startsWith("week")) return amount * 7;
    if (unit.startsWith("month")) return amount * 30;
    if (unit.startsWith("year")) return amount * 365;
  }

  if (text.includes("monthly")) return 30;
  if (text.includes("quarterly")) return 90;
  if (text.includes("semiannual") || text.includes("semi-annual")) return 180;
  if (text.includes("annual") || text.includes("yearly")) return 365;
  if (text.includes("weekly")) return 7;

  return null;
}

function parseFrequencyMonths(value: unknown) {
  const days = parseFrequencyDays(value);
  if (!days) return null;
  return Math.max(days / 30, 0);
}

function formatMultiplier(multiplier: number | null) {
  if (multiplier === null) return "";
  if (Number.isInteger(multiplier)) return `${multiplier}x`;
  return `${roundCurrency(multiplier)}x`;
}

function formatMonths(months: number | null) {
  if (months === null) return "";
  const rounded = roundCurrency(months);
  const label = rounded === 1 ? "month" : "months";
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded} ${label}`;
}

export function calculateStopProductionValue(input: ProductionValueInput): StopProductionValue {
  const price =
    parseMoney(input.recurringPrice) ??
    parseMoney(input.billingPrice) ??
    parseMoney(input.revenue);
  const csvValue = parseMoney(input.productionValue);
  const serviceCycleMonths = parseFrequencyMonths(input.recurringFrequency);
  const billingCycleMonths = isPerServiceBilling(input.billingFrequency)
    ? null
    : parseFrequencyMonths(input.billingFrequency);

  let multiplier: number | null = null;
  let reliableCalculation = false;
  if (price !== null) {
    if (isPerServiceBilling(input.billingFrequency)) {
      multiplier = 1;
      reliableCalculation = true;
    } else if (serviceCycleMonths && billingCycleMonths) {
      multiplier = serviceCycleMonths / billingCycleMonths;
      reliableCalculation = true;
    } else {
      multiplier = 1;
    }
  }

  const calculatedValue = price !== null && multiplier !== null && reliableCalculation
    ? roundCurrency(price * multiplier)
    : null;
  const fallbackPriceValue = price !== null && multiplier !== null
    ? roundCurrency(price * multiplier)
    : null;
  const value = calculatedValue ?? csvValue ?? fallbackPriceValue ?? null;
  const source = calculatedValue !== null
    ? "calculated"
    : csvValue !== null
      ? "csv"
      : fallbackPriceValue !== null
        ? "calculated"
        : "missing";

  let explanation = "No price available for this stop.";
  if (calculatedValue !== null) {
    if (isPerServiceBilling(input.billingFrequency)) {
      explanation = `${formatCurrency(price)} after each service = ${formatCurrency(calculatedValue)} per stop.`;
    } else if (serviceCycleMonths && billingCycleMonths) {
      explanation = `${formatCurrency(price)} per ${formatMonths(billingCycleMonths)} billing over a ${formatMonths(serviceCycleMonths)} service cycle (${formatMultiplier(multiplier)}) = ${formatCurrency(calculatedValue)} per stop.`;
    } else {
      explanation = `${formatCurrency(price)} with no reliable billing/service interval = ${formatCurrency(calculatedValue)} per stop.`;
    }
  } else if (csvValue !== null) {
    explanation = `Using CSV Production Value ${formatCurrency(csvValue)}.`;
  } else if (fallbackPriceValue !== null) {
    explanation = `${formatCurrency(price)} with no reliable billing/service interval = ${formatCurrency(fallbackPriceValue)} per stop.`;
  }

  return {
    value,
    calculatedValue,
    csvValue,
    price,
    multiplier,
    billingCycleMonths,
    serviceCycleMonths,
    source,
    explanation,
  };
}
