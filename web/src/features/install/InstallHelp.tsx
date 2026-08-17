import { Link } from "react-router-dom";
import {
  Apple,
  ArrowLeft,
  Check,
  Download,
  EllipsisVertical,
  Globe,
  HelpCircle,
  Landmark,
  Plus,
  Share,
  Smartphone,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Install help — how to put Groundwork on a phone's home screen. Reachable
 * at /install (linked from the landing footer and the install card).
 * Written for mixed technical literacy: short, step-by-step, no jargon.
 */

interface Step {
  icon: LucideIcon;
  title: string;
  body: string;
}

const IOS_STEPS: Step[] = [
  {
    icon: Globe,
    title: "Open in Safari",
    body: "If the link opened inside another app, tap Share and choose “Open in Safari” first.",
  },
  {
    icon: Share,
    title: "Tap the Share button",
    body: "It's the square with the up arrow, at the bottom of the screen.",
  },
  {
    icon: Plus,
    title: "Add to Home Screen",
    body: "Scroll down the share sheet and choose “Add to Home Screen”.",
  },
  {
    icon: Check,
    title: "Tap Add",
    body: "It's in the top-right corner. Groundwork is now on your home screen.",
  },
];

const ANDROID_STEPS: Step[] = [
  {
    icon: Globe,
    title: "Open in Chrome",
    body: "Use Chrome, not another app's built-in browser.",
  },
  {
    icon: EllipsisVertical,
    title: "Open the menu",
    body: "Tap the three-dot menu at the top-right of Chrome.",
  },
  {
    icon: Download,
    title: "Install app",
    body: "Choose “Install app” — or “Add to Home screen” on older versions.",
  },
  {
    icon: Check,
    title: "Confirm install",
    body: "Tap “Install”. Groundwork is now on your home screen.",
  },
];

export default function InstallHelp() {
  return (
    <div className="min-h-screen">
      <header className="ledger-rule flex items-center justify-between bg-surface px-6 py-4">
        <div className="flex items-center gap-2">
          <Landmark className="h-6 w-6 text-brand" aria-hidden />
          <span className="font-display text-lg font-semibold">Install Groundwork</span>
        </div>
        <Link to="/join" className="btn btn-ghost text-sm">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl">Install Groundwork on your phone</h1>
        <p className="mt-2 max-w-2xl leading-relaxed text-muted">
          One tap from your home screen and the room is right there — no hunting for the link
          when your session starts.
        </p>

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          {/* iOS */}
          <section className="card p-6" aria-label="iPhone and iPad instructions">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Apple className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h2 className="text-lg">iPhone & iPad</h2>
                <p className="text-xs text-muted">Safari · iOS</p>
              </div>
            </div>
            <ol className="mt-5 space-y-4">
              {IOS_STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-sm font-semibold text-accent">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <step.icon className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Android */}
          <section className="card p-6" aria-label="Android instructions">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Smartphone className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h2 className="text-lg">Android</h2>
                <p className="text-xs text-muted">Chrome · Android</p>
              </div>
            </div>
            <ol className="mt-5 space-y-4">
              {ANDROID_STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-sm font-semibold text-accent">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <step.icon className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="mt-6 rounded-card border border-line bg-surface p-6">
          <div className="flex gap-3">
            <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
            <div>
              <h2 className="text-base">Can't see the option?</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                You're probably inside another app's built-in browser — those can't add
                home-screen shortcuts. Open the link in Safari or Chrome first, then follow
                the steps above.
              </p>
            </div>
          </div>
        </div>

        <p className="mt-6 text-sm leading-relaxed text-muted">
          Installing is optional. If you'd rather not, keep the session link open or re-enter
          the room code — everything works the same from the browser.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/join" className="btn btn-primary">
            Back to join
          </Link>
          <Link to="/" className="btn btn-ghost">
            Back home
          </Link>
        </div>
      </main>
    </div>
  );
}
