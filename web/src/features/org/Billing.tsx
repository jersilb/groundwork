import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  CalendarDays,
  CreditCard,
  FileText,
  Landmark,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "../../lib/api";

/**
 * Billing — plan tiers, checkout, and the billing portal.
 *
 * Prices mirror src/commerce/pricing.ts, the worker-side source of truth:
 * tiers run by annual operating budget; year one is the full program (four
 * labs + platform); year two onward is the sustain rate (renewal lab,
 * dashboard, reviews). Monthly billing carries a ~20% premium. The $5M+
 * band is never auto-priced — checkout answers 422 and the sale is handled
 * personally.
 *
 * The free trial is value-based, not time-based: the first two segments of
 * Lab 1 are free (TRIAL_SEGMENT_LIMIT = 2 in pricing.ts), measured against
 * real program progress rather than a clock.
 */

type Band = "under_250k" | "250k_to_1m" | "1m_to_5m" | "5m_plus";
type Cycle = "annual" | "monthly";

interface Tier {
  band: Band;
  label: string;
  year1AnnualUsd: number | null;
  sustainAnnualUsd: number | null;
}

/** Keep in sync with PRICING_TIERS in src/commerce/pricing.ts. */
const TIERS: Tier[] = [
  { band: "under_250k", label: "Under $250K", year1AnnualUsd: 2400, sustainAnnualUsd: 900 },
  { band: "250k_to_1m", label: "$250K–$1M", year1AnnualUsd: 4800, sustainAnnualUsd: 1800 },
  { band: "1m_to_5m", label: "$1M–$5M", year1AnnualUsd: 9600, sustainAnnualUsd: 3600 },
  { band: "5m_plus", label: "$5M+", year1AnnualUsd: null, sustainAnnualUsd: null },
];

const MONTHLY_PREMIUM_MULTIPLIER = 1.2; // matches pricing.ts

