// Plans and their limits. Prices, trial days and the plan picker live in Shopify (Managed Pricing, set up in the
// Partner Dashboard). The plan names there must contain the `key` below (any case); an unknown or missing
// subscription counts as Free. Used by the server (limits) and the browser (plan page): no server-only code here.

export type PlanKey = "free" | "pro";

export interface Plan {
  key: PlanKey;
  name: string;
  price: string; // shown on the plan page; the real price is whatever is set in the Partner Dashboard
  variants: number | null; // variants that get forecasts and suggestions; null = no limit
  locations: number | null; // locations whose stock can be counted; null = no limit
  messages: number; // SMS + WhatsApp alerts per calendar month (UTC); each message to each number counts. 0 = none
  features: string[];
}

export const PLANS: Plan[] = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    variants: 50,
    locations: 1,
    messages: 0,
    features: ["Forecasts for your 50 best-selling variants", "Purchase orders and receiving", "Weekly reorder email"],
  },
  {
    key: "pro",
    name: "Pro",
    price: "$29 / month",
    variants: null,
    locations: null,
    messages: 100,
    features: [
      "No variant limit",
      "Stock counted across several locations",
      "Seasonal forecasts from last year's sales",
      "Low-stock alerts by SMS and WhatsApp (100 messages a month)",
      "Priority email support",
    ],
  },
];

export const planByKey = (key?: string | null): Plan => PLANS.find((p) => p.key === key) || PLANS[0];

// Shopify subscription name ("Pro", "Pro plan", "PRO") -> plan key. Checked from the most expensive down, so a
// name holding two plan words can never give less than was paid for.
export function planKeyFromName(name?: string | null): PlanKey {
  const n = String(name || "").toLowerCase();
  return ([...PLANS].reverse().find((p) => p.key !== "free" && new RegExp(`\\b${p.key}\\b`).test(n))?.key ?? "free") as PlanKey;
}

// Seasonal adjustment needs a year of history; it is part of Pro
export const hasSeasonal = (plan: Plan) => plan.key === "pro";
