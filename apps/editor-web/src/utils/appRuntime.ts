export type PollStatus = "queued" | "running" | "starting" | "done" | "error" | "idle";

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m ${secs}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDurationShort(seconds?: number | null): string {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "—";
  const total = Math.floor(Number(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export function normalizeRunningStatus<T extends string>(status: T): T {
  return (status === "queued" ? "running" : status) as T;
}

export async function fetchJsonSafe(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export function parseOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function parseOptionalNullableNumber(value: unknown): number | null | undefined {
  return typeof value === "number" || value === null ? value : undefined;
}

export function tailLog(value: unknown, maxLines: number): string[] | undefined {
  return Array.isArray(value) ? value.slice(-maxLines) : undefined;
}

export function startPolling(task: () => Promise<void>, intervalMs: number) {
  let cancelled = false;
  let inFlight = false;

  const run = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      await task();
    } finally {
      inFlight = false;
    }
  };

  void run();
  const timer = window.setInterval(() => {
    void run();
  }, intervalMs);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
}