function monthlyFromAnnual(annualUsd: number): number {
  return Math.round(((annualUsd * MONTHLY_PREMIUM_MULTIPLIER) / 12) * 100) / 100;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatPrice(annualUsd: number | null, cycle: Cycle): string | null {
  if (annualUsd === null) return null;
  return usd.format(cycle === "annual" ? annualUsd : monthlyFromAnnual(annualUsd));
}

export default function Billing() {
  const { orgId = "demo" } = useParams();
  const [cycle, setCycle] = useState<Cycle>("annual");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);

  async function startCheckout(band: Band) {
    const tier = TIERS.find((t) => t.band === band);
    if (!tier || tier.year1AnnualUsd === null) {
      // Custom-quote band: no checkout page exists — open the contact panel.
      setContactOpen(true);
      return;
    }
    setBusy(band);
    setError(null);
    try {
      const { checkoutUrl } = await api.createCheckout(orgId, {
        band,
        cycle,
        successUrl: window.location.origin + "/org/" + orgId,
        cancelUrl: window.location.href,
      });
      window.location.assign(checkoutUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        // The API only answers 422 when a band needs a manual quote.
        setContactOpen(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError(null);
    try {
      const { portalUrl } = await api.createBillingPortal(orgId, window.location.href);
      window.location.assign(portalUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="ledger-rule flex items-center justify-between bg-surface px-6 py-4">
        <div className="flex items-center gap-2">
          <Landmark className="h-6 w-6 text-brand" aria-hidden />
          <span className="font-display text-lg font-semibold">Billing</span>
        </div>
        <Link to={"/org/" + orgId} className="btn btn-ghost text-sm">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-3xl">Your plan</h1>
        <p className="mt-1 max-w-2xl text-muted">
          One program for every church, priced by annual operating budget so it fits. Year
          one is the full program; year two onward runs at a lighter sustain rate.
        </p>

        {/* Value-based trial — segments, not a clock */}
        <div className="mt-8 rounded-card border border-accent bg-accent-soft p-6">
          <div className="flex flex-wrap items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="max-w-2xl">
              <h2 className="text-xl">Your first segments are free.</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                The trial is a real taste of the process, not a countdown. Your first two
                segments of Lab 1 — with your actual team — are on us. No card, no clock.
                You only pay when you're ready to book the full program.
              </p>
            </div>
          </div>
        </div>

        {/* Cycle toggle */}
        <div className="mt-8 inline-flex rounded-full border border-line-strong bg-surface p-1">
          {(["annual", "monthly"] as const).map((c) => (
            <button
              key={c}
              className={"btn px-5 py-2 text-sm " + (cycle === c ? "btn-primary" : "btn-ghost")}
              onClick={() => setCycle(c)}
            >
              {c === "annual" ? "Annual" : "Monthly"}
              {c === "annual" && <span className="text-xs opacity-80">· saves ~20%</span>}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Monthly billing carries a small premium — annual is the better deal when you can pay up front.
        </p>

        {/* Tier cards */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((t) => {
            const isQuote = t.year1AnnualUsd === null;
            const year1 = formatPrice(t.year1AnnualUsd, cycle);
            const sustain = formatPrice(t.sustainAnnualUsd, cycle);
            return (
              <div
                key={t.band}
                className={
                  "flex flex-col p-6 " +
                  (isQuote
                    ? "rounded-card border border-dashed border-line-strong bg-surface"
                    : "card")
                }
              >
                <span
                  className={
                    "chip self-start " +
                    (isQuote ? "bg-accent-soft text-accent" : "bg-brand-soft text-brand")
                  }
                >
                  {t.label}
                </span>
                <p className="label mt-5">
                  {isQuote ? "Program rate" : cycle === "annual" ? "Year one · billed annually" : "Year one · per month"}
                </p>
                <p className="font-display text-4xl font-semibold text-ink">
                  {isQuote ? "Custom" : year1}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {isQuote
                    ? "Set with you personally"
                    : sustain
                      ? "then " + sustain + (cycle === "annual" ? "/yr" : "/mo") + " from year two"
                      : ""}
                </p>
                <p className="mt-4 text-sm leading-relaxed text-muted">
                  {isQuote
                    ? "Programs at this scale are scoped one-on-one — timing, team, and a rate that fits."
                    : "The full program — four guided labs, the one-page plan, and the sustain rhythm — priced to your budget."}
                </p>
                <button
                  className={"btn mt-6 w-full text-sm " + (isQuote ? "btn-ghost" : "btn-primary")}
                  disabled={busy === t.band}
                  onClick={() => startCheckout(t.band)}
                >
                  {busy === t.band ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Opening checkout…
                    </>
                  ) : isQuote ? (
                    "Contact us"
                  ) : (
                    "Start checkout"
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Custom-quote contact panel (also shown on a 422 from checkout) */}
        {contactOpen && (
          <div
              className="mt-6 rounded-card border border-accent bg-accent-soft p-6"
              role="region"
              aria-label="Custom program quote"
            >
            <h2 className="text-xl">A custom program — let's talk</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Programs at this scale are handled personally, not by a checkout page. Reach
              out to the Groundwork team and we'll scope the program — timing, team size,
              and a rate that fits your church — then send a quote your way.
            </p>
            <button className="btn btn-ghost mt-4 text-sm" onClick={() => setContactOpen(false)}>
              Close
            </button>
          </div>
        )}

        {/* What every tier includes */}
        <section className="mt-12">
          <h2 className="text-2xl">Every tier includes the full program</h2>
          <p className="mt-1 text-sm text-muted">
            The band sets the rate, not the program — every church gets the same arc.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="card p-5">
              <CalendarDays className="h-6 w-6 text-brand" aria-hidden />
              <h3 className="mt-3 text-lg">Four guided labs</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                Purpose, vision, risks, and strategy — one full-day session each, run start to
                finish by the facilitator.
              </p>
            </div>
            <div className="card p-5">
              <FileText className="h-6 w-6 text-brand" aria-hidden />
              <h3 className="mt-3 text-lg">The one-page plan</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                Every session ends with decisions on paper, synthesized into one editable plan
                your team owns.
              </p>
            </div>
            <div className="card p-5">
              <RefreshCw className="h-6 w-6 text-brand" aria-hidden />
              <h3 className="mt-3 text-lg">A sustain rhythm</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                From year two: the renewal lab, the dashboard, and quarterly reviews that keep
                the plan alive.
              </p>
            </div>
          </div>
        </section>

        {/* Billing portal */}
        <section className="card mt-10 p-6">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-accent" aria-hidden />
            <h2 className="font-sans text-base font-semibold">Manage your plan</h2>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Already subscribed? Open the billing portal to update your card, switch between
            annual and monthly, or pull invoices.
          </p>
          <button className="btn btn-ghost mt-4 text-sm" disabled={busy === "portal"} onClick={openPortal}>
            {busy === "portal" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Opening portal…
              </>
            ) : (
              "Open billing portal"
            )}
          </button>
        </section>

        {error && (
          <p className="mt-6 rounded-lg bg-err-soft p-4 text-sm text-err" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
