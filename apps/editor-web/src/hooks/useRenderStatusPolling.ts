import { useEffect, type Dispatch, type SetStateAction } from "react";
import { fetchJsonSafe, startPolling } from "../utils/appRuntime";

type GlobalRenderStatusLike = {
  jobId: string | null;
  status: "idle" | "running" | "done" | "error";
  outputPath?: string;
  outputName?: string;
  expectedDurationSec?: number;
  progressSec?: number;
  percent?: number | null;
  etaSec?: number | null;
  error?: string;
  lastLog?: string;
};

export function useRenderStatusPolling(
  globalRenderStatus: GlobalRenderStatusLike,
  setGlobalRenderStatus: Dispatch<SetStateAction<GlobalRenderStatusLike>>,
) {
  useEffect(() => {
    const intervalMs = globalRenderStatus.status === "running" ? 1500 : 8000;
    return startPolling(async () => {
      const data = await fetchJsonSafe("/api/export/render-status");
      if (!data || !data.status) return;
      setGlobalRenderStatus({
        jobId: data.jobId ?? null,
        status: data.status,
        outputPath: data.outputPath,
        outputName: data.outputName,
        expectedDurationSec: typeof data.expectedDurationSec === "number" ? data.expectedDurationSec : undefined,
        progressSec: typeof data.progressSec === "number" ? data.progressSec : undefined,
        percent: typeof data.percent === "number" || data.percent === null ? data.percent : undefined,
        etaSec: typeof data.etaSec === "number" || data.etaSec === null ? data.etaSec : undefined,
        error: data.error,
        lastLog: data.lastLog,
      });
    }, intervalMs);
  }, [globalRenderStatus.status, setGlobalRenderStatus]);
}
