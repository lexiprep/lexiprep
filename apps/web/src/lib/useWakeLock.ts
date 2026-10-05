import { useEffect } from "react";

/**
 * Keeps the screen awake while the calling component is mounted. The browser drops the
 * lock whenever the page is hidden (tab switch, app switch, lock button), so it is asked
 * for again each time the page comes back. A no-op where the API is missing, and a refusal
 * (Low Power Mode, an insecure origin) is ignored — staying awake is a nicety.
 */
export function useWakeLock() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let gone = false;

    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (gone) void next.release().catch(() => {});
        else lock = next;
      } catch {
        // refused — the screen just follows the device's own timeout
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, []);
}
