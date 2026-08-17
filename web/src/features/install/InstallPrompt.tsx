import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Download, Smartphone, X } from "lucide-react";

/**
 * PWA install prompt.
 *
 * Chromium browsers (Android Chrome, desktop Chrome/Edge) fire
 * "beforeinstallprompt"; iOS Safari never does, so iOS users get the
 * /install help screen instead. Dismissal is remembered on the device.
 *
 * Mount this anywhere a phone user lands — Landing renders it, and it can
 * be dropped into the org Dashboard the same way.
 */

const DISMISS_KEY = "gw-install-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode — nothing persists, the card may return next visit */
  }
}

export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches,
  );

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<"accepted" | "dismissed" | null> => {
    if (!deferred) return null;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    return choice.outcome;
  }, [deferred]);

  return { canInstall: deferred !== null && !installed, promptInstall };
}

export default function InstallPrompt() {
  const { canInstall, promptInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  if (!canInstall || dismissed) return null;

  async function handleInstall() {
    const outcome = await promptInstall();
    if (outcome === "dismissed") setDismissed(true);
  }

  return (
    <aside
      className="fixed inset-x-4 bottom-4 z-40 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
      role="region"
      aria-label="Install Groundwork"
    >
      <div className="rounded-card border border-line bg-surface p-5 shadow-raise">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <Smartphone className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-sans text-base font-semibold text-ink">
              Put Groundwork on your home screen
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Install it like an app — the room is one tap away when your session starts.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary text-sm" onClick={handleInstall}>
                <Download className="h-4 w-4" aria-hidden /> Install
              </button>
              <button className="btn btn-ghost text-sm" onClick={() => setDismissed(true)}>
                Not now
              </button>
            </div>
            <Link
              to="/install"
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand"
            >
              How to install on iPhone or Android
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
          <button
            type="button"
            className="text-faint transition-colors hover:text-ink"
            aria-label="Dismiss install prompt"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}
