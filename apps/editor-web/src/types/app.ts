export type RootName = string;

export type BrowserEntry = {
  name: string;
  type: "dir" | "file";
  relPath: string;
  sizeBytes: number | null;
};

export type RootConfig = { id: string; name: string; path: string };
export type SelectedMedia = { root: RootName; path: string; name: string } | null;
export type TranscriptSource = { root: RootName; path: string } | null;
export type UiTab = "media" | "transcript" | "tools" | "render";
export type OptionalUiTab = UiTab | null;
export type RenderSection = "video" | "editor" | "subs" | "script";
export type DesktopRenderSection = "video" | "project" | "subs";
export type ModalDragKey =
  | "export"
  | "render"
  | "progress"
  | "settings"
  | "about"
  | "dirPicker"
  | "filePicker"
  | "transcribe"
  | "transcriptPrompt"
  | "search"
  | "loadProject"
  | "confirmDelete"
  | "projectName";

export type TreeSelection = { root: RootName; relPath: string; type: "dir" | "file" } | null;

export type TranscribeState = {
  jobId: string | null;
  status: "idle" | "starting" | "running" | "done" | "error";
  log: string[];
  transcriptRelPath: string | null;
  error: string | null;
  startedAt?: number;
  mediaDurationSec?: number;
  transcribedSec?: number;
  phase?: "queued" | "extracting" | "transcribing" | "finalizing" | "done" | "error";
  percent?: number | null;
  etaSec?: number | null;
  speedLabel?: string | null;
};

export type ExportState = {
  jobId: string | null;
  status: "idle" | "starting" | "running" | "done" | "error";
  outputPath: string | null;
  error: string | null;
  log: string[];
};

export type GlobalRenderStatus = {
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

export type ScriptExportState = {
  status: "idle" | "working" | "done" | "error";
  outputPath: string | null;
  error: string | null;
};

export type SubtitleExportState = {
  status: "idle" | "working" | "done" | "error";
  outputPath: string | null;
  error: string | null;
  format: "srt" | "vtt" | null;
};

export type AnalysisCandidate = {
  id: string;
  kind: "breath" | "noise_click";
  startSec: number;
  endSec: number;
  confidence: "low" | "medium" | "high";
  score: number;
  reason: string;
};

export type GalleryItem = {
  id: string;
  root: RootName;
  relPath: string;
  name: string;
  kind: "original" | "export";
  sizeBytes: number;
  modifiedAt: string;
  durationSec: number | null;
  isVideo: boolean;
  isAudio: boolean;
  mediaUrl: string;
  thumbUrl?: string | null;
};

export type GapSuggestion = {
  id: string;
  startSec: number;
  endSec: number;
  gapSec: number;
  trimStartSec: number;
  trimEndSec: number;
  trimSec: number;
};

export const APP_VERSION = "1.0.1";
export const EXPORT_JOB_STORAGE_KEY = "prune-export-job";
export const FUN_MODE_STORAGE_KEY = "prune-fun-mode";
