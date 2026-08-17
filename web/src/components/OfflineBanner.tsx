import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Global offline indicator. Shows a thin banner whenever the browser is
 * offline; the shared screen and phone clients rely on queued/replayed
 * input, so this is mostly reassurance + degraded-mode signaling.
 */
export default function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-warn px-4 py-2 text-sm font-semibold text-white">
      <WifiOff className="h-4 w-4" aria-hidden />
      You are offline. Your input is queued and will sync when the connection returns.
    </div>
  );
}
