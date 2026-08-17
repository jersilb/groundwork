import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Small shared UI pieces for the org screens. Colors come from the
 * theme.css tokens (ok/warn/err/accent/brand) — no ad-hoc values. */

export type ChipTone = "ok" | "warn" | "err" | "accent" | "brand" | "neutral";

const CHIP_TONES: Record<ChipTone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  err: "bg-err-soft text-err",
  accent: "bg-accent-soft text-accent",
  brand: "bg-brand-soft text-brand",
  neutral: "bg-line text-ink-soft",
};

export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip ${CHIP_TONES[tone]}`}>{children}</span>;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface/70 px-6 py-8 text-center">
      <Icon className="h-6 w-6 text-faint" aria-hidden />
      <p className="font-display text-lg text-ink">{title}</p>
      <p className="max-w-sm text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}

export function PanelHeader({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-xl">
        <Icon className="h-5 w-5 text-brand" aria-hidden />
        {title}
      </h2>
      {action}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-err-soft p-4 text-sm leading-relaxed text-err">{children}</p>;
}

export function WarnBanner({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-warn-soft p-4 text-sm leading-relaxed text-warn">{children}</p>;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "grace-community" → "Grace Community" — used to present a URL slug. */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
