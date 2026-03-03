import { useEffect } from "react";

export function useScopedMobileModalTab<T extends string>(
  visible: boolean,
  mobileTab: T,
  setScopedTab: (updater: ((prev: T | null) => T | null) | (T | null)) => void,
) {
  useEffect(() => {
    if (visible) {
      setScopedTab((prev) => prev ?? mobileTab);
    } else {
      setScopedTab(null);
    }
  }, [visible, mobileTab, setScopedTab]);
}
