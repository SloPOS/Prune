import { useEffect, type Dispatch, type SetStateAction } from "react";
import { fetchJsonSafe, normalizeRunningStatus, parseOptionalNullableNumber, parseOptionalNumber, startPolling, tailLog } from "../utils/appRuntime";

type TranscribeStateLike = {
  jobId: string | null;
  status: string;
  log: string[];
  error: string | null;
  transcriptRelPath: string | null;
  startedAt?: number;
  mediaDurationSec?: number;
  transcribedSec?: number;
  phase?: string;
  percent?: number | null;
  etaSec?: number | null;
  speedLabel?: string | null;
};

type ExportStateLike = {
  jobId: string | null;
  status: string;
  outputPath: string | null;
  error: string | null;
  log: string[];
};

export function useTranscribePolling(
  transcribe: TranscribeStateLike,
  setTranscribe: Dispatch<SetStateAction<TranscribeStateLike>>,
) {
  useEffect(() => {
    if (!transcribe.jobId || (transcribe.status !== "running" && transcribe.status !== "starting")) return;
    return startPolling(async () => {
      const query = new URLSearchParams({ jobId: transcribe.jobId! }).toString();
      const data = await fetchJsonSafe(`/api/transcribe/status?${query}`);
      if (!data) return;
      setTranscribe((prev) => ({
        ...prev,
        status: normalizeRunningStatus(data.status),
        transcriptRelPath: data.transcriptRelPath ?? null,
        log: tailLog(data.log, 12) ?? prev.log,
        error: data.error ?? null,
        startedAt: parseOptionalNumber(data.startedAt) ?? prev.startedAt,
        mediaDurationSec: parseOptionalNumber(data.mediaDurationSec) ?? prev.mediaDurationSec,
        transcribedSec: parseOptionalNumber(data.transcribedSec) ?? prev.transcribedSec,
        phase: data.phase ?? prev.phase,
        percent: parseOptionalNumber(data.percent) ?? prev.percent,
        etaSec: parseOptionalNullableNumber(data.etaSec) ?? prev.etaSec,
        speedLabel: typeof data.speedLabel === "string" || data.speedLabel === null ? data.speedLabel : prev.speedLabel,
      }));
    }, 1200);
  }, [transcribe.jobId, transcribe.status, setTranscribe]);
}

export function useExportPolling(
  exportState: ExportStateLike,
  setExportState: Dispatch<SetStateAction<ExportStateLike>>,
  showExportProgressModal: boolean,
  downloadedExportJobs: Set<string>,
  setDownloadedExportJobs: Dispatch<SetStateAction<Set<string>>>,
  autoDownloadWhenReady: boolean,
) {
  useEffect(() => {
    const shouldTrackExport = exportState.status === "running" || exportState.status === "starting";
    const shouldRecoverLatest = showExportProgressModal && !exportState.jobId && shouldTrackExport;
    if (!shouldTrackExport) return;

    return startPolling(async () => {
      if (exportState.jobId) {
        const query = new URLSearchParams({ jobId: exportState.jobId }).toString();
        const data = await fetchJsonSafe(`/api/export/status?${query}`);
        if (!data) return;

        setExportState((prev) => ({
          ...prev,
          status: normalizeRunningStatus(data.status),
          outputPath: data.outputPath ?? prev.outputPath,
          error: data.error ?? null,
          log: tailLog(data.log, 14) ?? prev.log,
        }));

        if (data.status === "done" && data.downloadUrl && !downloadedExportJobs.has(exportState.jobId)) {
          if (autoDownloadWhenReady) window.open(data.downloadUrl, "_blank");
          setDownloadedExportJobs((prev) => new Set(prev).add(exportState.jobId!));
        }
        return;
      }

      if (!shouldRecoverLatest) return;
      const data = await fetchJsonSafe("/api/export/latest-active");
      if (!data || !data.id) return;
      setExportState((prev) => ({
        ...prev,
        jobId: data.id,
        status: normalizeRunningStatus(data.status),
        outputPath: data.outputPath ?? prev.outputPath,
        error: data.error ?? prev.error ?? null,
        log: tailLog(data.log, 14) ?? prev.log,
      }));
    }, exportState.jobId ? 1200 : 1500);
  }, [showExportProgressModal, exportState.jobId, exportState.status, downloadedExportJobs, autoDownloadWhenReady, setExportState, setDownloadedExportJobs]);
}
