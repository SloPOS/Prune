import { useEffect, type Dispatch, type SetStateAction } from "react";
import { fetchJsonSafe, parseOptionalNullableNumber, parseOptionalNumber, startPolling } from "../utils/appRuntime";

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
        expectedDurationSec: parseOptionalNumber(data.expectedDurationSec),
        progressSec: parseOptionalNumber(data.progressSec),
        percent: parseOptionalNullableNumber(data.percent),
        etaSec: parseOptionalNullableNumber(data.etaSec),
        error: data.error,
        lastLog: data.lastLog,
      });
    }, intervalMs);
  }, [globalRenderStatus.status, setGlobalRenderStatus]);
}
