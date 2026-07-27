// Pricing — build plan §9. Tier by annual operating budget, not attendance.
// Two-phase structure: year 1 (4 labs + platform), year 2+ sustain (renewal
// lab + dashboard + reviews). Annual billing with a ~20% monthly premium.

export type BudgetBand = "under_250k" | "250k_to_1m" | "1m_to_5m" | "5m_plus";
export type BillingCycle = "annual" | "monthly";

export interface PricingTier {
  band: BudgetBand;
  label: string;
  year1AnnualUsd: number | null; // null = "Quote" (5M+ band)
  sustainAnnualUsd: number | null;
}

export const PRICING_TIERS: Record<BudgetBand, PricingTier> = {
  under_250k: { band: "under_250k", label: "Under $250K", year1AnnualUsd: 2400, sustainAnnualUsd: 900 },
  "250k_to_1m": { band: "250k_to_1m", label: "$250K–$1M", year1AnnualUsd: 4800, sustainAnnualUsd: 1800 },
  "1m_to_5m": { band: "1m_to_5m", label: "$1M–$5M", year1AnnualUsd: 9600, sustainAnnualUsd: 3600 },
  "5m_plus": { band: "5m_plus", label: "$5M+", year1AnnualUsd: null, sustainAnnualUsd: null }, // Quote — Tier 3, Jeremy handles directly
};

const MONTHLY_PREMIUM_MULTIPLIER = 1.2; // ~20% premium for monthly billing, per §9

export function computePriceUsd(band: BudgetBand, cycle: BillingCycle, isSustainYear: boolean): number | null {
  const tier = PRICING_TIERS[band];
  const annual = isSustainYear ? tier.sustainAnnualUsd : tier.year1AnnualUsd;
  if (annual === null) return null; // "Quote" band — never auto-priced
  if (cycle === "annual") return annual;
  return Math.round(((annual * MONTHLY_PREMIUM_MULTIPLIER) / 12) * 100) / 100;
}

/** Free trial: covers setup + the first two segments of Lab 1, not a time
 * window (§9 — "time-boxed trials don't work when the product's unit of
 * value is a scheduled full-day event"). This is checked against real
 * program progress (program_layer's segment_run count), not a clock. */
export const TRIAL_SEGMENT_LIMIT = 2;
