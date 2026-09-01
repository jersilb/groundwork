import { useSearchParams } from "react-router-dom";
import { useMemo } from "react";

/** Screen-role token for real lab rooms: delivered as ?st= by the
 * dashboard's open flow and mirrored to sessionStorage so a mid-lab
 * refresh on the same device reconnects without another open call.
 * Shared by the room screen and the instructor console. */
export function useScreenToken(sessionKey: string): string | undefined {
  const [searchParams] = useSearchParams();
  return useMemo(() => {
    const urlToken = searchParams.get("st");
    if (urlToken) return urlToken;
    try {
      return sessionStorage.getItem("groundwork.screenToken." + sessionKey) ?? undefined;
    } catch {
      return undefined;
    }
  }, [searchParams, sessionKey]);
}
