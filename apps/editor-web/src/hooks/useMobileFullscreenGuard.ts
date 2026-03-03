import { useCallback, useEffect, useState } from "react";

function isFullscreenActive() {
  const docAny = document as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(document.fullscreenElement || docAny.webkitFullscreenElement);
}

async function exitFullscreenSafe() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      const docAny = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
      if (docAny.webkitExitFullscreen) await docAny.webkitExitFullscreen();
    }
  } catch {
    // noop
  }
}

export function useMobileFullscreenGuard(isMobileLayout: boolean, setToast: (message: string) => void) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleMobileFullscreen = useCallback(async () => {
    if (!isMobileLayout) return;
    try {
      if (isFullscreenActive()) {
        await exitFullscreenSafe();
        setToast("Exited fullscreen");
        return;
      }
      const elAny = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
      if (elAny.requestFullscreen) await elAny.requestFullscreen();
      else if (elAny.webkitRequestFullscreen) await elAny.webkitRequestFullscreen();
      setToast("Fullscreen enabled");
    } catch {
      setToast("Fullscreen not available on this browser");
    }
  }, [isMobileLayout, setToast]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(isFullscreenActive());
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange as EventListener);
    onFullscreenChange();
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!isMobileLayout) return;

    let lastBackAt = 0;
    let allowNextBack = false;
    const guardState = { pruneBackGuard: true, t: Date.now() };
    window.history.pushState(guardState, "");

    const onPopState = () => {
      if (allowNextBack) {
        allowNextBack = false;
        return;
      }

      if (isFullscreenActive()) {
        void exitFullscreenSafe();
        setToast("Exited fullscreen");
        window.history.pushState({ pruneBackGuard: true, t: Date.now() }, "");
        return;
      }

      const now = Date.now();
      if (now - lastBackAt <= 1800) {
        allowNextBack = true;
        void exitFullscreenSafe();
        window.history.back();
        return;
      }
      lastBackAt = now;
      setToast("Press back again to exit Prune");
      window.history.pushState({ pruneBackGuard: true, t: now }, "");
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isMobileLayout, setToast]);

  return { isFullscreen, toggleMobileFullscreen };
}
