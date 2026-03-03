import { useEffect, useMemo, useRef, useState } from "react";
import { cutRangesFromDeletedTokens, keepRangesFromCuts, type TimeRange, type WordToken } from "@prune/core";
import pruneLogo from "./assets/prune-logo.jpg";
import { fetchJsonSafe, formatBytes, formatDurationShort, formatEta, normalizeRunningStatus, startPolling } from "./utils/appRuntime";
import { buildScriptBody, isAudioFile, isVideoFile, mergeTimeRanges, normalizeTokens as normalizeTranscript, sanitizeBaseName, tokenAtTime } from "./utils/appMedia";
import { useScopedMobileModalTab } from "./hooks/useScopedMobileModalTab";

type RootName = string;
type BrowserEntry = {
  name: string;
  type: "dir" | "file";
  relPath: string;
  sizeBytes: number | null;
};

type RootConfig = { id: string; name: string; path: string };
type SelectedMedia = { root: RootName; path: string; name: string } | null;
type TranscriptSource = { root: RootName; path: string } | null;
type TreeSelection = { root: RootName; relPath: string; type: "dir" | "file" } | null;

type TranscribeState = {
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

type ExportState = {
  jobId: string | null;
  status: "idle" | "starting" | "running" | "done" | "error";
  outputPath: string | null;
  error: string | null;
  log: string[];
};

type GlobalRenderStatus = {
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

type ScriptExportState = {
  status: "idle" | "working" | "done" | "error";
  outputPath: string | null;
  error: string | null;
};

type SubtitleExportState = {
  status: "idle" | "working" | "done" | "error";
  outputPath: string | null;
  error: string | null;
  format: "srt" | "vtt" | null;
};

type PhraseMatch = {
  phrase: string;
  normalizedPhrase: string;
  tokenIds: string[];
  count: number;
};

type AnalysisCandidate = {
  id: string;
  kind: "breath" | "noise_click";
  startSec: number;
  endSec: number;
  confidence: "low" | "medium" | "high";
  score: number;
  reason: string;
};

type GalleryItem = {
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

type GapSuggestion = {
  id: string;
  startSec: number;
  endSec: number;
  gapSec: number;
  trimStartSec: number;
  trimEndSec: number;
  trimSec: number;
};

const EXPORT_JOB_STORAGE_KEY = "prune-export-job";

const FIXED_SMART_CLEANUP_PHRASES = [
  "um", "uh", "ah", "er", "mm-hmm",
  "like", "basically", "actually", "literally", "seriously", "honestly", "obviously",
  "anyway", "well", "now",
  "right?", "you know?", "okay?", "make sense?", "you see?",
  "i mean", "at the end of the day", "to be honest with you", "for all intents and purposes", "as a matter of fact", "it is what it is",
  "go ahead", "gone ahead", "let's go ahead", "we're gonna", "we're going to",
] as const;

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[’]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

function buildPhraseMatches(tokens: WordToken[]): PhraseMatch[] {
  if (tokens.length === 0) return [];
  const normalizedTokens = tokens.map((token) => ({ token, normalized: normalizeText(token.text) })).filter((t) => t.normalized.length > 0);
  if (normalizedTokens.length === 0) return [];

  const fixedPhrases = FIXED_SMART_CLEANUP_PHRASES.map((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    return { phrase, normalizedPhrase, phraseParts: normalizedPhrase.split(" ").filter(Boolean) };
  }).filter((entry) => entry.normalizedPhrase.length > 0 && entry.phraseParts.length > 0);

  const results: PhraseMatch[] = [];
  for (const entry of fixedPhrases) {
    const tokenIds: string[] = [];
    for (let i = 0; i <= normalizedTokens.length - entry.phraseParts.length; i += 1) {
      let isMatch = true;
      for (let j = 0; j < entry.phraseParts.length; j += 1) {
        if (normalizedTokens[i + j]!.normalized !== entry.phraseParts[j]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        for (let j = 0; j < entry.phraseParts.length; j += 1) tokenIds.push(normalizedTokens[i + j]!.token.id);
      }
    }
    const count = tokenIds.length / entry.phraseParts.length;
    if (count > 0) results.push({ phrase: entry.phrase, normalizedPhrase: entry.normalizedPhrase, tokenIds, count });
  }

  return results.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

function findPhraseTokenIds(tokens: WordToken[], phrase: string): string[] {
  const normalizedPhrase = normalizeText(phrase);
  const parts = normalizedPhrase.split(" ").filter(Boolean);
  if (parts.length === 0) return [];

  const normalizedTokens = tokens.map((token) => ({ token, normalized: normalizeText(token.text) })).filter((t) => t.normalized.length > 0);
  const ids: string[] = [];
  for (let i = 0; i <= normalizedTokens.length - parts.length; i += 1) {
    let ok = true;
    for (let j = 0; j < parts.length; j += 1) {
      if (normalizedTokens[i + j]!.normalized !== parts[j]) {
        ok = false;
        break;
      }
    }
    if (ok) for (let j = 0; j < parts.length; j += 1) ids.push(normalizedTokens[i + j]!.token.id);
  }
  return ids;
}

async function fetchDir(root: RootName, relDir: string): Promise<{ relDir: string; entries: BrowserEntry[] }> {
  const query = new URLSearchParams({ root, dir: relDir }).toString();
  const response = await fetch(`/api/files?${query}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export function App() {
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [tokens, setTokens] = useState<WordToken[]>([]);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [activeMediaKind, setActiveMediaKind] = useState<"video" | "audio">("video");
  const [videoLabel, setVideoLabel] = useState<string>("No Media Loaded");
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia>(null);
  const [transcriptSource, setTranscriptSource] = useState<TranscriptSource>(null);
  const [exportName, setExportName] = useState<string>("edited-cut");
  const [videoDurationSec, setVideoDurationSec] = useState<number>(0);
  const [splitLeftPct, setSplitLeftPct] = useState<number>(40);
  const [isResizing, setIsResizing] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [mobileTab, setMobileTab] = useState<"media" | "transcript" | "tools" | "render">("media");
  const [filePickerModalTab, setFilePickerModalTab] = useState<"media" | "transcript" | "tools" | "render" | null>(null);
  const [transcriptPromptTab, setTranscriptPromptTab] = useState<"media" | "transcript" | "tools" | "render" | null>(null);
  const [transcribeModalTab, setTranscribeModalTab] = useState<"media" | "transcript" | "tools" | "render" | null>(null);
  const [exportModalTab, setExportModalTab] = useState<"media" | "transcript" | "tools" | "render" | null>(null);
  const [renderPanelTab, setRenderPanelTab] = useState<"media" | "transcript" | "tools" | "render" | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);

  const [roots, setRoots] = useState<RootConfig[]>([]);
  const [transcriptPickerRoot, setTranscriptPickerRoot] = useState<RootConfig | null>(null);
  const [pickerEntriesByDir, setPickerEntriesByDir] = useState<Record<string, BrowserEntry[]>>({});
  const [pickerLoadingDirs, setPickerLoadingDirs] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TreeSelection>(null);
  const [uploadStatus, setUploadStatus] = useState<string>("idle");
  const [uploadProgress, setUploadProgress] = useState<{ active: boolean; loaded: number; total: number; speedBps: number; etaSec: number | null; name: string }>({ active: false, loaded: 0, total: 0, speedBps: 0, etaSec: null, name: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [settingsNeedsSetup, setSettingsNeedsSetup] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsRootsDraft, setSettingsRootsDraft] = useState<Array<{ name: string; path: string }>>([{ name: "Media", path: "" }]);
  const [settingsUploadDir, setSettingsUploadDir] = useState("");
  const [settingsExportDir, setSettingsExportDir] = useState("");
  const [settingsTranscriptDir, setSettingsTranscriptDir] = useState("");
  const [settingsProjectsDir, setSettingsProjectsDir] = useState("");
  const [settingsExportCacheHours, setSettingsExportCacheHours] = useState("72");
  const [isLightMode, setIsLightMode] = useState(false);
  const [settingsHealth, setSettingsHealth] = useState<any>(null);
  const [settingsDraftRootHealth, setSettingsDraftRootHealth] = useState<Record<number, "ok" | "missing" | "checking">>({});
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [dirPickerPath, setDirPickerPath] = useState("/");
  const [dirPickerParent, setDirPickerParent] = useState<string | null>(null);
  const [dirPickerDirs, setDirPickerDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [dirPickerError, setDirPickerError] = useState<string | null>(null);
  const [dirPickerOnPick, setDirPickerOnPick] = useState<((value: string) => void) | null>(null);
  const [dirPickerShowHidden, setDirPickerShowHidden] = useState(false);
  const [dirPickerNewFolderName, setDirPickerNewFolderName] = useState("");

  const [transcribe, setTranscribe] = useState<TranscribeState>({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
  const [exportState, setExportState] = useState<ExportState>({ jobId: null, status: "idle", outputPath: null, error: null, log: [] });
  const [scriptExport, setScriptExport] = useState<ScriptExportState>({ status: "idle", outputPath: null, error: null });
  const [subtitleExport, setSubtitleExport] = useState<SubtitleExportState>({ status: "idle", outputPath: null, error: null, format: null });
  const [scriptIncludeDeleted, setScriptIncludeDeleted] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showRenderPanel, setShowRenderPanel] = useState(false);
  const [renderContainer, setRenderContainer] = useState<"mp4" | "mov" | "webm">("mp4");
  const [renderCodec, setRenderCodec] = useState<"h264" | "h265" | "vp8" | "vp9" | "prores">("h264");
  const [renderResolution, setRenderResolution] = useState("source");
  const [renderFps, setRenderFps] = useState("source");
  const [renderSourceInfo, setRenderSourceInfo] = useState<any>(null);
  const [mobileRenderSection, setMobileRenderSection] = useState<"video" | "editor" | "subs" | "script">("video");
  const [desktopRenderSection, setDesktopRenderSection] = useState<"video" | "project" | "subs">("video");
  const [showExportProgressModal, setShowExportProgressModal] = useState(false);
  const [notifyWhenRenderReady, setNotifyWhenRenderReady] = useState(true);
  const [autoDownloadWhenReady, setAutoDownloadWhenReady] = useState(false);
  const [showInAppNotifyModal, setShowInAppNotifyModal] = useState(false);
  const [inAppNotifyMessage, setInAppNotifyMessage] = useState("");
  const [inAppNotifyDownloadUrl, setInAppNotifyDownloadUrl] = useState<string | null>(null);
  const [faviconAlert, setFaviconAlert] = useState(false);
  const [exportModalOffset, setExportModalOffset] = useState({ x: 0, y: 0 });
  const [renderModalOffset, setRenderModalOffset] = useState({ x: 0, y: 0 });
  const [progressModalOffset, setProgressModalOffset] = useState({ x: 0, y: 0 });
  const [settingsModalOffset, setSettingsModalOffset] = useState({ x: 0, y: 0 });
  const [aboutModalOffset, setAboutModalOffset] = useState({ x: 0, y: 0 });
  const [dirPickerModalOffset, setDirPickerModalOffset] = useState({ x: 0, y: 0 });
  const [filePickerModalOffset, setFilePickerModalOffset] = useState({ x: 0, y: 0 });
  const [transcribeModalOffset, setTranscribeModalOffset] = useState({ x: 0, y: 0 });
  const [transcriptPromptModalOffset, setTranscriptPromptModalOffset] = useState({ x: 0, y: 0 });
  const [searchModalOffset, setSearchModalOffset] = useState({ x: 0, y: 0 });
  const [loadProjectModalOffset, setLoadProjectModalOffset] = useState({ x: 0, y: 0 });
  const [confirmDeleteModalOffset, setConfirmDeleteModalOffset] = useState({ x: 0, y: 0 });
  const [projectNameModalOffset, setProjectNameModalOffset] = useState({ x: 0, y: 0 });
  const [draggingModal, setDraggingModal] = useState<null | { key: "export" | "render" | "progress" | "settings" | "about" | "dirPicker" | "filePicker" | "transcribe" | "transcriptPrompt" | "search" | "loadProject" | "confirmDelete" | "projectName"; startX: number; startY: number; originX: number; originY: number }>(null);
  const [loadingUiMessage, setLoadingUiMessage] = useState<string | null>(null);
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [filePickerIntent, setFilePickerIntent] = useState<"media" | "json">("media");
  const [filePickerShowAll, setFilePickerShowAll] = useState(false);
  const [showTranscriptPrompt, setShowTranscriptPrompt] = useState(false);
  const [showTranscribeModal, setShowTranscribeModal] = useState(false);
  const [sttPreset, setSttPreset] = useState<"fast" | "balanced" | "quality">("balanced");
  const [showSttPresetMenu, setShowSttPresetMenu] = useState(false);
  const [showSttPresetMenuInline, setShowSttPresetMenuInline] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [galleryScope, setGalleryScope] = useState<"originals" | "exports" | "both">("both");
  const [galleryShowAllFiles, setGalleryShowAllFiles] = useState(false);
  const [gallerySearch, setGallerySearch] = useState("");
  const [gallerySort, setGallerySort] = useState("date_desc");
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [gallerySelected, setGallerySelected] = useState<Set<string>>(new Set());
  const [galleryConfirmAction, setGalleryConfirmAction] = useState<null | { type: "download" | "delete" | "deleteSelected"; item?: GalleryItem }>(null);
  const [lastAutoLoadedTranscriptJobId, setLastAutoLoadedTranscriptJobId] = useState<string | null>(null);
  const [filePickerFromTranscriptPrompt, setFilePickerFromTranscriptPrompt] = useState(false);
  const [exportCapabilities, setExportCapabilities] = useState<Array<{ format: string; videoEncoder: string | null; speed: string }>>([]);
  const [downloadedExportJobs, setDownloadedExportJobs] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<Set<string>[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [currentProjectName, setCurrentProjectName] = useState<string>("");
  const [showLoadProjectModal, setShowLoadProjectModal] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Array<{ projectId: string; projectName: string; root: string; path: string; updatedAt?: string }>>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<{ root: RootName; relPath: string } | null>(null);
  const [showProjectNameModal, setShowProjectNameModal] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [openLeftPanel, setOpenLeftPanel] = useState<"noise" | "stt" | "renderStatus" | null>(null);
  const [globalRenderStatus, setGlobalRenderStatus] = useState<GlobalRenderStatus>({ jobId: null, status: "idle" });
  const [subtitleIncludeDeleted, setSubtitleIncludeDeleted] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [activeTokenIndex, setActiveTokenIndex] = useState<number>(-1);
  const [previewCuts, setPreviewCuts] = useState(true);
  const [ignoredPhrases, setIgnoredPhrases] = useState<Set<string>>(new Set());
  const [highlightedPhrase, setHighlightedPhrase] = useState<string | null>(null);
  const [searchPhrase, setSearchPhrase] = useState("");
  const [showTranscriptTips, setShowTranscriptTips] = useState(false);
  const [showTranscriptSearchModal, setShowTranscriptSearchModal] = useState(false);
  const [rangeSelectMode, setRangeSelectMode] = useState(false);
  const [rangeSelectAnchor, setRangeSelectAnchor] = useState<number | null>(null);
  const [gapShortenerEnabled, setGapShortenerEnabled] = useState(false);
  const [gapMinThresholdSec, setGapMinThresholdSec] = useState(0.8);
  const [gapLeaveBehindSec, setGapLeaveBehindSec] = useState(0.12);
  const [appliedGapCuts, setAppliedGapCuts] = useState<TimeRange[]>([]);
  const [openToolPanel, setOpenToolPanel] = useState<"smart" | "gap" | "summary" | null>(null);
  const [dragStartIndex, setDragStartIndex] = useState<number | null>(null);
  const [dragEndIndex, setDragEndIndex] = useState<number | null>(null);
  const [isDraggingTokens, setIsDraggingTokens] = useState(false);
  const [suppressNextTokenClick, setSuppressNextTokenClick] = useState(false);
  const [detectBreaths, setDetectBreaths] = useState(true);
  const [detectNoiseClicks, setDetectNoiseClicks] = useState(true);
  const [analysisCandidates, setAnalysisCandidates] = useState<AnalysisCandidate[]>([]);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "running" | "error">("idle");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mobileVideoRef = useRef<HTMLVideoElement | null>(null);
  const mobileAudioRef = useRef<HTMLAudioElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const jsonUploadInputRef = useRef<HTMLInputElement | null>(null);
  const exportModalRef = useRef<HTMLDivElement | null>(null);
  const renderModalRef = useRef<HTMLDivElement | null>(null);
  const progressModalRef = useRef<HTMLDivElement | null>(null);
  const settingsModalRef = useRef<HTMLDivElement | null>(null);
  const aboutModalRef = useRef<HTMLDivElement | null>(null);
  const dirPickerModalRef = useRef<HTMLDivElement | null>(null);
  const filePickerModalRef = useRef<HTMLDivElement | null>(null);
  const transcribeModalRef = useRef<HTMLDivElement | null>(null);
  const transcriptPromptModalRef = useRef<HTMLDivElement | null>(null);
  const searchModalRef = useRef<HTMLDivElement | null>(null);
  const loadProjectModalRef = useRef<HTMLDivElement | null>(null);
  const confirmDeleteModalRef = useRef<HTMLDivElement | null>(null);
  const projectNameModalRef = useRef<HTMLDivElement | null>(null);
  const exportPreviewRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const prevExportStatusRef = useRef<ExportState["status"]>("idle");
  const prevExportJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("bitcut-theme");
    if (savedTheme === "light") setIsLightMode(true);
    void loadSettingsAndRoots();
    void loadExportCapabilities();

    const savedExportJobId = window.localStorage.getItem(EXPORT_JOB_STORAGE_KEY);
    if (savedExportJobId) {
      setExportState((prev) => ({ ...prev, jobId: savedExportJobId, status: "running" }));
      setShowExportProgressModal(true);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", isLightMode ? "light" : "dark");
    window.localStorage.setItem("bitcut-theme", isLightMode ? "light" : "dark");
  }, [isLightMode]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const apply = () => {
      const ua = navigator.userAgent || "";
      const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      setIsMobileLayout(Boolean(query.matches && (isMobileUa || coarse)));
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    if (!isResizing || isMobileLayout) return;
    function onMove(event: MouseEvent) {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const minLeftPx = 420;
      const minRightPx = 520;
      const minPct = (minLeftPx / rect.width) * 100;
      const maxPct = 100 - ((minRightPx + 8) / rect.width) * 100;
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(minPct, Math.min(maxPct, pct));
      setSplitLeftPct(Number.isFinite(clamped) ? clamped : 40);
    }
    function onUp() { setIsResizing(false); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing, isMobileLayout]);

  useEffect(() => {
    if (!isDraggingTokens) return;
    const onUp = () => endTokenDrag();
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [isDraggingTokens, dragStartIndex, dragEndIndex]);

  useEffect(() => {
    if (!draggingModal || isMobileLayout) return;
    const onMove = (e: MouseEvent) => {
      const nextX = draggingModal.originX + (e.clientX - draggingModal.startX);
      const nextY = draggingModal.originY + (e.clientY - draggingModal.startY);
      const setByKey: Record<string, { ref: HTMLDivElement | null; set: (v: { x: number; y: number }) => void }> = {
        export: { ref: exportModalRef.current, set: setExportModalOffset },
        render: { ref: renderModalRef.current, set: setRenderModalOffset },
        progress: { ref: progressModalRef.current, set: setProgressModalOffset },
        settings: { ref: settingsModalRef.current, set: setSettingsModalOffset },
        about: { ref: aboutModalRef.current, set: setAboutModalOffset },
        dirPicker: { ref: dirPickerModalRef.current, set: setDirPickerModalOffset },
        filePicker: { ref: filePickerModalRef.current, set: setFilePickerModalOffset },
        transcribe: { ref: transcribeModalRef.current, set: setTranscribeModalOffset },
        transcriptPrompt: { ref: transcriptPromptModalRef.current, set: setTranscriptPromptModalOffset },
        search: { ref: searchModalRef.current, set: setSearchModalOffset },
        loadProject: { ref: loadProjectModalRef.current, set: setLoadProjectModalOffset },
        confirmDelete: { ref: confirmDeleteModalRef.current, set: setConfirmDeleteModalOffset },
        projectName: { ref: projectNameModalRef.current, set: setProjectNameModalOffset },
      };
      const target = setByKey[draggingModal.key];
      if (!target) return;
      target.set(clampModalOffset(nextX, nextY, target.ref));
    };
    const onUp = () => setDraggingModal(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingModal, isMobileLayout]);

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
        log: Array.isArray(data.log) ? data.log.slice(-12) : prev.log,
        error: data.error ?? null,
        startedAt: typeof data.startedAt === "number" ? data.startedAt : prev.startedAt,
        mediaDurationSec: typeof data.mediaDurationSec === "number" ? data.mediaDurationSec : prev.mediaDurationSec,
        transcribedSec: typeof data.transcribedSec === "number" ? data.transcribedSec : prev.transcribedSec,
        phase: data.phase ?? prev.phase,
        percent: typeof data.percent === "number" ? data.percent : prev.percent,
        etaSec: typeof data.etaSec === "number" || data.etaSec === null ? data.etaSec : prev.etaSec,
        speedLabel: typeof data.speedLabel === "string" || data.speedLabel === null ? data.speedLabel : prev.speedLabel,
      }));
    }, 1200);
  }, [transcribe.jobId, transcribe.status]);

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
          log: Array.isArray(data.log) ? data.log.slice(-14) : prev.log,
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
        log: Array.isArray(data.log) ? data.log.slice(-14) : prev.log,
      }));
    }, exportState.jobId ? 1200 : 1500);
  }, [showExportProgressModal, exportState.jobId, exportState.status, downloadedExportJobs, autoDownloadWhenReady]);

  useEffect(() => {
    const prevStatus = prevExportStatusRef.current;
    const prevJobId = prevExportJobIdRef.current;
    const currentJobId = exportState.jobId;
    const enteringRun = currentJobId && (exportState.status === "starting" || exportState.status === "running") && (prevStatus !== "starting" && prevStatus !== "running" || prevJobId !== currentJobId);
    if (enteringRun) setShowExportProgressModal(true);

    if (currentJobId && (exportState.status === "starting" || exportState.status === "running")) {
      window.localStorage.setItem(EXPORT_JOB_STORAGE_KEY, currentJobId);
    }

    const finishedSameJob = currentJobId && prevJobId === currentJobId && (prevStatus === "starting" || prevStatus === "running") && (exportState.status === "done" || exportState.status === "error");
    if (finishedSameJob) {
      window.localStorage.removeItem(EXPORT_JOB_STORAGE_KEY);
      if (showExportProgressModal) setShowExportProgressModal(false);
      if (notifyWhenRenderReady) {
        const doneUrl = exportState.status === "done" && currentJobId ? `/api/export/download?jobId=${currentJobId}` : null;
        const msg = exportState.status === "done"
          ? `Render finished. ${globalRenderStatus.outputName || "Your download is ready."}`
          : `Render failed${exportState.error ? `: ${exportState.error}` : "."}`;
        setToast(msg);
        triggerInAppRenderNotice(msg, doneUrl);
      }
    }

    prevExportStatusRef.current = exportState.status;
    prevExportJobIdRef.current = exportState.jobId;
  }, [exportState.status, exportState.jobId, exportState.error, notifyWhenRenderReady, showExportProgressModal, globalRenderStatus.outputName]);

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (!link) return;
    link.href = faviconAlert ? "/favicon-alert.svg" : "/favicon.svg";
  }, [faviconAlert]);

  useEffect(() => {
    const shouldLoadRenderDetails = Boolean(selectedMedia) && (showRenderPanel || (isMobileLayout && mobileTab === "render"));
    if (!shouldLoadRenderDetails || !selectedMedia) return;
    const query = new URLSearchParams({ root: selectedMedia.root, path: selectedMedia.path }).toString();
    void fetch(`/api/media/probe?${query}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        const details = d?.details ?? null;
        setRenderSourceInfo(details);
        const srcContainer = String(details?.container || "").toLowerCase();
        if (srcContainer === "mp4" || srcContainer === "mov" || srcContainer === "webm") setRenderContainer(srcContainer);
      })
      .catch(() => setRenderSourceInfo(null));
  }, [showRenderPanel, isMobileLayout, mobileTab, selectedMedia?.root, selectedMedia?.path]);

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
  }, [globalRenderStatus.status]);

  useEffect(() => {
    if (transcribe.status !== "done" || !transcribe.jobId || !transcribe.transcriptRelPath) return;
    if (!transcriptPickerRoot) return;
    if (lastAutoLoadedTranscriptJobId === transcribe.jobId) return;
    setLastAutoLoadedTranscriptJobId(transcribe.jobId);
    void loadTranscript(transcriptPickerRoot.id, transcribe.transcriptRelPath, true).then((ok) => {
      if (ok) {
        if (isMobileLayout) setMobileTab("transcript");
      } else {
        setToast("Transcription finished, but auto-load failed. Use Browse JSON.");
      }
    });
  }, [transcribe.status, transcribe.jobId, transcribe.transcriptRelPath, transcriptPickerRoot, lastAutoLoadedTranscriptJobId, isMobileLayout]);

  useEffect(() => { setActiveTokenIndex(tokenAtTime(tokens, currentTimeSec)); }, [tokens, currentTimeSec]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = 0;
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (mobileVideoRef.current) mobileVideoRef.current.currentTime = 0;
    if (mobileAudioRef.current) mobileAudioRef.current.currentTime = 0;
    setCurrentTimeSec(0);
    setActiveTokenIndex(-1);
    setVideoDurationSec(0);
  }, [videoSrc]);

  const tokenCuts = useMemo(() => cutRangesFromDeletedTokens(tokens, deleted), [deleted, tokens]);
  const gapSuggestions = useMemo(() => {
    if (tokens.length < 2) return [] as GapSuggestion[];
    const suggestions: GapSuggestion[] = [];
    const leaveBehind = Math.max(0, gapLeaveBehindSec);
    const minGap = Math.max(0, gapMinThresholdSec);
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const prev = tokens[i]!;
      const next = tokens[i + 1]!;
      const gapSec = next.startSec - prev.endSec;
      if (gapSec < minGap) continue;
      const trimSec = gapSec - Math.min(leaveBehind, gapSec);
      if (trimSec <= 0) continue;
      const halfLeave = Math.min(leaveBehind, gapSec) / 2;
      const trimStartSec = prev.endSec + halfLeave;
      const trimEndSec = next.startSec - halfLeave;
      if (trimEndSec <= trimStartSec) continue;
      suggestions.push({
        id: `gap-${i}`,
        startSec: prev.endSec,
        endSec: next.startSec,
        gapSec,
        trimStartSec,
        trimEndSec,
        trimSec,
      });
    }
    return suggestions;
  }, [tokens, gapLeaveBehindSec, gapMinThresholdSec]);
  const effectiveGapCuts = useMemo(() => (gapShortenerEnabled ? appliedGapCuts : []), [appliedGapCuts, gapShortenerEnabled]);
  const cuts = useMemo(() => mergeTimeRanges([...tokenCuts, ...effectiveGapCuts]), [tokenCuts, effectiveGapCuts]);
  const transcriptDurationSec = useMemo(() => tokens.reduce((max, t) => Math.max(max, t.endSec), 0), [tokens]);
  const keeps = useMemo(() => keepRangesFromCuts(transcriptDurationSec, cuts), [cuts, transcriptDurationSec]);
  const renderKeeps = useMemo(() => {
    if (keeps.length > 0) return keeps;
    if (videoDurationSec > 0) return [{ sourceStartSec: 0, sourceEndSec: videoDurationSec, startSec: 0, endSec: videoDurationSec } as any];
    return [];
  }, [keeps, videoDurationSec]);
  const totalCutSec = useMemo(() => cuts.reduce((sum, c) => sum + (c.endSec - c.startSec), 0), [cuts]);
  const totalKeepSec = useMemo(() => keeps.reduce((sum, k) => sum + (k.sourceEndSec - k.sourceStartSec), 0), [keeps]);

  const transcribeProgress = useMemo(() => {
    const duration = transcribe.mediaDurationSec ?? 0;
    const progressSec = transcribe.transcribedSec ?? 0;
    const derivedPct = duration > 0 ? Math.min(100, Math.max(0, (progressSec / duration) * 100)) : transcribe.status === "done" ? 100 : 0;
    const pct = typeof transcribe.percent === "number" ? transcribe.percent : derivedPct;
    const elapsedSec = transcribe.startedAt ? Math.max(0, (Date.now() - transcribe.startedAt) / 1000) : 0;
    const speed = elapsedSec > 0 ? progressSec / elapsedSec : 0;
    const remaining = typeof transcribe.etaSec === "number" ? transcribe.etaSec : (duration > progressSec && speed > 0 ? (duration - progressSec) / speed : 0);
    return { pct, speed, remaining, duration, progressSec, speedLabel: transcribe.speedLabel };
  }, [transcribe]);

  const approxRenderSeconds = useMemo(() => {
    const duration = Number(renderSourceInfo?.durationSec || videoDurationSec || totalKeepSec || 0);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const speed = renderCodec === "h265" ? 0.35 : renderCodec === "prores" ? 0.8 : renderCodec === "vp9" ? 0.4 : renderCodec === "vp8" ? 0.7 : 0.9;
    return Math.max(8, Math.round(duration / speed));
  }, [renderCodec, renderSourceInfo?.durationSec, totalKeepSec, videoDurationSec]);

  const clampModalOffset = (x: number, y: number, modalEl: HTMLDivElement | null) => {
    if (!modalEl) return { x, y };
    const rect = modalEl.getBoundingClientRect();
    const maxX = Math.max(0, (window.innerWidth - rect.width) / 2 - 12);
    const maxY = Math.max(0, (window.innerHeight - rect.height) / 2 - 12);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };

  const desktopModalStyle = (offset: { x: number; y: number }) => (
    isMobileLayout ? undefined : { position: "fixed" as const, left: "50%", top: "50%", transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }
  );

  const timingDiffSec = Math.abs(videoDurationSec - transcriptDurationSec);
  const timingValid = videoDurationSec > 0 && transcriptDurationSec > 0;
  const timingMatch = timingValid && (timingDiffSec <= 1.25 || timingDiffSec / Math.max(videoDurationSec, 1) < 0.03);
  const renderStatusLabel = globalRenderStatus.status === "running" ? "Rendering" : globalRenderStatus.status === "done" ? "Finished" : globalRenderStatus.status === "error" ? "Error" : "Idle";
  const syncedRenderPercent = typeof globalRenderStatus.percent === "number"
    ? globalRenderStatus.percent
    : (globalRenderStatus.status === "done" ? 100 : (exportState.status === "running" || exportState.status === "starting" ? 0 : 0));
  const syncedRenderEtaSec = typeof globalRenderStatus.etaSec === "number"
    ? globalRenderStatus.etaSec
    : (approxRenderSeconds ?? null);
  const syncedRenderStatus = globalRenderStatus.status === "running"
    ? "running"
    : globalRenderStatus.status === "done"
      ? "done"
      : globalRenderStatus.status === "error"
        ? "error"
        : exportState.status;

  const phraseMatches = useMemo(() => buildPhraseMatches(tokens), [tokens]);
  const visiblePhraseMatches = useMemo(() => phraseMatches.filter((match) => !ignoredPhrases.has(match.normalizedPhrase)), [phraseMatches, ignoredPhrases]);
  const searchedTokenIds = useMemo(() => (searchPhrase.trim() ? findPhraseTokenIds(tokens, searchPhrase) : []), [tokens, searchPhrase]);
  const highlightedTokenIds = useMemo(() => {
    const ids = new Set<string>();
    if (highlightedPhrase) {
      const match = phraseMatches.find((item) => item.normalizedPhrase === highlightedPhrase);
      for (const id of match?.tokenIds ?? []) ids.add(id);
    }
    for (const id of searchedTokenIds) ids.add(id);
    return ids;
  }, [highlightedPhrase, phraseMatches, searchedTokenIds]);

  const dragSelectedTokenIds = useMemo(() => {
    if (dragStartIndex === null || dragEndIndex === null || tokens.length === 0) return new Set<string>();
    const start = Math.min(dragStartIndex, dragEndIndex);
    const end = Math.max(dragStartIndex, dragEndIndex);
    const ids = new Set<string>();
    for (let i = start; i <= end; i += 1) {
      const tok = tokens[i];
      if (tok) ids.add(tok.id);
    }
    return ids;
  }, [dragStartIndex, dragEndIndex, tokens]);

  async function loadSettingsAndRoots() {
    const response = await fetch("/api/settings");
    if (!response.ok) return;
    const data = await response.json();
    const baseRoots: RootConfig[] = Array.isArray(data.roots) ? data.roots : [];
    const uploadRoot: RootConfig | null = data.uploadDir ? { id: "__upload__", name: "Uploads", path: String(data.uploadDir) } : null;
    const transcriptRoot: RootConfig | null = data.transcriptDir ? { id: "__transcripts__", name: "Transcripts", path: String(data.transcriptDir) } : null;
    const nextRoots: RootConfig[] = uploadRoot ? [...baseRoots, uploadRoot] : baseRoots;
    setRoots(nextRoots);
    setTranscriptPickerRoot(transcriptRoot);
    setSettingsNeedsSetup(Boolean(data.needsSetup));
    setShowSettings(Boolean(data.needsSetup));
    setSettingsRootsDraft(baseRoots.length > 0 ? baseRoots.map((r) => ({ name: r.name, path: r.path })) : [{ name: "Media", path: "" }]);
    setSettingsUploadDir(data.uploadDir ?? "");
    setSettingsExportDir(data.exportDir ?? "");
    setSettingsTranscriptDir(data.transcriptDir ?? "");
    setSettingsProjectsDir(data.projectsDir ?? "");
    setSettingsExportCacheHours(String(data.exportCacheHours ?? 72));
    setExpandedDirs(new Set(nextRoots.map((r) => `${r.id}:.`)));
    await Promise.all(nextRoots.map((r) => loadDir(r.id, ".")));
    await loadSettingsHealth();
  }

  async function loadSettingsHealth() {
    const response = await fetch("/api/settings/health");
    if (!response.ok) return;
    setSettingsHealth(await response.json());
  }

  async function loadDirPicker(pathValue: string) {
    const query = new URLSearchParams({ path: pathValue, hidden: dirPickerShowHidden ? "1" : "0" }).toString();
    const response = await fetch(`/api/system/dirs?${query}`);
    if (!response.ok) {
      if (pathValue !== "/") {
        await loadDirPicker("/");
        return;
      }
      setDirPickerError(await response.text());
      return;
    }
    const data = await response.json();
    setDirPickerPath(String(data.path ?? "/"));
    setDirPickerParent(data.parent ?? null);
    setDirPickerDirs(Array.isArray(data.dirs) ? data.dirs : []);
    setDirPickerError(null);
  }

  async function browseForPath(onPick: (value: string) => void, startPath?: string) {
    setDirPickerOnPick(() => onPick);
    setShowDirPicker(true);
    setDirPickerNewFolderName("");
    await loadDirPicker(startPath && startPath.trim() ? startPath : "/");
  }

  async function createDirInPicker() {
    const name = dirPickerNewFolderName.trim();
    if (!name) return;
    const response = await fetch("/api/system/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPickerPath, name }),
    });
    if (!response.ok) {
      setDirPickerError(await response.text());
      return;
    }
    setDirPickerNewFolderName("");
    await loadDirPicker(dirPickerPath);
  }

  useEffect(() => {
    if (!showDirPicker) return;
    void loadDirPicker(dirPickerPath || "/");
  }, [dirPickerShowHidden]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!showSettings) return;
    let cancelled = false;
    async function checkDraftRoots() {
      const next: Record<number, "ok" | "missing" | "checking"> = {};
      settingsRootsDraft.forEach((_, i) => { next[i] = "checking"; });
      setSettingsDraftRootHealth(next);
      await Promise.all(settingsRootsDraft.map(async (root, i) => {
        const p = root.path.trim();
        if (!p) {
          next[i] = "missing";
          return;
        }
        const query = new URLSearchParams({ path: p, hidden: "1" }).toString();
        const response = await fetch(`/api/system/dirs?${query}`);
        next[i] = response.ok ? "ok" : "missing";
      }));
      if (!cancelled) setSettingsDraftRootHealth({ ...next });
    }
    void checkDraftRoots();
    return () => { cancelled = true; };
  }, [showSettings, settingsRootsDraft]);

  async function loadExportCapabilities() {
    const response = await fetch("/api/export/capabilities");
    if (!response.ok) return;
    const data = await response.json();
    setExportCapabilities(Array.isArray(data.options) ? data.options : []);
  }

  async function clearVideoExportCache() {
    const response = await fetch("/api/export/cache/clear", { method: "POST" });
    if (!response.ok) {
      setSettingsError(await response.text());
      return;
    }
    const data = await response.json();
    setSettingsError(null);
    setUploadStatus(`cleared video cache: ${data.removed ?? 0} files`);
  }

  async function saveSettings() {
    setSettingsError(null);
    const cleaned = settingsRootsDraft
      .map((r) => ({ name: r.name.trim(), path: r.path.trim() }))
      .filter((r) => r.name && r.path);
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roots: cleaned, uploadDir: settingsUploadDir, exportDir: settingsExportDir || undefined, transcriptDir: settingsTranscriptDir || undefined, projectsDir: settingsProjectsDir || undefined, exportCacheHours: Number(settingsExportCacheHours || 72) }),
    });
    if (!response.ok) {
      setSettingsError(await response.text());
      return;
    }
    setShowSettings(false);
    await loadSettingsAndRoots();
  }

  async function loadDir(root: RootName, relDir: string) {
    const dirKey = `${root}:${relDir}`;
    setPickerLoadingDirs((prev) => new Set(prev).add(dirKey));
    setPickerError(null);
    try {
      const result = await fetchDir(root, relDir);
      const nextDirKey = `${root}:${result.relDir}`;
      setPickerEntriesByDir((prev) => ({ ...prev, [nextDirKey]: result.entries }));
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : "Failed to load directory");
    } finally {
      setPickerLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirKey);
        return next;
      });
    }
  }

  async function toggleDir(root: RootName, relPath: string) {
    const key = `${root}:${relPath}`;
    const isOpen = expandedDirs.has(key);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });

    if (!isOpen && !pickerEntriesByDir[key]) await loadDir(root, relPath);
  }

  async function loadTranscript(root: RootName, relPath: string, silent = false) {
    const query = new URLSearchParams({ root, path: relPath }).toString();
    const response = await fetch(`/api/transcript?${query}`);
    if (!response.ok) {
      if (!silent) setToast(`Failed to load transcript: ${await response.text()}`);
      return false;
    }
    const data = await response.json();
    const nextTokens = normalizeTranscript(data);
    if (nextTokens.length === 0) {
      if (!silent) setToast("No valid transcript tokens found in JSON.");
      return false;
    }
    setTokens(nextTokens);
    setTranscriptSource({ root, path: relPath });
    setDeleted(new Set());
    setIgnoredPhrases(new Set());
    setHighlightedPhrase(null);
    setAppliedGapCuts([]);
    return true;
  }

  async function tryAutoLoadTranscript(_root: RootName, fileName: string) {
    if (!transcriptPickerRoot) return;
    const loaded = await loadTranscript(transcriptPickerRoot.id, `${sanitizeBaseName(fileName)}.json`, true);
    if (loaded) {
      setShowTranscriptPrompt(false);
      if (isMobileLayout) setMobileTab("transcript");
    }
  }

  function applyLoadedProjectData(data: any) {
    const deletedIds = Array.isArray(data.deletedTokenIds) ? data.deletedTokenIds.map((v: unknown) => String(v)) : [];
    const gapCuts = Array.isArray(data.appliedGapCuts) ? data.appliedGapCuts : [];
    setDeleted(new Set(deletedIds));
    setAppliedGapCuts(gapCuts);
    if (typeof data.exportName === "string" && data.exportName.trim()) setExportName(data.exportName);
    setCurrentProjectId(typeof data.projectId === "string" ? data.projectId : null);
    setCurrentProjectName(typeof data.projectName === "string" ? data.projectName : "");
  }

  async function loadSavedProject(root: RootName, relPath: string) {
    const query = new URLSearchParams({ root, path: relPath }).toString();
    const response = await fetch(`/api/project/load?${query}`);
    if (!response.ok) return;
    const data = await response.json();
    applyLoadedProjectData(data);
  }

  async function refreshSavedProjects() {
    const response = await fetch("/api/project/list");
    if (!response.ok) return;
    const data = await response.json();
    setSavedProjects(Array.isArray(data.projects) ? data.projects : []);
  }

  async function deleteProjectById(projectId: string) {
    const response = await fetch("/api/project/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!response.ok) {
      setToast(`Delete failed: ${await response.text()}`);
      return;
    }
    setSavedProjects((prev) => prev.filter((p) => p.projectId !== projectId));
    setToast("Project deleted");
  }

  async function loadProjectById(projectId: string) {
    const query = new URLSearchParams({ projectId }).toString();
    const response = await fetch(`/api/project/load?${query}`);
    if (!response.ok) {
      setToast(`Load failed: ${await response.text()}`);
      return;
    }
    const data = await response.json();
    await openFileEntry(String(data.root), String(data.path), { skipPrompt: true, skipAutoTranscript: true });
    if (data.transcriptRoot && data.transcriptPath) {
      await loadTranscript(String(data.transcriptRoot), String(data.transcriptPath), true);
    }
    applyLoadedProjectData(data);
    setShowTranscriptPrompt(false);
    setShowLoadProjectModal(false);
    setToast(`Loaded project: ${data.projectName || "Project"}`);
  }

  async function saveProject(projectNameInput?: string) {
    if (!selectedMedia) return;
    if (!projectNameInput) {
      setProjectNameDraft(currentProjectName || selectedMedia.name.replace(/\.[^.]+$/, ""));
      setShowProjectNameModal(true);
      return;
    }
    const projectName = projectNameInput.trim() || selectedMedia.name.replace(/\.[^.]+$/, "");
    const response = await fetch("/api/project/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: currentProjectId,
        projectName,
        root: selectedMedia.root,
        path: selectedMedia.path,
        exportName,
        transcriptRoot: transcriptSource?.root ?? null,
        transcriptPath: transcriptSource?.path ?? null,
        deletedTokenIds: Array.from(deleted),
        appliedGapCuts,
      }),
    });
    if (!response.ok) {
      setToast(`Save failed: ${await response.text()}`);
      return;
    }
    const data = await response.json();
    setCurrentProjectId(data.projectId ?? null);
    setCurrentProjectName(data.projectName ?? projectName);
    setShowProjectNameModal(false);
    setToast(`Project saved: ${data.projectName ?? projectName}`);
  }

  function clearProject() {
    setSelectedMedia(null);
    setVideoSrc(null);
    setVideoLabel("No Media Loaded");
    setTokens([]);
    setTranscriptSource(null);
    setDeleted(new Set());
    setAppliedGapCuts([]);
    setIgnoredPhrases(new Set());
    setHighlightedPhrase(null);
    setSearchPhrase("");
    setUndoStack([]);
    setCurrentProjectId(null);
    setCurrentProjectName("");
  }

  async function openFileEntry(root: RootName, relPath: string, opts?: { skipPrompt?: boolean; skipAutoTranscript?: boolean }) {
    const entryName = relPath.split("/").filter(Boolean).at(-1) ?? relPath;

    if (entryName.toLowerCase().endsWith(".json")) {
      await loadTranscript(root, relPath);
      return;
    }

    if (isVideoFile(entryName) || isAudioFile(entryName)) {
      const query = new URLSearchParams({ root, path: relPath }).toString();
      setLoadingUiMessage("Loading media…");
      setVideoSrc(`/api/media?${query}`);
      setActiveMediaKind(isAudioFile(entryName) ? "audio" : "video");
      setVideoLabel(`${root}: ${relPath}`);
      setSelectedMedia({ root, path: relPath, name: entryName });
      setExportName(`${entryName.replace(/\.[^.]+$/, "")}-edited`);
      setTranscribe({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
      setExportState({ jobId: null, status: "idle", outputPath: null, error: null, log: [] });
      if (!opts?.skipPrompt) setShowTranscriptPrompt(true);
      if (!opts?.skipAutoTranscript) {
        setLoadingUiMessage("Matching transcript…");
        await tryAutoLoadTranscript(root, entryName);
      }
      setLoadingUiMessage("Restoring project…");
      await loadSavedProject(root, relPath);
      setLoadingUiMessage(null);
      return;
    }

    setToast("Selected file is not a supported media/transcript file.");
  }

  async function openSelectedFile() {
    if (!selectedEntry || selectedEntry.type !== "file") return;
    await openFileEntry(selectedEntry.root, selectedEntry.relPath);
  }

  function beginModalDrag(key: "export" | "render" | "progress" | "settings" | "about" | "dirPicker" | "filePicker" | "transcribe" | "transcriptPrompt" | "search" | "loadProject" | "confirmDelete" | "projectName", event: React.MouseEvent<HTMLDivElement>) {
    if (isMobileLayout) return;
    event.preventDefault();
    const origins: Record<string, { x: number; y: number }> = {
      export: exportModalOffset,
      render: renderModalOffset,
      progress: progressModalOffset,
      settings: settingsModalOffset,
      about: aboutModalOffset,
      dirPicker: dirPickerModalOffset,
      filePicker: filePickerModalOffset,
      transcribe: transcribeModalOffset,
      transcriptPrompt: transcriptPromptModalOffset,
      search: searchModalOffset,
      loadProject: loadProjectModalOffset,
      confirmDelete: confirmDeleteModalOffset,
      projectName: projectNameModalOffset,
    };
    const origin = origins[key] || { x: 0, y: 0 };
    setDraggingModal({ key, startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y });
  }

  function playInAppNotifySound() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const beep = (start: number, freq: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + 0.24);
      };
      beep(0, 880);
      beep(0.22, 1175);
      window.setTimeout(() => { try { ctx.close(); } catch {} }, 900);
    } catch {}
  }

  function triggerInAppRenderNotice(message: string, downloadUrl?: string | null) {
    setInAppNotifyMessage(message);
    setInAppNotifyDownloadUrl(downloadUrl || null);
    setShowInAppNotifyModal(true);
    setFaviconAlert(true);
    playInAppNotifySound();
  }

  function openRenderProgressFromStatus() {
    const isDone = globalRenderStatus.status === "done";
    const downloadUrl = isDone && globalRenderStatus.jobId ? `/api/export/download?jobId=${globalRenderStatus.jobId}` : null;
    const msg = globalRenderStatus.status === "running"
      ? `Render is in progress${typeof globalRenderStatus.etaSec === "number" ? ` · ETA ${formatEta(globalRenderStatus.etaSec)}` : ""}.`
      : globalRenderStatus.status === "done"
        ? `Render finished. ${globalRenderStatus.outputName || "File is ready."}`
        : globalRenderStatus.status === "error"
          ? `Render failed${globalRenderStatus.error ? `: ${globalRenderStatus.error}` : "."}`
          : "No active render.";
    setShowExportProgressModal(true);
    if (globalRenderStatus.jobId) setExportState((prev) => ({ ...prev, jobId: globalRenderStatus.jobId, status: globalRenderStatus.status === "running" ? "running" : prev.status }));
    if (globalRenderStatus.status === "done" || globalRenderStatus.status === "error") triggerInAppRenderNotice(msg, downloadUrl);
  }

  async function startTranscription() {
    if (!selectedMedia) return;
    const presetConfig = sttPreset === "fast"
      ? { model: "tiny", beamSize: 1, vadFilter: true }
      : sttPreset === "quality"
        ? { model: "small", beamSize: 5, vadFilter: false }
        : { model: "base", beamSize: 1, vadFilter: true };
    setShowTranscribeModal(true);
    setTranscribe({ jobId: null, status: "starting", log: [], transcriptRelPath: null, error: null });
    const response = await fetch("/api/transcribe/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, model: presetConfig.model, device: "cpu", computeType: "int8", beamSize: presetConfig.beamSize, vadFilter: presetConfig.vadFilter }),
    });
    if (!response.ok) {
      setTranscribe({ jobId: null, status: "error", log: [], transcriptRelPath: null, error: await response.text() });
      return;
    }
    const data = await response.json();
    setTranscribe((prev) => ({ ...prev, jobId: data.jobId, status: "running" }));
  }

  async function startExport() {
    if (!selectedMedia) return;
    setShowExportProgressModal(true);
    const resPreset = renderResolution === "2160p" ? { width: 3840, height: 2160 }
      : renderResolution === "1440p" ? { width: 2560, height: 1440 }
      : renderResolution === "1080p" ? { width: 1920, height: 1080 }
      : renderResolution === "720p" ? { width: 1280, height: 720 }
      : { width: 0, height: 0 };
    const fpsValue = renderFps === "60" ? 60 : renderFps === "30" ? 30 : renderFps === "24" ? 24 : 0;
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root: selectedMedia.root,
        path: selectedMedia.path,
        outputName: exportName,
        keepRanges: renderKeeps,
        cuts,
        render: {
          container: renderContainer,
          codec: renderCodec,
          fps: fpsValue || undefined,
          width: resPreset.width || undefined,
          height: resPreset.height || undefined,
        },
      }),
    });
    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }
    const data = await response.json();
    setExportState((prev) => ({ ...prev, jobId: data.jobId, status: "running", outputPath: data.outputPath ?? null }));
  }

  async function autoDownload(url: string, fallbackName: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename="?([^";]+)"?/i);
    a.href = objectUrl;
    a.download = m?.[1] || fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function exportResolveFcpxml() {
    if (!selectedMedia) return;
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/fcpxml/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, outputName: exportName, keepRanges: keeps }),
    });
    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }
    const data = await response.json();
    if (data.downloadUrl) await autoDownload(data.downloadUrl, `${exportName || "timeline"}.fcpxml`);
    setExportState((prev) => ({ ...prev, jobId: data.jobId ?? null, status: "done", outputPath: data.outputPath ?? null, error: null, log: data.downloadUrl ? [`Downloaded: ${data.downloadUrl}\n`] : [] }));
  }

  async function exportEdl() {
    if (!selectedMedia) return;
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/edl/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, outputName: exportName, keepRanges: keeps }),
    });
    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }
    const data = await response.json();
    if (data.downloadUrl) await autoDownload(data.downloadUrl, `${exportName || "timeline"}.edl`);
    setExportState((prev) => ({ ...prev, jobId: data.jobId ?? null, status: "done", outputPath: data.outputPath ?? null, error: null, log: data.downloadUrl ? [`Downloaded: ${data.downloadUrl}\n`] : [] }));
  }

  async function exportPremiereTimelineXml() {
    if (!selectedMedia) return;
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/premiere/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, outputName: exportName, keepRanges: keeps }),
    });
    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }
    const data = await response.json();
    if (data.downloadUrl) await autoDownload(data.downloadUrl, `${exportName || "timeline"}.xml`);
    setExportState((prev) => ({ ...prev, jobId: data.jobId ?? null, status: "done", outputPath: data.outputPath ?? null, error: null, log: data.downloadUrl ? [`Downloaded: ${data.downloadUrl}\n`] : [] }));
  }

  async function exportAfterEffectsMarkersJson() {
    if (!selectedMedia) return;
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/after-effects-markers/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, outputName: exportName, keepRanges: keeps }),
    });
    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }
    const data = await response.json();
    if (data.downloadUrl) await autoDownload(data.downloadUrl, `${exportName || "timeline"}-markers.json`);
    setExportState((prev) => ({ ...prev, jobId: data.jobId ?? null, status: "done", outputPath: data.outputPath ?? null, error: null, log: data.downloadUrl ? [`Downloaded: ${data.downloadUrl}\n`] : [] }));
  }

  async function exportAafBridgePackage() {
    if (!selectedMedia) return;
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/aaf/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, outputName: exportName, keepRanges: keeps }),
    });
    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }
    const data = await response.json();
    if (data.downloadUrl) await autoDownload(data.downloadUrl, `${exportName || "timeline"}-aaf-bridge.zip`);
    const limitations = Array.isArray(data.limitations) ? data.limitations : [];
    setExportState((prev) => ({
      ...prev,
      status: data.status === "done" ? "done" : "error",
      outputPath: data.outputPath ?? null,
      error: data.status === "done" ? null : "AAF bridge export failed",
      log: limitations.length ? limitations.map((line: string) => `${line}\n`) : ["AAF bridge package generated.\n"],
    }));
  }

  async function loadLatestTranscript() {
    if (!selectedMedia || !transcriptPickerRoot) return;
    await loadTranscript(transcriptPickerRoot.id, `${sanitizeBaseName(selectedMedia.name)}.json`);
  }

  async function exportScriptTxt() {
    const scriptBody = buildScriptBody(tokens, deleted, scriptIncludeDeleted);
    if (!scriptBody) return setScriptExport({ status: "error", outputPath: null, error: "Script is empty" });

    const sourceMedia = selectedMedia ? `${selectedMedia.root}:${selectedMedia.path}` : "unknown";
    const durationSec = videoDurationSec > 0 ? videoDurationSec : transcriptDurationSec;
    const header = [
      "# Bit Cut Script Export",
      `source_media: ${sourceMedia}`,
      `duration_sec: ${durationSec.toFixed(3)}`,
      `generated_at_utc: ${new Date().toISOString()}`,
      `include_deleted_tokens: ${scriptIncludeDeleted ? "true" : "false"}`,
      "",
    ].join("\n");

    setScriptExport({ status: "working", outputPath: null, error: null });
    const response = await fetch("/api/script/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputName: `${exportName || "edited"}-script`, text: `${header}\n${scriptBody}\n` }),
    });
    if (!response.ok) return setScriptExport({ status: "error", outputPath: null, error: await response.text() });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName || "edited"}-script.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setScriptExport({ status: "done", outputPath: "browser download", error: null });
  }

  async function exportSubtitles(format: "srt" | "vtt") {
    if (tokens.length === 0) {
      setSubtitleExport({ status: "error", outputPath: null, error: "Transcript is empty", format });
      return;
    }

    setSubtitleExport({ status: "working", outputPath: null, error: null, format });
    const response = await fetch("/api/subtitles/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outputName: exportName || selectedMedia?.name || "edited",
        format,
        includeDeleted: subtitleIncludeDeleted,
        deletedTokenIds: Array.from(deleted),
        tokens,
      }),
    });

    if (!response.ok) {
      setSubtitleExport({ status: "error", outputPath: null, error: await response.text(), format });
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName || "edited"}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    setSubtitleExport({ status: "done", outputPath: "browser download", error: null, format });
  }

  async function copyScriptToClipboard() {
    const text = buildScriptBody(tokens, deleted, scriptIncludeDeleted);
    if (!text) {
      setToast("Nothing to copy yet.");
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setToast("Script copied to clipboard.");
        return;
      }
      throw new Error("Clipboard API unavailable");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) {
          setToast("Script copied to clipboard.");
          return;
        }
      } catch {
        // continue to final error toast below
      }
      setToast("Copy failed on this browser. Use Export Script (.txt).");
    }
  }

  useScopedMobileModalTab(showFilePickerModal, mobileTab, setFilePickerModalTab);
  useScopedMobileModalTab(showTranscriptPrompt, mobileTab, setTranscriptPromptTab);
  useScopedMobileModalTab(showTranscribeModal, mobileTab, setTranscribeModalTab);
  useScopedMobileModalTab(showExportModal, mobileTab, setExportModalTab);
  useScopedMobileModalTab(showRenderPanel, mobileTab, setRenderPanelTab);

  const isFullscreenActive = () => {
    const docAny = document as Document & { webkitFullscreenElement?: Element | null };
    return Boolean(document.fullscreenElement || docAny.webkitFullscreenElement);
  };

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

  async function toggleMobileFullscreen() {
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
  }

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
  }, [isMobileLayout]);

  useEffect(() => {
    if (!showGalleryModal) return;
    void loadGallery();
  }, [showGalleryModal, galleryScope, galleryShowAllFiles, gallerySearch, gallerySort]);

  async function deleteFile(root: RootName, relPath: string) {
    const response = await fetch("/api/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, path: relPath }),
    });
    if (!response.ok) {
      setToast(`Delete failed: ${await response.text()}`);
      return;
    }
    setToast("File deleted");
    const parentDir = relPath.split("/").slice(0, -1).join("/") || ".";
    await Promise.all([loadDir(root, "."), loadDir(root, parentDir)]);
    if (selectedEntry?.root === root && selectedEntry.relPath === relPath) setSelectedEntry(null);
  }

  async function loadGallery() {
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const query = new URLSearchParams({
        scope: galleryScope,
        showAll: galleryShowAllFiles ? "1" : "0",
        q: gallerySearch,
        sort: gallerySort,
        limit: "1200",
      }).toString();
      const response = await fetch(`/api/gallery/list?${query}`);
      if (!response.ok) throw new Error(await response.text());
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new Error("Gallery API returned non-JSON response");
      }
      const data = await response.json();
      setGalleryItems(Array.isArray(data.items) ? data.items : []);
      setGallerySelected(new Set());
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : "Failed to load gallery");
    } finally {
      setGalleryLoading(false);
    }
  }

  async function openGalleryItem(item: GalleryItem) {
    await openFileEntry(item.root, item.relPath);
    setShowGalleryModal(false);
    setShowAppMenu(false);
  }

  function downloadGalleryItem(item: GalleryItem) {
    window.open(item.mediaUrl, "_blank");
  }

  async function deleteGalleryItem(item: GalleryItem) {
    await deleteFile(item.root, item.relPath);
    await loadGallery();
  }

  async function deleteSelectedGalleryItems() {
    const selectedItems = galleryItems.filter((item) => gallerySelected.has(item.id));
    if (selectedItems.length === 0) return;
    for (const item of selectedItems) await deleteFile(item.root, item.relPath);
    await loadGallery();
  }

  async function confirmGalleryAction() {
    if (!galleryConfirmAction) return;
    if (galleryConfirmAction.type === "download" && galleryConfirmAction.item) {
      downloadGalleryItem(galleryConfirmAction.item);
    } else if (galleryConfirmAction.type === "delete" && galleryConfirmAction.item) {
      await deleteGalleryItem(galleryConfirmAction.item);
    } else if (galleryConfirmAction.type === "deleteSelected") {
      await deleteSelectedGalleryItems();
    }
    setGalleryConfirmAction(null);
  }

  async function uploadFile(file: File | null) {
    if (!file) return;
    setUploadStatus("uploading");
    setUploadProgress({ active: true, loaded: 0, total: file.size || 0, speedBps: 0, etaSec: null, name: file.name });

    try {
      const data = await new Promise<any>((resolve, reject) => {
        const form = new FormData();
        form.append("file", file);
        const xhr = new XMLHttpRequest();
        const startedAt = Date.now();
        xhr.open("POST", "/api/files/upload");
        xhr.upload.onprogress = (evt) => {
          if (!evt.lengthComputable) return;
          const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
          const speed = evt.loaded / elapsedSec;
          const remaining = Math.max(0, evt.total - evt.loaded);
          const eta = speed > 0 ? remaining / speed : null;
          setUploadProgress({ active: true, loaded: evt.loaded, total: evt.total, speedBps: speed, etaSec: eta, name: file.name });
        };
        xhr.onerror = () => reject(new Error("upload failed"));
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(xhr.responseText || `upload failed (${xhr.status})`));
            return;
          }
          try {
            resolve(JSON.parse(xhr.responseText || "{}"));
          } catch {
            reject(new Error("upload response parse failed"));
          }
        };
        xhr.send(form);
      });

      setUploadProgress((prev) => ({ ...prev, active: false, loaded: prev.total || prev.loaded }));
      const relPath = String(data.relPath || "").trim();
      setUploadStatus(`uploaded: ${data.savedPath ?? (relPath || file.name)}`);
      const uploadRoot = String(data.root ?? roots[0]?.id ?? "");
      const uploadDir = relPath.split("/").slice(0, -1).join("/") || ".";
      await Promise.all(roots.map((r) => loadDir(r.id, ".")));
      if (!uploadRoot || !relPath) {
        setToast("Upload completed, but file path was not returned. Refreshing picker.");
        return;
      }

      await loadDir(uploadRoot, uploadDir);
      setExpandedDirs((prev) => new Set(prev).add(`${uploadRoot}:${uploadDir}`));
      setSelectedEntry({ root: uploadRoot, relPath, type: "file" });

      if (isMobileLayout) {
        if (relPath.toLowerCase().endsWith(".json")) {
          await loadTranscript(uploadRoot, relPath);
          setShowTranscriptPrompt(false);
          setMobileTab("transcript");
        } else {
          // Mobile stability: avoid immediate heavy open/autoload chain right after upload.
          // Keep user in picker context and let them open explicitly.
          setShowFilePickerModal(true);
          setToast("Upload complete. Tap the file to open.");
        }
        return;
      }

      if (relPath.toLowerCase().endsWith(".json")) {
        await loadTranscript(uploadRoot, relPath);
        setShowTranscriptPrompt(false);
      } else {
        await openFileEntry(uploadRoot, relPath);
        setShowTranscriptPrompt(true);
      }
    } catch (error) {
      setUploadProgress((prev) => ({ ...prev, active: false }));
      setUploadStatus(`error: ${error instanceof Error ? error.message : "upload failed"}`);
    } finally {
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (jsonUploadInputRef.current) jsonUploadInputRef.current.value = "";
    }
  }

  function applyDeletedChange(mutator: (next: Set<string>) => void) {
    setDeleted((prev) => {
      setUndoStack((history) => [...history.slice(-39), new Set(prev)]);
      const next = new Set(prev);
      mutator(next);
      return next;
    });
  }

  function undoLastDeleteAction() {
    setUndoStack((history) => {
      const previous = history[history.length - 1];
      if (!previous) return history;
      setDeleted(new Set(previous));
      return history.slice(0, -1);
    });
  }

  function removeSearchedMatches() {
    if (searchedTokenIds.length === 0) return;
    const unique = Array.from(new Set(searchedTokenIds));
    const allDeleted = unique.every((id) => deleted.has(id));
    applyDeletedChange((next) => {
      for (const id of unique) allDeleted ? next.delete(id) : next.add(id);
    });
  }

  function toggle(id: string) {
    applyDeletedChange((next) => {
      next.has(id) ? next.delete(id) : next.add(id);
    });
  }

  function toggleRangeByIndex(a: number, b: number) {
    const start = Math.max(0, Math.min(a, b));
    const end = Math.min(tokens.length - 1, Math.max(a, b));
    if (start > end) return;
    const ids = tokens.slice(start, end + 1).map((t) => t.id);
    const allDeleted = ids.every((id) => deleted.has(id));
    applyDeletedChange((next) => {
      for (const id of ids) allDeleted ? next.delete(id) : next.add(id);
    });
  }

  function getActiveMediaEl() {
    return mobileVideoRef.current ?? mobileAudioRef.current ?? videoRef.current ?? audioRef.current;
  }

  function playFromToken(token: WordToken) {
    const mediaEl = getActiveMediaEl();
    if (!mediaEl) return;
    const seekTarget = Math.max(0, token.startSec + 0.01);
    mediaEl.currentTime = seekTarget;
    setCurrentTimeSec(seekTarget);
    setActiveTokenIndex(tokenAtTime(tokens, seekTarget));
    void mediaEl.play();
  }

  function togglePhraseDeletion(match: PhraseMatch) {
    applyDeletedChange((next) => {
      const uniqueIds = Array.from(new Set(match.tokenIds));
      const allDeleted = uniqueIds.length > 0 && uniqueIds.every((id) => next.has(id));
      for (const id of uniqueIds) allDeleted ? next.delete(id) : next.add(id);
    });
  }

  function ignorePhrase(match: PhraseMatch) {
    setIgnoredPhrases((prev) => new Set(prev).add(match.normalizedPhrase));
    setHighlightedPhrase((prev) => (prev === match.normalizedPhrase ? null : prev));
  }

  function applyCandidate(candidate: AnalysisCandidate) {
    const ids = tokens
      .filter((t) => t.startSec < candidate.endSec && t.endSec > candidate.startSec)
      .map((t) => t.id);
    if (ids.length === 0) return;
    applyDeletedChange((next) => {
      for (const id of ids) next.add(id);
    });
  }

  function applyAllCandidates() {
    if (analysisCandidates.length === 0) return;
    applyDeletedChange((next) => {
      for (const candidate of analysisCandidates) {
        for (const t of tokens) {
          if (t.startSec < candidate.endSec && t.endSec > candidate.startSec) next.add(t.id);
        }
      }
    });
  }

  async function runDetectionAnalysis() {
    if (!selectedMedia || tokens.length === 0) return;
    setAnalysisStatus("running");
    setAnalysisError(null);

    const tokenGaps = tokens.slice(0, -1)
      .map((t, i) => ({ startSec: t.endSec, endSec: tokens[i + 1]!.startSec }))
      .filter((g) => g.endSec > g.startSec && g.endSec - g.startSec >= 0.16 && g.endSec - g.startSec <= 2.2);

    const response = await fetch("/api/analyze/suggest-cuts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root: selectedMedia.root,
        path: selectedMedia.path,
        detectBreaths,
        detectNoiseClicks,
        tokenGaps,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      setAnalysisStatus("error");
      setAnalysisError(err || "Detection failed");
      return;
    }

    const data = await response.json();
    setAnalysisCandidates(Array.isArray(data.candidates) ? data.candidates : []);
    setAnalysisStatus("idle");
  }

  function onVideoTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) {
    const el = event.currentTarget;
    const t = el.currentTime;
    setCurrentTimeSec(t);
    setActiveTokenIndex(tokenAtTime(tokens, t));
    if (!previewCuts || cuts.length === 0) return;
    const hitCut = cuts.find((cut) => t >= cut.startSec && t < cut.endSec);
    if (!hitCut) return;
    const nextKeep = keeps.find((k) => k.sourceStartSec >= hitCut.endSec);
    const seekTarget = nextKeep ? nextKeep.sourceStartSec + 0.01 : hitCut.endSec + 0.01;
    if (seekTarget > t) {
      el.currentTime = seekTarget;
      setCurrentTimeSec(seekTarget);
    }
  }



  function applyGapSuggestions() {
    if (gapSuggestions.length === 0) return;
    const newCuts = gapSuggestions.map((s) => ({ startSec: s.trimStartSec, endSec: s.trimEndSec }));
    setAppliedGapCuts((prev) => mergeTimeRanges([...prev, ...newCuts]));
  }

  function commitDragSelection() {
    if (dragSelectedTokenIds.size < 2) return;
    const ids = Array.from(dragSelectedTokenIds);
    const allDeleted = ids.every((id) => deleted.has(id));
    applyDeletedChange((next) => {
      for (const id of ids) allDeleted ? next.delete(id) : next.add(id);
    });
  }

  function beginTokenDrag(index: number) {
    setIsDraggingTokens(true);
    setDragStartIndex(index);
    setDragEndIndex(index);
  }

  function continueTokenDrag(index: number) {
    if (!isDraggingTokens) return;
    setDragEndIndex(index);
  }

  function endTokenDrag() {
    if (!isDraggingTokens) return;
    const hadRange = dragSelectedTokenIds.size >= 2;
    commitDragSelection();
    if (hadRange) setSuppressNextTokenClick(true);
    setIsDraggingTokens(false);
    setDragStartIndex(null);
    setDragEndIndex(null);
  }

  const visiblePickerRoots = filePickerIntent === "json"
    ? (transcriptPickerRoot ? [transcriptPickerRoot] : [])
    : roots;

  function renderTree(root: RootName, relDir: string, depth = 0): React.ReactNode {
    const key = `${root}:${relDir}`;
    const entries = pickerEntriesByDir[key] ?? [];
    const dirs = entries.filter((e) => e.type === "dir");
    const files = entries.filter((e) => e.type === "file").filter((e) => {
      if (filePickerShowAll) return true;
      if (filePickerIntent === "json") return e.name.toLowerCase().endsWith(".json");
      return isVideoFile(e.name) || isAudioFile(e.name);
    });
    const loading = pickerLoadingDirs.has(key);

    return (
      <ul className="treeList" style={{ marginLeft: depth ? 14 : 0 }}>
        {dirs.map((entry) => {
          const dirKey = `${root}:${entry.relPath}`;
          const open = expandedDirs.has(dirKey);
          return (
            <li key={dirKey}>
              <button className={`treeNode ${selectedEntry?.root === root && selectedEntry?.relPath === entry.relPath && selectedEntry?.type === "dir" ? "active" : ""}`} onClick={() => { setSelectedEntry({ root, relPath: entry.relPath, type: "dir" }); void toggleDir(root, entry.relPath); }}>
                <span aria-hidden>{open ? "▾" : "▸"} 📁</span><span className="treeNodeText">{entry.name}</span>
              </button>
              {open && renderTree(root, entry.relPath, depth + 1)}
            </li>
          );
        })}
        {files.map((entry) => (
          <li key={`${root}:${entry.relPath}`}>
            <div className="row" style={{ marginBottom: 0, alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
              <button
                className={`treeNode ${selectedEntry?.root === root && selectedEntry?.relPath === entry.relPath && selectedEntry?.type === "file" ? "active" : ""}`}
                onClick={() => setSelectedEntry({ root, relPath: entry.relPath, type: "file" })}
                onDoubleClick={() => {
                  setSelectedEntry({ root, relPath: entry.relPath, type: "file" });
                  if (filePickerIntent === "json") {
                    if (!entry.relPath.toLowerCase().endsWith(".json") && !filePickerShowAll) return;
                    void loadTranscript(root, entry.relPath);
                    setShowFilePickerModal(false);
                    setFilePickerFromTranscriptPrompt(false);
                    setShowTranscriptPrompt(false);
                    return;
                  }
                  void openFileEntry(root, entry.relPath);
                  setShowFilePickerModal(false);
                }}
                style={{ flex: 1 }}
              >
                <span aria-hidden>📄</span><span className="treeNodeText">{entry.name}</span>
              </button>
              <button title="Delete file" onClick={() => setConfirmDeleteFile({ root, relPath: entry.relPath })}>🗑</button>
            </div>
          </li>
        ))}
        {loading && <li className="hint">Loading…</li>}
      </ul>
    );
  }

  return (
    <>
    <div className={`page split ${isMobileLayout ? `mobileLayout mobile-${mobileTab}` : ""}`} ref={splitRef} style={isMobileLayout ? undefined : { gridTemplateColumns: `${splitLeftPct}% 8px 1fr` }}>
      {isMobileLayout && (
        <div className="mobilePaneSwitch row">
          <button className={mobileTab === "media" ? "active" : ""} onClick={() => setMobileTab("media")}>Media</button>
          <button className={mobileTab === "transcript" ? "active" : ""} onClick={() => setMobileTab("transcript")} disabled={tokens.length === 0}>Transcript</button>
          <button className={mobileTab === "tools" ? "active" : ""} onClick={() => setMobileTab("tools")}>Tools</button>
          <button className={mobileTab === "render" ? "active" : ""} onClick={() => setMobileTab("render")}>Render</button>
          <div className="appMenuWrap">
            <button className="appMenuBtn" title="Project and settings menu" onClick={() => setShowAppMenu((v) => !v)}>☰</button>
            {showAppMenu && (
              <div className="appMenuDropdown">
                <div className="appMenuIconRow">
                  <button className="themeIconOnlyBtn" title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => { void toggleMobileFullscreen(); setShowAppMenu(false); }} disabled={!isMobileLayout}>{isFullscreen ? "🗗" : "⛶"}</button>
                  <button className="themeIconOnlyBtn" title="Toggle light/dark theme" onClick={() => { setIsLightMode((v) => !v); setShowAppMenu(false); }}>{isLightMode ? "🌙" : "☀️"}</button>
                </div>
                <button title="Open app settings" onClick={() => { setShowSettings(true); void loadSettingsHealth(); setShowAppMenu(false); }}>Settings</button>
                <button title="Save current cut decisions for this media" onClick={() => { void saveProject(); setShowAppMenu(false); }} disabled={!selectedMedia}>Save project</button>
                <button title="Load a previously saved project" onClick={() => { setShowLoadProjectModal(true); void refreshSavedProjects(); setShowAppMenu(false); }}>Load project</button>
                <button title="Open media gallery" onClick={() => { setShowGalleryModal(true); setShowAppMenu(false); }}>Gallery</button>
                <button title="Clear current project and start fresh" onClick={() => { clearProject(); setShowAppMenu(false); }}>Clear project</button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="pane videoPane">
        <div className="mobileMediaSection">
        <div className="videoPaneHeaderRow">
          <img src={pruneLogo} alt="Prune" className={`panelBrandLogo ${isMobileLayout ? "mobile" : "desktop"}`} />
          <div className="videoPaneTitleBlock">
            <h2>Video</h2>
            <div className="hint videoPaneSubheading">{selectedMedia?.name ? selectedMedia.name.replace(/\.[^.]+$/, "") : "No file selected"}</div>
          </div>
          {!isMobileLayout && (
            <details className="renderStatusWidget" open={openLeftPanel === "renderStatus"}>
              <summary onClick={(e) => { e.preventDefault(); setOpenLeftPanel((prev) => (prev === "renderStatus" ? null : "renderStatus")); }}>
                <div className="renderStatusHead">
                  <strong>Render status</strong>
                  <span className="hint">{renderStatusLabel}</span>
                </div>
                <progress className="renderStatusBar" max={100} value={typeof globalRenderStatus.percent === "number" ? globalRenderStatus.percent : globalRenderStatus.status === "done" ? 100 : 0} style={{ width: "100%", height: 8 }} />
              </summary>
              <div className="renderStatusBody">
                {globalRenderStatus.status === "running" ? (
                  <>
                    <div className="hint">{typeof globalRenderStatus.percent === "number" ? `${globalRenderStatus.percent.toFixed(1)}%` : "Working…"}{typeof globalRenderStatus.etaSec === "number" ? ` · ETA ${formatEta(globalRenderStatus.etaSec)}` : ""}</div>
                    <div className="hint">Output: <button className="inlineLinkBtn" onClick={() => openRenderProgressFromStatus()}>{globalRenderStatus.outputName || "rendering"}</button></div>
                  </>
                ) : globalRenderStatus.status === "done" ? (
                  <>
                    <div className="hint">Last output: <button className="inlineLinkBtn" onClick={() => openRenderProgressFromStatus()}>{globalRenderStatus.outputName || "completed render"}</button></div>
                    {typeof globalRenderStatus.expectedDurationSec === "number" && <div className="hint">Length: {globalRenderStatus.expectedDurationSec.toFixed(1)}s</div>}
                  </>
                ) : globalRenderStatus.status === "error" ? (
                  <div className="error">{globalRenderStatus.error || "Render failed"}</div>
                ) : <div className="hint">No active render.</div>}
              </div>
            </details>
          )}
        </div>
        {videoSrc ? (
          activeMediaKind === "video"
            ? <div className="videoFrame16x9"><video ref={videoRef} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} /></div>
            : <audio ref={audioRef} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} style={{ width: "100%", marginBottom: 10 }} />
        ) : (
          <div className="videoPlaceholder">
            <div className="hint" style={{ marginBottom: 12 }}>No Media Loaded — start here</div>
            <div className="row" style={{ justifyContent: "center", marginBottom: 0 }}>
              <button className="onboardingBtn" title="Browse files already on the server" onClick={() => { setFilePickerIntent("media"); setFilePickerFromTranscriptPrompt(false); setShowFilePickerModal(true); }}>Browse Server Files</button>
              <button className="onboardingBtn" title="Upload from this device" onClick={() => uploadInputRef.current?.click()}>Upload from Device</button>
            </div>
          </div>
        )}
        <input ref={uploadInputRef} type="file" accept="video/*,audio/*,.json" style={{ display: "none" }} onChange={(e) => void uploadFile(e.target.files?.[0] ?? null)} />

        <label className="toggleRow"><input type="checkbox" checked={previewCuts} onChange={(e) => setPreviewCuts(e.target.checked)} />Preview Cuts (skip deleted sections during playback)</label>
        </div>

        <details className="collapsedPanel mediaOnlyPanel" open={openLeftPanel === "noise"}>
          <summary onClick={(e) => { e.preventDefault(); setOpenLeftPanel((prev) => (prev === "noise" ? null : "noise")); }}>
            <strong>Suggest-only Detection (v1)</strong>
            <span className="hint">Candidates: {analysisCandidates.length}</span>
          </summary>
          <label className="toggleRow"><input type="checkbox" checked={detectBreaths} onChange={(e) => setDetectBreaths(e.target.checked)} />Detect breaths</label>
          <label className="toggleRow"><input type="checkbox" checked={detectNoiseClicks} onChange={(e) => setDetectNoiseClicks(e.target.checked)} />Detect transient noise clicks</label>
          <div className="row">
            <button onClick={() => void runDetectionAnalysis()} disabled={!selectedMedia || tokens.length === 0 || analysisStatus === "running" || (!detectBreaths && !detectNoiseClicks)}>{analysisStatus === "running" ? "Analyzing…" : "Run detection"}</button>
            <button onClick={() => applyAllCandidates()} disabled={analysisCandidates.length === 0}>Apply all as cuts</button>
          </div>
          {analysisError && <div className="error">{analysisError}</div>}
          <div className="hint">Conservative heuristics to reduce false positives. Suggestions are optional.</div>
          {analysisCandidates.length > 0 && (
            <div className="suggestionsPanel">
              {analysisCandidates.map((candidate) => (
                <div key={candidate.id} className="suggestionItem">
                  <div><strong>{candidate.kind === "breath" ? "Breath" : "Noise click"}</strong> · {candidate.startSec.toFixed(2)}s–{candidate.endSec.toFixed(2)}s · {candidate.confidence}</div>
                  <div className="hint">{candidate.reason}</div>
                  <button onClick={() => applyCandidate(candidate)}>Mark as cut</button>
                </div>
              ))}
            </div>
          )}
        </details>

        <details className="collapsedPanel sttPanel mediaOnlyPanel" open={openLeftPanel === "stt"}>
          <summary onClick={(e) => { e.preventDefault(); setShowSttPresetMenuInline(false); setOpenLeftPanel((prev) => (prev === "stt" ? null : "stt")); }}>
            <strong>Speech-to-text</strong>
            <span className="hint">Status: {transcribe.status}</span>
          </summary>
          <div className="hint">Select a local video/audio file, then run Whisper or load JSON.</div>
          <div className="row">
            <div className="splitBtnWrap">
              <button className="splitBtnMain" onClick={() => void startTranscription()} disabled={!selectedMedia || transcribe.status === "running" || transcribe.status === "starting"}>{transcribe.status === "running" || transcribe.status === "starting" ? "Transcribing…" : `Run Whisper ${sttPreset === "fast" ? "Fast draft" : sttPreset === "balanced" ? "Balanced" : "Quality"}`}</button>
              <button className="splitBtnCaret" title="Choose Whisper preset" onClick={() => setShowSttPresetMenuInline((v) => !v)}>▾</button>
              {showSttPresetMenuInline && (
                <div className="splitBtnMenu">
                  <button onClick={() => { setSttPreset("fast"); setShowSttPresetMenuInline(false); }}>Fast draft (tiny)</button>
                  <button onClick={() => { setSttPreset("balanced"); setShowSttPresetMenuInline(false); }}>Balanced (base)</button>
                  <button onClick={() => { setSttPreset("quality"); setShowSttPresetMenuInline(false); }}>Quality (small)</button>
                </div>
              )}
            </div>
            <button title="Browse server files for transcript JSON" onClick={() => { setFilePickerIntent("json"); setFilePickerFromTranscriptPrompt(false); setShowFilePickerModal(true); if (transcriptPickerRoot) void loadDir(transcriptPickerRoot.id, "."); }}>Browse JSON</button>
            <button title="Upload transcript JSON from this device" onClick={() => jsonUploadInputRef.current?.click()}>Upload JSON</button>
            <input ref={jsonUploadInputRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => void uploadFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="hint">Status: {transcribe.status}{transcribe.phase ? ` (${transcribe.phase})` : ""}{transcribe.error ? ` — ${transcribe.error}` : ""}</div>
          {(transcribe.status === "running" || transcribe.status === "done") && <><progress max={100} value={transcribeProgress.pct} style={{ width: "100%", height: 12 }} /><div className="hint">{transcribeProgress.pct.toFixed(1)}% · {transcribeProgress.progressSec.toFixed(1)}s / {transcribeProgress.duration.toFixed(1)}s{transcribe.status === "running" && ` · ${(transcribeProgress.speedLabel || `${transcribeProgress.speed.toFixed(2)}x realtime`)} · ETA ${formatEta(transcribeProgress.remaining)}`}</div></>}
          {transcribe.transcriptRelPath && <div className="hint">Output: {transcribe.transcriptRelPath}</div>}
          {(transcribe.status === "running" || transcribe.status === "starting") && !showTranscribeModal && (
            <div className="hint" title="Whisper is still running in background">Whisper running in background… {transcribeProgress.pct.toFixed(1)}%{transcribe.log.length ? ` · ${String(transcribe.log[transcribe.log.length - 1]).trim().slice(0, 90)}` : ""}</div>
          )}
        </details>

        {isMobileLayout && (
          <details className="collapsedPanel mediaOnlyPanel" open={openLeftPanel === "renderStatus"}>
            <summary onClick={(e) => { e.preventDefault(); setOpenLeftPanel((prev) => (prev === "renderStatus" ? null : "renderStatus")); }}>
              <strong>Render status</strong>
              <span className="hint">{renderStatusLabel}</span>
            </summary>
            {globalRenderStatus.status === "running" ? (
              <>
                <progress className="renderStatusBar" max={100} value={typeof globalRenderStatus.percent === "number" ? globalRenderStatus.percent : 0} style={{ width: "100%", height: 12 }} />
                <div className="hint">{typeof globalRenderStatus.percent === "number" ? `${globalRenderStatus.percent.toFixed(1)}%` : "Working…"}{typeof globalRenderStatus.etaSec === "number" ? ` · ETA ${formatEta(globalRenderStatus.etaSec)}` : ""}</div>
                <div className="hint">Output: <button className="inlineLinkBtn" onClick={() => openRenderProgressFromStatus()}>{globalRenderStatus.outputName || "rendering"}</button></div>
              </>
            ) : globalRenderStatus.status === "done" ? (
              <>
                <div className="hint">Last output: <button className="inlineLinkBtn" onClick={() => openRenderProgressFromStatus()}>{globalRenderStatus.outputName || "completed render"}</button></div>
                {typeof globalRenderStatus.expectedDurationSec === "number" && <div className="hint">Length: {globalRenderStatus.expectedDurationSec.toFixed(1)}s</div>}
              </>
            ) : globalRenderStatus.status === "error" ? (
              <div className="error">{globalRenderStatus.error || "Render failed"}</div>
            ) : <div className="hint">No active render.</div>}
          </details>
        )}

        <div className="exportButtonWrap mobileExportSection">
          {isMobileLayout ? (
            <div className="mobileExportPanel">
              <div className="hint">Final review and render options.</div>
              <label className="settingsField" style={{ marginBottom: 6 }}>Export file name:
                <input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="Output file name" style={{ minWidth: 220, flex: 1 }} title="Base file name for exports" />
              </label>

              <details className="collapsedPanel" open={mobileRenderSection === "video"}>
                <summary onClick={(e) => { e.preventDefault(); setMobileRenderSection("video"); }}><strong>Render video/audio</strong></summary>
                <div className="hint" style={{ marginBottom: 6 }}><strong>Source details</strong></div>
                <div className="row" style={{ marginBottom: 4 }}><span className="hint">Container:</span><strong>{renderSourceInfo?.container || "—"}</strong></div>
                <div className="row" style={{ marginBottom: 4 }}><span className="hint">Video codec:</span><strong>{renderSourceInfo?.videoCodec || "—"}</strong></div>
                <div className="row" style={{ marginBottom: 4 }}><span className="hint">Resolution:</span><strong>{renderSourceInfo?.width && renderSourceInfo?.height ? `${renderSourceInfo.width}×${renderSourceInfo.height}` : "—"}</strong></div>
                <div className="row" style={{ marginBottom: 4 }}><span className="hint">Framerate:</span><strong>{renderSourceInfo?.fps ? `${Number(renderSourceInfo.fps).toFixed(3)} fps` : "—"}</strong></div>
                <div className="row" style={{ marginBottom: 4 }}><span className="hint">Audio:</span><strong>{renderSourceInfo?.audioCodec || "none"}{renderSourceInfo?.audioChannels ? ` · ${renderSourceInfo.audioChannels}ch` : ""}{renderSourceInfo?.audioSampleRate ? ` · ${renderSourceInfo.audioSampleRate}Hz` : ""}</strong></div>
                <div className="row">
                  <label className="settingsField">File type<select value={renderContainer} onChange={(e) => setRenderContainer(e.target.value as any)}><option value="mp4">MP4</option><option value="mov">MOV</option><option value="webm">WebM</option></select></label>
                  <label className="settingsField">Codec<select value={renderCodec} onChange={(e) => setRenderCodec(e.target.value as any)}><option value="h264">H.264 (default)</option><option value="h265">H.265 / HEVC</option><option value="vp8">VP8</option><option value="vp9">VP9</option><option value="prores">ProRes</option></select></label>
                </div>
                <div className="row">
                  <label className="settingsField">Resolution<select value={renderResolution} onChange={(e) => setRenderResolution(e.target.value)}><option value="source">Source</option><option value="2160p">2160p (4K)</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option></select></label>
                  <label className="settingsField">Framerate<select value={renderFps} onChange={(e) => setRenderFps(e.target.value)}><option value="source">Source</option><option value="60">60 fps</option><option value="30">30 fps</option><option value="24">24 fps</option></select></label>
                </div>
                <div className="row">
                  <button title="Render cut media file" onClick={() => void startExport()} disabled={!selectedMedia || renderKeeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Render Video/Audio</button>
                </div>
              </details>

              <details className="collapsedPanel" open={mobileRenderSection === "editor"}>
                <summary onClick={(e) => { e.preventDefault(); setMobileRenderSection("editor"); }}><strong>Export editor file</strong></summary>
                <div className="row">
                  <button title="Export Resolve-compatible FCPXML timeline" onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Resolve FCPXML</button>
                  <button title="Export CMX3600 EDL timeline" onClick={() => void exportEdl()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>EDL (CMX3600)</button>
                  <button title="Export Premiere-friendly XML timeline" onClick={() => void exportPremiereTimelineXml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Premiere XML</button>
                  <button title="Export AAF bridge package (includes importer script + fallback timelines)" onClick={() => void exportAafBridgePackage()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>AAF bridge package</button>
                </div>
              </details>

              <details className="collapsedPanel" open={mobileRenderSection === "subs"}>
                <summary onClick={(e) => { e.preventDefault(); setMobileRenderSection("subs"); }}><strong>Export subtitles</strong></summary>
                <div className="row">
                  <button onClick={() => void exportSubtitles("srt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .srt</button>
                  <button onClick={() => void exportSubtitles("vtt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .vtt</button>
                </div>
              </details>

              <details className="collapsedPanel" open={mobileRenderSection === "script"}>
                <summary onClick={(e) => { e.preventDefault(); setMobileRenderSection("script"); }}><strong>Export script</strong></summary>
                <div className="row">
                  <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>Export Script (.txt)</button>
                  <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
                  <button title="Export JSON markers for After Effects scripting workflows" onClick={() => void exportAfterEffectsMarkersJson()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>AE markers (JSON)</button>
                </div>
              </details>

              <div className="hint">Export status: {exportState.status}{exportState.error ? ` — ${exportState.error}` : ""}</div>
              {exportState.outputPath && <div className="hint">Output path: {exportState.outputPath}</div>}
            </div>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 0 }}>
                <button title="Toggle light/dark theme" onClick={() => setIsLightMode((v) => !v)}>{isLightMode ? "🌙" : "☀️"}</button>
                <button title="Open app settings" onClick={() => { setShowSettings(true); void loadSettingsHealth(); }}>Settings</button>
                <button title="Save current cut decisions for this media" onClick={() => void saveProject()} disabled={!selectedMedia}>Save project</button>
                <button title="Load a previously saved project" onClick={() => { setShowLoadProjectModal(true); void refreshSavedProjects(); }}>Load project</button>
                <button title="Open media gallery" onClick={() => setShowGalleryModal(true)}>Gallery</button>
                <button title="Clear current project and start fresh" onClick={() => clearProject()}>Clear project</button>
              </div>

              <button className="exportBigButton" title="Review final cut preview and render options" onClick={() => setShowExportModal(true)}>Render</button>
            </>
          )}
        </div>
      </div>

      <div className={`splitHandle ${isResizing ? "active" : ""}`} onMouseDown={() => setIsResizing(true)} role="separator" aria-orientation="vertical" />

      <div className="pane transcriptPane">
        <div className="mobileTranscriptSection">
        {isMobileLayout && videoSrc && (
          <div className="mobileInlinePlayer">
            {activeMediaKind === "video"
              ? <div className="videoFrame16x9"><video ref={mobileVideoRef} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} /></div>
              : <audio ref={mobileAudioRef} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} style={{ width: "100%", marginBottom: 10 }} />}
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div className="row" style={{ marginBottom: 0, alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>Transcript</h2>
            <button title="Show/hide transcript tips" onClick={() => setShowTranscriptTips((v) => !v)}>ℹ️</button>
          </div>
          <div className="row" style={{ marginBottom: 0 }}>
            <button onClick={() => setShowTranscriptSearchModal(true)}>Search</button>
            <button title="Toggle range select mode" className={rangeSelectMode ? "active" : ""} onClick={() => { setRangeSelectMode((v) => !v); setRangeSelectAnchor(null); }}>Range</button>
            <button title="Undo last transcript removal action" onClick={() => undoLastDeleteAction()} disabled={undoStack.length === 0}>Undo</button>
          </div>
        </div>
        {showTranscriptTips && <div className="hint">Multi-select: desktop = click and drag across words, then release. Mobile = tap Range, tap first word (anchor), tap last word to apply span. Double-click a word to play from it.</div>}

        {tokens.length === 0 ? (
          <div className="transcriptParagraph" style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
            <div>
              <div className="hint" style={{ marginBottom: 8 }}>No transcript loaded yet.</div>
              <div className="row" style={{ justifyContent: "center", marginBottom: 0 }}>
                <button title="Browse server files for transcript JSON" onClick={() => { setFilePickerIntent("json"); setFilePickerShowAll(false); setFilePickerFromTranscriptPrompt(false); setShowFilePickerModal(true); if (transcriptPickerRoot) void loadDir(transcriptPickerRoot.id, "."); }}>Browse JSON</button>
                <button title="Upload transcript JSON from this device" onClick={() => jsonUploadInputRef.current?.click()}>Upload JSON</button>
              </div>
            </div>
          </div>
        ) : (
          <p className="transcriptParagraph">
            {tokens.map((t, index) => {
              const className = ["tokenInline", deleted.has(t.id) ? "deleted" : "", index === activeTokenIndex ? "active" : "", highlightedTokenIds.has(t.id) ? "highlighted" : "", isDraggingTokens && dragSelectedTokenIds.has(t.id) ? "dragSelected" : ""].filter(Boolean).join(" ");
              return <span key={t.id}><button data-token-index={index} onMouseDown={() => beginTokenDrag(index)} onMouseEnter={() => continueTokenDrag(index)} onMouseUp={() => endTokenDrag()} onClick={() => { if (suppressNextTokenClick) { setSuppressNextTokenClick(false); return; } if (rangeSelectMode) { if (rangeSelectAnchor === null) { setRangeSelectAnchor(index); setToast(`Range anchor set at word ${index + 1}`); } else { toggleRangeByIndex(rangeSelectAnchor, index); setRangeSelectAnchor(null); } return; } toggle(t.id); }} onDoubleClick={() => playFromToken(t)} className={className} title={`${t.startSec.toFixed(2)}s - ${t.endSec.toFixed(2)}s (double-click to play from here)`}>{t.text}</button>{" "}</span>;
            })}
          </p>
        )}
        </div>

        <div className="toolsStack mobileTranscriptToolsSection">
          <details className="collapsedPanel" open={openToolPanel === "smart"}>
            <summary onClick={(e) => { e.preventDefault(); setOpenToolPanel((prev) => (prev === "smart" ? null : "smart")); }}>
              <strong>Smart Cleanup</strong>
              <span className="hint">Phrases found: {visiblePhraseMatches.length}</span>
            </summary>
            <aside className="cleanupPanel">
              <div className="hint">Fixed filler words & phrases matched from transcript.</div>
              {visiblePhraseMatches.length === 0 ? <div className="hint">No cleanup phrases found.</div> : (
                <ul className="cleanupList">
                  {visiblePhraseMatches.map((match) => {
                    const uniqueIds = Array.from(new Set(match.tokenIds));
                    const allDeleted = uniqueIds.length > 0 && uniqueIds.every((id) => deleted.has(id));
                    const isHighlighted = highlightedPhrase === match.normalizedPhrase;
                    return (
                      <li key={match.normalizedPhrase} className="cleanupItem">
                        <div className="cleanupTitle"><span>“{match.phrase}”</span><span className="count">×{match.count}</span></div>
                        <div className="cleanupActions">
                          <button onClick={() => setHighlightedPhrase((prev) => (prev === match.normalizedPhrase ? null : match.normalizedPhrase))}>{isHighlighted ? "Clear highlight" : "Highlight matches"}</button>
                          <button onClick={() => togglePhraseDeletion(match)}>{allDeleted ? "Restore all matches" : "Remove all matches"}</button>
                          <button onClick={() => ignorePhrase(match)}>Ignore phrase</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
          </details>

          <details className="collapsedPanel gapPanel" open={openToolPanel === "gap"}>
            <summary onClick={(e) => { e.preventDefault(); setOpenToolPanel((prev) => (prev === "gap" ? null : "gap")); }}>
              <strong>Word-gap shortener</strong>
              <span className="hint">Suggestions {gapSuggestions.length} · Applied trims {appliedGapCuts.length}</span>
            </summary>
            <aside className="cleanupPanel">
              <label className="toggleRow"><input type="checkbox" checked={gapShortenerEnabled} onChange={(e) => setGapShortenerEnabled(e.target.checked)} />Enable applied gap trims in cut plan</label>
              <div className="row">
                <label className="hint">Min gap (sec)<br /><input type="number" min={0} step={0.05} value={gapMinThresholdSec} onChange={(e) => setGapMinThresholdSec(Math.max(0, Number(e.target.value) || 0))} style={{ width: 120 }} /></label>
                <label className="hint">Leave behind (sec)<br /><input type="number" min={0} step={0.05} value={gapLeaveBehindSec} onChange={(e) => setGapLeaveBehindSec(Math.max(0, Number(e.target.value) || 0))} style={{ width: 120 }} /></label>
              </div>
              <div className="hint">Preview suggestions: {gapSuggestions.length}</div>
              <div className="row">
                <button onClick={applyGapSuggestions} disabled={gapSuggestions.length === 0}>Apply suggested gap trims</button>
                <button onClick={() => setAppliedGapCuts([])} disabled={appliedGapCuts.length === 0}>Clear applied gap trims</button>
              </div>
              <ul className="cleanupList">
                {gapSuggestions.length === 0 ? <li className="hint">No gaps above threshold.</li> : gapSuggestions.slice(0, 100).map((gap) => (
                  <li key={gap.id} className="cleanupItem">
                    <div className="cleanupTitle"><span>{gap.startSec.toFixed(2)}s → {gap.endSec.toFixed(2)}s</span><span className="count">gap {gap.gapSec.toFixed(2)}s</span></div>
                    <div className="hint">Trim: {gap.trimStartSec.toFixed(2)}s → {gap.trimEndSec.toFixed(2)}s ({gap.trimSec.toFixed(2)}s)</div>
                  </li>
                ))}
              </ul>
            </aside>
          </details>

          <details className="collapsedPanel" open={openToolPanel === "summary"}>
            <summary onClick={(e) => { e.preventDefault(); setOpenToolPanel((prev) => (prev === "summary" ? null : "summary")); }}>
              <strong>Cut/keep summary</strong>
              <span className="hint">Tokens {tokens.length} · Deleted {deleted.size}</span>
            </summary>
            <ul>
              <li>Tokens: {tokens.length}</li>
              <li>Deleted tokens: {deleted.size}</li>
              <li>Gap trims applied: {appliedGapCuts.length} ({appliedGapCuts.reduce((sum, c) => sum + (c.endSec - c.startSec), 0).toFixed(2)}s){gapShortenerEnabled ? "" : " (disabled)"}</li>
              <li>Cut ranges: {cuts.length} ({totalCutSec.toFixed(2)}s)</li>
              <li>Keep ranges: {keeps.length} ({totalKeepSec.toFixed(2)}s)</li>
            </ul>
            <details>
              <summary>Raw cut/keep JSON debug</summary>
              <h4>Computed cut ranges</h4>
              <pre>{JSON.stringify(cuts, null, 2)}</pre>
              <h4>Computed keep ranges</h4>
              <pre>{JSON.stringify(keeps, null, 2)}</pre>
            </details>
          </details>
        </div>

      </div>
    </div>
    {uploadProgress.active && (
      <div className="settingsOverlay" style={{ zIndex: 1006 }}>
        <div className="settingsModal" style={{ maxWidth: 460, textAlign: "center" }}>
          <div className="spinner" />
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Uploading {uploadProgress.name}</div>
          <progress max={Math.max(1, uploadProgress.total)} value={uploadProgress.loaded} style={{ width: "100%", height: 12 }} />
          <div className="hint" style={{ marginTop: 8 }}>
            {uploadProgress.total > 0 ? `${((uploadProgress.loaded / uploadProgress.total) * 100).toFixed(1)}%` : "Working…"}
            {` · ${formatBytes(uploadProgress.loaded)} / ${formatBytes(uploadProgress.total)}`}
            {` · ${formatBytes(uploadProgress.speedBps)}/s`}
            {` · ETA ${uploadProgress.etaSec !== null ? formatEta(uploadProgress.etaSec) : "--"}`}
          </div>
        </div>
      </div>
    )}
    {loadingUiMessage && (
      <div className="settingsOverlay" style={{ zIndex: 1005 }}>
        <div className="settingsModal" style={{ maxWidth: 420, textAlign: "center" }}>
          <div className="spinner" />
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{loadingUiMessage}</div>
          <div className="hint">Please wait…</div>
        </div>
      </div>
    )}
    {showGalleryModal && (
      <div className="settingsOverlay" onClick={() => setShowGalleryModal(false)}>
        <div className="settingsModal galleryModal" style={{ maxWidth: 1100, width: "min(1100px, 96vw)", maxHeight: "88vh" }} onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Gallery</h3>
            <button title="Close" onClick={() => setShowGalleryModal(false)}>✕</button>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <label className="settingsField">Source
              <select className="galleryControl" value={galleryScope} onChange={(e) => setGalleryScope(e.target.value as any)}>
                <option value="originals">Originals</option>
                <option value="exports">Exports</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label className="settingsField">Sort
              <select className="galleryControl" value={gallerySort} onChange={(e) => setGallerySort(e.target.value)}>
                <option value="date_desc">Newest first</option>
                <option value="date_asc">Oldest first</option>
                <option value="name_asc">Name A → Z</option>
                <option value="name_desc">Name Z → A</option>
                <option value="duration_desc">Longest first</option>
                <option value="duration_asc">Shortest first</option>
                <option value="size_desc">Largest first</option>
                <option value="size_asc">Smallest first</option>
              </select>
            </label>
            <label className="settingsField" style={{ flex: "1 1 260px" }}>Search
              <input className="galleryControl" value={gallerySearch} onChange={(e) => setGallerySearch(e.target.value)} placeholder="Search filename" />
            </label>
            <button className="galleryRefreshBtn" onClick={() => void loadGallery()} disabled={galleryLoading}>Refresh</button>
          </div>

          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <div className="hint">{galleryLoading ? "Loading…" : `${galleryItems.length} item${galleryItems.length === 1 ? "" : "s"}`}</div>
            <div className="row" style={{ gap: 6 }}>
              <button onClick={() => setGallerySelected(new Set(galleryItems.map((i) => i.id)))} disabled={galleryItems.length === 0}>Select all</button>
              <button onClick={() => setGallerySelected(new Set())} disabled={gallerySelected.size === 0}>Clear</button>
              <button className="galleryDeleteBtn" onClick={() => setGalleryConfirmAction({ type: "deleteSelected" })} disabled={gallerySelected.size === 0}>🗑 Delete selected</button>
            </div>
          </div>

          {galleryError && <div className="error" style={{ marginBottom: 8 }}>{galleryError}</div>}

          <label className="toggleRow galleryShowAllRow"><input type="checkbox" checked={galleryShowAllFiles} onChange={(e) => setGalleryShowAllFiles(e.target.checked)} />Show all files</label>

          <div className="galleryGrid">
            {galleryItems.map((item) => (
              <div key={item.id} className="galleryCard">
                <div className="galleryCardTopRow">
                  <div className="galleryCardRightControls">
                    <span className="galleryKindTag">{item.kind === "export" ? "Export" : "Original"}</span>
                    <input type="checkbox" checked={gallerySelected.has(item.id)} onChange={(e) => setGallerySelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })} />
                  </div>
                </div>
                <div className="galleryThumb">
                  {item.isVideo ? (
                    <img src={item.thumbUrl || item.mediaUrl} alt={item.name} loading="lazy" />
                  ) : item.isAudio ? (
                    <div className="hint">Audio</div>
                  ) : (
                    <div className="hint">File</div>
                  )}
                </div>
                <div className="cleanupTitle galleryTitleScroll" style={{ marginTop: 6 }}><span>{item.name}</span></div>
                <div className="hint">{new Date(item.modifiedAt).toLocaleString()}</div>
                <div className="hint">{formatDurationShort(item.durationSec)} · {formatBytes(item.sizeBytes)}</div>
                <div className="row galleryActionsRow" style={{ gap: 6, marginTop: 6 }}>
                  <button onClick={() => void openGalleryItem(item)}>Open</button>
                  <div className="galleryActionsRight">
                    <button className="galleryIconBtn" title="Download" aria-label="Download" onClick={() => setGalleryConfirmAction({ type: "download", item })}><img className="galleryActionIcon" src="/icons/download.svg" alt="" /></button>
                    <button className="galleryIconBtn galleryDeleteBtn" title="Delete" aria-label="Delete" onClick={() => setGalleryConfirmAction({ type: "delete", item })}><img className="galleryActionIcon" src="/icons/trash.svg" alt="" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}

    {galleryConfirmAction && (
      <div className="settingsOverlay" onClick={() => setGalleryConfirmAction(null)}>
        <div className="settingsModal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>{galleryConfirmAction.type === "download" ? "Confirm download" : "Confirm action"}</h3>
            <button onClick={() => setGalleryConfirmAction(null)}>✕</button>
          </div>
          <div className="hint" style={{ marginTop: 8, marginBottom: 12 }}>
            {galleryConfirmAction.type === "download"
              ? `Download ${galleryConfirmAction.item?.name || "this file"}?`
              : galleryConfirmAction.type === "delete"
                ? `Delete ${galleryConfirmAction.item?.name || "this file"}? This cannot be undone.`
                : `Delete ${gallerySelected.size} selected file(s)? This cannot be undone.`}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setGalleryConfirmAction(null)}>Cancel</button>
            <button className={galleryConfirmAction.type === "download" ? "" : "galleryDeleteBtn"} onClick={() => void confirmGalleryAction()}>
              {galleryConfirmAction.type === "download" ? "Download" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    )}

    {showTranscriptSearchModal && (
      <div className="settingsOverlay" onClick={() => setShowTranscriptSearchModal(false)}>
        <div ref={searchModalRef} className="settingsModal" style={{ maxWidth: 620, ...desktopModalStyle(searchModalOffset) }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("search", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Search transcript</h3>
            <button title="Close" onClick={() => setShowTranscriptSearchModal(false)}>✕</button>
          </div>
          <div className="row transcriptSearchRow">
            <input value={searchPhrase} onChange={(e) => setSearchPhrase(e.target.value)} placeholder="Search phrase in transcript" style={{ minWidth: 260, flex: 1 }} />
            <div className="hint">Matches: {Math.floor(searchedTokenIds.length / Math.max(1, normalizeText(searchPhrase).split(" ").filter(Boolean).length || 1))}</div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button onClick={() => setSearchPhrase("")} disabled={!searchPhrase}>Clear</button>
            <button onClick={() => removeSearchedMatches()} disabled={searchedTokenIds.length === 0}>Toggle remove matches</button>
          </div>
        </div>
      </div>
    )}

    {showFilePickerModal && (!isMobileLayout || mobileTab === filePickerModalTab) && (
      <div className="settingsOverlay" onClick={() => { setShowFilePickerModal(false); setFilePickerFromTranscriptPrompt(false); }}>
        <div ref={filePickerModalRef} className="settingsModal" style={desktopModalStyle(filePickerModalOffset)} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("filePicker", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>{filePickerIntent === "json" ? "Select transcript JSON" : "Select media file"}</h3>
            <button title="Close" onClick={() => { setShowFilePickerModal(false); setFilePickerFromTranscriptPrompt(false); }}>✕</button>
          </div>
          <div className="row">
            {filePickerFromTranscriptPrompt && <button onClick={() => { setShowFilePickerModal(false); setFilePickerFromTranscriptPrompt(false); setShowTranscriptPrompt(true); }}>Back</button>}
            <button onClick={() => void Promise.all(visiblePickerRoots.map((r) => loadDir(r.id, ".")))} title="Refresh all configured file lists">Refresh files</button>
            <button
              onClick={() => {
                if (!selectedEntry || selectedEntry.type !== "file") return;
                if (filePickerIntent === "json") {
                  if (!selectedEntry.relPath.toLowerCase().endsWith(".json") && !filePickerShowAll) return;
                  void loadTranscript(selectedEntry.root, selectedEntry.relPath);
                  setShowFilePickerModal(false);
                  setFilePickerFromTranscriptPrompt(false);
                  setShowTranscriptPrompt(false);
                  return;
                }
                void openSelectedFile();
                setShowFilePickerModal(false);
              }}
              disabled={!selectedEntry || selectedEntry.type !== "file"}
              title={filePickerIntent === "json" ? "Load selected JSON transcript" : "Open selected media/transcript file"}
            >Open selected file</button>
            <label className="toggleRow" style={{ margin: 0 }} title="Show all files, not only expected type"><input type="checkbox" checked={filePickerShowAll} onChange={(e) => setFilePickerShowAll(e.target.checked)} />Show all files</label>
          </div>
          <div className="path">Selected: {selectedEntry ? `${selectedEntry.root}:/${selectedEntry.relPath === "." ? "" : selectedEntry.relPath}` : "none"}</div>
          <div className="treeRootWrap" style={{ maxHeight: 420 }}>
            <button className="treeCogBtn" title="Configure storage roots" onClick={() => { setShowSettings(true); void loadSettingsHealth(); }}>⚙️</button>
            {visiblePickerRoots.length === 0 ? <div className="hint">No folders configured for this picker. Open Settings.</div> : visiblePickerRoots.map((root) => (
              <div key={root.id}>
                <div className="treeRootHeader">📁 {root.name}</div>
                {renderTree(root.id, ".")}
              </div>
            ))}
          </div>
          {pickerError && <div className="error">{pickerError}</div>}
          {uploadStatus !== "idle" && <div className="hint">Upload: {uploadStatus}</div>}
        </div>
      </div>
    )}

    {showTranscriptPrompt && selectedMedia && (!isMobileLayout || mobileTab === transcriptPromptTab) && (
      <div className="settingsOverlay" onClick={() => { setShowTranscriptPrompt(false); setShowSttPresetMenu(false); }}>
        <div ref={transcriptPromptModalRef} className="settingsModal transcriptSetupModal" style={desktopModalStyle(transcriptPromptModalOffset)} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("transcriptPrompt", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Transcript setup</h3>
            <button title="Close" onClick={() => { setShowTranscriptPrompt(false); setShowSttPresetMenu(false); }}>✕</button>
          </div>
          <div className="hint">Choose how you want to attach a transcript for {selectedMedia.name}.</div>
          <div className="row">
            <div className="splitBtnWrap">
              <button className="splitBtnMain" title="Run Whisper transcription on selected media" onClick={() => { void startTranscription(); setShowTranscriptPrompt(false); setShowSttPresetMenu(false); }}>Run Whisper {sttPreset === "fast" ? "Fast draft" : sttPreset === "balanced" ? "Balanced" : "Quality"}</button>
              <button className="splitBtnCaret" title="Choose Whisper preset" onClick={() => setShowSttPresetMenu((v) => !v)}>▾</button>
              {showSttPresetMenu && (
                <div className="splitBtnMenu">
                  <button onClick={() => { setSttPreset("fast"); setShowSttPresetMenu(false); }}>Fast draft (tiny)</button>
                  <button onClick={() => { setSttPreset("balanced"); setShowSttPresetMenu(false); }}>Balanced (base)</button>
                  <button onClick={() => { setSttPreset("quality"); setShowSttPresetMenu(false); }}>Quality (small)</button>
                </div>
              )}
            </div>
            <button title="Pick an existing JSON transcript file" onClick={() => { setFilePickerIntent("json"); setFilePickerShowAll(false); setFilePickerFromTranscriptPrompt(true); setShowTranscriptPrompt(false); setShowFilePickerModal(true); setShowSttPresetMenu(false); if (transcriptPickerRoot) void loadDir(transcriptPickerRoot.id, "."); }}>Use JSON transcript…</button>
            <button onClick={() => { setShowTranscriptPrompt(false); setShowSttPresetMenu(false); }}>Skip for now</button>
          </div>
        </div>
      </div>
    )}

    {showTranscribeModal && (transcribe.status === "running" || transcribe.status === "starting") && (!isMobileLayout || mobileTab === transcribeModalTab) && (
      <div className="settingsOverlay" onClick={() => setShowTranscribeModal(false)}>
        <div ref={transcribeModalRef} className="settingsModal" style={desktopModalStyle(transcribeModalOffset)} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("transcribe", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Whisper transcription in progress</h3>
            <button title="Close" onClick={() => setShowTranscribeModal(false)}>✕</button>
          </div>
          <progress max={100} value={transcribeProgress.pct} style={{ width: "100%", height: 12 }} />
          <div className="hint">{transcribeProgress.pct.toFixed(1)}% · {transcribeProgress.progressSec.toFixed(1)}s / {transcribeProgress.duration.toFixed(1)}s</div>
          <div className="row">
            <button onClick={() => setShowTranscribeModal(false)}>Hide (keep running)</button>
          </div>
        </div>
      </div>
    )}

    {showRenderPanel && (!isMobileLayout || mobileTab === renderPanelTab) && (
      <div className="settingsOverlay" onClick={() => setShowRenderPanel(false)}>
        <div ref={renderModalRef} className="settingsModal" style={{ maxWidth: 760, ...(isMobileLayout ? {} : { position: "fixed", left: "50%", top: "50%", transform: `translate(-50%, -50%) translate(${renderModalOffset.x}px, ${renderModalOffset.y}px)` }) }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("render", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Render settings</h3>
            <button title="Close" onClick={() => setShowRenderPanel(false)}>✕</button>
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {!isMobileLayout && (
              <div style={{ flex: 1, minWidth: 260 }}>
                {videoSrc && (activeMediaKind === "video" ? <div className="videoFrame16x9" style={{ marginBottom: 8 }}><video controls src={videoSrc} /></div> : <audio controls src={videoSrc} style={{ width: "100%", marginBottom: 10 }} />)}
                <div className="hint">Source preview</div>
              </div>
            )}
            <div style={{ flex: 1, minWidth: 260 }}>
              <div className="hint" style={{ marginBottom: 6 }}><strong>Source media details</strong></div>
              <div className="row" style={{ marginBottom: 4 }}><span className="hint">Container:</span><strong>{renderSourceInfo?.container || "—"}</strong></div>
              <div className="row" style={{ marginBottom: 4 }}><span className="hint">Video codec:</span><strong>{renderSourceInfo?.videoCodec || "—"}</strong></div>
              <div className="row" style={{ marginBottom: 4 }}><span className="hint">Resolution:</span><strong>{renderSourceInfo?.width && renderSourceInfo?.height ? `${renderSourceInfo.width}×${renderSourceInfo.height}` : "—"}</strong></div>
              <div className="row" style={{ marginBottom: 4 }}><span className="hint">Framerate:</span><strong>{renderSourceInfo?.fps ? `${Number(renderSourceInfo.fps).toFixed(3)} fps` : "—"}</strong></div>
              <div className="row" style={{ marginBottom: 4 }}><span className="hint">Audio:</span><strong>{renderSourceInfo?.audioCodec || "none"}{renderSourceInfo?.audioChannels ? ` · ${renderSourceInfo.audioChannels}ch` : ""}{renderSourceInfo?.audioSampleRate ? ` · ${renderSourceInfo.audioSampleRate}Hz` : ""}</strong></div>
              <div className="row" style={{ marginBottom: 0 }}><span className="hint">Duration:</span><strong>{renderSourceInfo?.durationSec ? `${Number(renderSourceInfo.durationSec).toFixed(2)}s` : "—"}</strong></div>
            </div>
          </div>
          <div className="row">
            <label className="settingsField">File type<select value={renderContainer} onChange={(e) => setRenderContainer(e.target.value as any)}><option value="mp4">MP4</option><option value="mov">MOV</option><option value="webm">WebM</option></select></label>
            <label className="settingsField">Codec<select value={renderCodec} onChange={(e) => setRenderCodec(e.target.value as any)}><option value="h264">H.264 (default)</option><option value="h265">H.265 / HEVC</option><option value="vp8">VP8</option><option value="vp9">VP9</option><option value="prores">ProRes</option></select></label>
          </div>
          <div className="row">
            <label className="settingsField">Resolution<select value={renderResolution} onChange={(e) => setRenderResolution(e.target.value)}><option value="source">Source</option><option value="2160p">2160p (4K)</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option></select></label>
            <label className="settingsField">Framerate<select value={renderFps} onChange={(e) => setRenderFps(e.target.value)}><option value="source">Source</option><option value="60">60 fps</option><option value="30">30 fps</option><option value="24">24 fps</option></select></label>
          </div>
          <div className="hint">These mirror common ffmpeg render options. H.264 + MP4 is the safest default.</div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button onClick={() => setShowRenderPanel(false)}>Cancel</button>
            <button className="saveSettingsBtn" onClick={() => { setShowRenderPanel(false); void startExport(); }}>Start Render</button>
          </div>
        </div>
      </div>
    )}

    {showExportModal && !showRenderPanel && (!isMobileLayout || mobileTab === exportModalTab) && (
      <div className="settingsOverlay" onClick={() => setShowExportModal(false)}>
        <div ref={exportModalRef} className="settingsModal" style={isMobileLayout ? undefined : { position: "fixed", left: "50%", top: "50%", transform: `translate(-50%, -50%) translate(${exportModalOffset.x}px, ${exportModalOffset.y}px)` }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("export", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Render</h3>
            <button title="Close" onClick={() => setShowExportModal(false)}>✕</button>
          </div>
          <div className="hint">Final review and render options.</div>
          {!isMobileLayout && videoSrc && (activeMediaKind === "video"
            ? <video ref={(el) => { exportPreviewRef.current = el; }} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} />
            : <audio ref={(el) => { exportPreviewRef.current = el; }} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} style={{ width: "100%", marginBottom: 10 }} />)}

          <label className="settingsField" style={{ width: "100%", marginBottom: 8 }}>Export file name
            <input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="Output file name" title="Base file name for exports" style={{ width: "100%" }} />
          </label>

          {!isMobileLayout && (
            <>
              <details className="collapsedPanel" open={desktopRenderSection === "video"}>
                <summary onClick={(e) => { e.preventDefault(); setDesktopRenderSection("video"); }}><strong>Video Export</strong></summary>
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="settingsField">File type<select value={renderContainer} onChange={(e) => setRenderContainer(e.target.value as any)}><option value="mp4">MP4</option><option value="mov">MOV</option><option value="webm">WebM</option></select></label>
                  <label className="settingsField">Codec<select value={renderCodec} onChange={(e) => setRenderCodec(e.target.value as any)}><option value="h264">H.264 (default)</option><option value="h265">H.265 / HEVC</option><option value="vp8">VP8</option><option value="vp9">VP9</option><option value="prores">ProRes</option></select></label>
                </div>
                <div className="row">
                  <label className="settingsField">Resolution<select value={renderResolution} onChange={(e) => setRenderResolution(e.target.value)}><option value="source">Source</option><option value="2160p">2160p (4K)</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option></select></label>
                  <label className="settingsField">Framerate<select value={renderFps} onChange={(e) => setRenderFps(e.target.value)}><option value="source">Source</option><option value="60">60 fps</option><option value="30">30 fps</option><option value="24">24 fps</option></select></label>
                </div>
                <div className="row" style={{ marginBottom: 0 }}>
                  <button title="Render cut media file" onClick={() => { setShowExportModal(false); void startExport(); }} disabled={!selectedMedia || renderKeeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Render Video/Audio</button>
                </div>
                <div className="hint">Detected export options (fast → slow): {exportCapabilities.length === 0 ? "Loading…" : exportCapabilities.map((o) => `${o.format}${o.videoEncoder ? ` (${o.videoEncoder}, ${o.speed})` : " (audio)"}`).join(" • ")}</div>
              </details>

              <details className="collapsedPanel" open={desktopRenderSection === "project"}>
                <summary onClick={(e) => { e.preventDefault(); setDesktopRenderSection("project"); }}><strong>Project File Export</strong></summary>
                <div className="row" style={{ marginTop: 8 }}>
                  <button title="Export Resolve-compatible FCPXML timeline" onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Resolve FCPXML</button>
                  <button title="Export CMX3600 EDL timeline" onClick={() => void exportEdl()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export EDL (CMX3600)</button>
                </div>
                <div className="row">
                  <button title="Export Premiere-friendly XML timeline" onClick={() => void exportPremiereTimelineXml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Premiere XML</button>
                  <button title="Export JSON markers for After Effects scripting workflows" onClick={() => void exportAfterEffectsMarkersJson()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export After Effects markers (JSON)</button>
                </div>
                <div className="row" style={{ marginBottom: 0 }}>
                  <button title="Export AAF bridge package (includes importer script + fallback timelines)" onClick={() => void exportAafBridgePackage()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export AAF bridge package</button>
                </div>
              </details>

              <details className="collapsedPanel" open={desktopRenderSection === "subs"}>
                <summary onClick={(e) => { e.preventDefault(); setDesktopRenderSection("subs"); }}><strong>Subtitles/Script Export</strong></summary>
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => void exportSubtitles("srt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .srt</button>
                  <button onClick={() => void exportSubtitles("vtt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .vtt</button>
                </div>
                <div className="row" style={{ marginBottom: 0 }}>
                  <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>Export Script (.txt)</button>
                  <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
                </div>
              </details>
            </>
          )}

          {isMobileLayout && (
            <>
              <div className="row" style={{ alignItems: "center" }}>
                <button title="Render cut media file" onClick={() => { setShowExportModal(false); setShowRenderPanel(true); }} disabled={!selectedMedia || renderKeeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Render Video/Audio</button>
                <button title="Export Resolve-compatible FCPXML timeline" onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Resolve FCPXML</button>
              </div>
              <div className="row">
                <button title="Export CMX3600 EDL timeline" onClick={() => void exportEdl()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export EDL (CMX3600)</button>
                <button title="Export Premiere-friendly XML timeline" onClick={() => void exportPremiereTimelineXml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Premiere XML</button>
              </div>
              <div className="row">
                <button onClick={() => void exportSubtitles("srt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .srt</button>
                <button onClick={() => void exportSubtitles("vtt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .vtt</button>
                <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>Export Script (.txt)</button>
                <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
              </div>
            </>
          )}

          <div className="hint">Export status: {exportState.status}{exportState.error ? ` — ${exportState.error}` : ""}</div>
          {exportState.outputPath && <div className="hint">Output path: {exportState.outputPath}</div>}
        </div>
      </div>
    )}

    {showExportProgressModal && (exportState.status === "starting" || exportState.status === "running") && (
      <div className="settingsOverlay" onClick={() => setShowExportProgressModal(false)}>
        <div ref={progressModalRef} className="settingsModal" style={{ maxWidth: 520, ...(isMobileLayout ? {} : { position: "fixed", left: "50%", top: "50%", transform: `translate(-50%, -50%) translate(${progressModalOffset.x}px, ${progressModalOffset.y}px)` }) }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("progress", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Rendering in progress</h3>
            <button title="Close" onClick={() => setShowExportProgressModal(false)}>✕</button>
          </div>
          <div className="hint">This will keep running even if you clear the current project.</div>
          <progress className="renderStatusBar" max={100} value={syncedRenderPercent} style={{ width: "100%", height: 12 }} />
          <div className="hint">Time left: {typeof syncedRenderEtaSec === "number" ? formatEta(syncedRenderEtaSec) : "estimating…"}</div>
          <div className="hint">Status: {syncedRenderStatus}{!exportState.jobId ? " · initializing render job…" : ""}</div>
          {globalRenderStatus.lastLog && <div className="hint">{String(globalRenderStatus.lastLog).trim().slice(0, 140)}</div>}
          {!globalRenderStatus.lastLog && exportState.log.length > 0 && <div className="hint">{String(exportState.log[exportState.log.length - 1]).trim().slice(0, 140)}</div>}
          <label className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={notifyWhenRenderReady} onChange={(e) => setNotifyWhenRenderReady(e.target.checked)} />
            Notify me when ready (in-app)
          </label>
          <label className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={autoDownloadWhenReady} onChange={(e) => setAutoDownloadWhenReady(e.target.checked)} />
            Auto-download when complete
          </label>
          <div className="row" style={{ justifyContent: "flex-end", marginBottom: 0 }}>
            <button onClick={() => setShowExportProgressModal(false)}>Dismiss</button>
          </div>
        </div>
      </div>
    )}

    {showLoadProjectModal && (
      <div className="settingsOverlay" onClick={() => setShowLoadProjectModal(false)}>
        <div ref={loadProjectModalRef} className="settingsModal" style={desktopModalStyle(loadProjectModalOffset)} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("loadProject", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Load project</h3>
            <button title="Close" onClick={() => setShowLoadProjectModal(false)}>✕</button>
          </div>
          <div className="row">
            <button onClick={() => void refreshSavedProjects()}>Refresh list</button>
          </div>
          <div className="treeRootWrap" style={{ maxHeight: 420 }}>
            {savedProjects.length === 0 ? <div className="hint">No saved projects yet.</div> : (
              <ul className="treeList">
                {savedProjects.map((p) => (
                  <li key={p.projectId} className="cleanupItem" style={{ marginBottom: 8 }}>
                    <div className="cleanupTitle"><span>{p.projectName || "Project"}</span><span className="count">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ""}</span></div>
                    <div className="hint">{p.root}:/{p.path}</div>
                    <div className="row" style={{ marginBottom: 0 }}>
                      <button onClick={() => void loadProjectById(p.projectId)}>Load</button>
                      <button title="Delete saved project" onClick={() => void deleteProjectById(p.projectId)}>🗑 Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    )}

    {confirmDeleteFile && (
      <div className="settingsOverlay" onClick={() => setConfirmDeleteFile(null)}>
        <div ref={confirmDeleteModalRef} className="settingsModal" style={{ maxWidth: 520, ...desktopModalStyle(confirmDeleteModalOffset) }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("confirmDelete", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Delete file?</h3>
          </div>
          <div className="hint">This will permanently delete:</div>
          <div className="path">{confirmDeleteFile.root}:/{confirmDeleteFile.relPath}</div>
          <div className="row">
            <button onClick={() => setConfirmDeleteFile(null)}>Cancel</button>
            <button onClick={() => { void deleteFile(confirmDeleteFile.root, confirmDeleteFile.relPath); setConfirmDeleteFile(null); }}>Delete</button>
          </div>
        </div>
      </div>
    )}

    {showProjectNameModal && (
      <div className="settingsOverlay" onClick={() => setShowProjectNameModal(false)}>
        <div ref={projectNameModalRef} className="settingsModal" style={{ maxWidth: 520, ...desktopModalStyle(projectNameModalOffset) }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("projectName", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Save project</h3>
          </div>
          <div className="hint">Choose a project name:</div>
          <input value={projectNameDraft} onChange={(e) => setProjectNameDraft(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
          <div className="row">
            <button onClick={() => setShowProjectNameModal(false)}>Cancel</button>
            <button onClick={() => void saveProject(projectNameDraft)}>Save</button>
          </div>
        </div>
      </div>
    )}

    {showAboutModal && (
      <div className="settingsOverlay" style={{ zIndex: 1020 }} onClick={() => setShowAboutModal(false)}>
        <div ref={aboutModalRef} className="settingsModal" style={{ maxWidth: 520, textAlign: "center", position: "relative", zIndex: 221, ...desktopModalStyle(aboutModalOffset) }} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("about", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>About Prune</h3>
            <button title="Close" onClick={() => setShowAboutModal(false)}>✕</button>
          </div>
          <img src={pruneLogo} alt="Prune logo" className="aboutLogo" />
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Prune</div>
          <div className="hint" style={{ marginBottom: 12 }}>Rough cuts at the speed of text.</div>
          <div className="hint" style={{ marginBottom: 4 }}>Designed by FauxRhino</div>
          <div><a href="mailto:Faux@fauxrhino.com">Faux@fauxrhino.com</a></div>
        </div>
      </div>
    )}

    {showInAppNotifyModal && (
      <div className="settingsOverlay" style={{ zIndex: 1030 }} onClick={() => { setShowInAppNotifyModal(false); setFaviconAlert(false); }}>
        <div className="settingsModal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Render notification</h3>
            <button onClick={() => { setShowInAppNotifyModal(false); setFaviconAlert(false); }}>✕</button>
          </div>
          <div className="hint">{inAppNotifyMessage}</div>
          <div className="row" style={{ justifyContent: "flex-end", marginBottom: 0 }}>
            {inAppNotifyDownloadUrl && <button onClick={() => { window.open(inAppNotifyDownloadUrl, "_blank"); setShowInAppNotifyModal(false); setFaviconAlert(false); }}>Download</button>}
            <button onClick={() => { setShowInAppNotifyModal(false); setFaviconAlert(false); }}>Dismiss</button>
          </div>
        </div>
      </div>
    )}

    {toast && <div className="toastNotice">{toast}</div>}

    {showSettings && (
      <div className="settingsOverlay" onClick={() => { if (!settingsNeedsSetup) setShowSettings(false); }}>
        <div ref={settingsModalRef} className="settingsModal" style={desktopModalStyle(settingsModalOffset)} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("settings", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 className="settingsTitle" style={{ margin: 0 }}>{settingsNeedsSetup ? "First-run setup" : "Settings"}</h3>
            <div className="row" style={{ marginBottom: 0 }}>
              <button title="About Prune" onClick={() => setShowAboutModal(true)}>About</button>
              {!settingsNeedsSetup && <button title="Close" onClick={() => setShowSettings(false)}>✕</button>}
            </div>
          </div>
          <div className="hint">Set where your media, transcripts, and project files live. Use plain folder names—no technical setup needed.</div>
          <h4 style={{ margin: "8px 0" }}>Media folders</h4>
          {settingsRootsDraft.map((root, index) => {
            const healthState = settingsDraftRootHealth[index] ?? "checking";
            return (
            <div key={`root-${index}`} className="settingsRootCard">
              <div className="settingsFolderLabel">Media folder #{index + 1}</div>
              <input placeholder="Media folder name" value={root.name} onChange={(e) => setSettingsRootsDraft((prev) => prev.map((r, i) => i === index ? { ...r, name: e.target.value } : r))} />
              <div className="row settingsPathRow">
                <input className="settingsPathInput" placeholder="Folder path" style={{ flex: 1 }} value={root.path} onChange={(e) => setSettingsRootsDraft((prev) => prev.map((r, i) => i === index ? { ...r, path: e.target.value } : r))} />
              </div>
              <div className="row settingsPathActionsRow">
                <button className="settingsActionHalf" onClick={() => void browseForPath((value) => setSettingsRootsDraft((prev) => prev.map((r, i) => i === index ? { ...r, path: value } : r)), root.path)}>...</button>
                <button className="settingsActionHalf" onClick={() => setSettingsRootsDraft((prev) => prev.filter((_, i) => i !== index))} disabled={settingsRootsDraft.length <= 1}>Remove</button>
              </div>
              <span className={`healthBadge settingsHealthFull ${healthState === "ok" ? "ok" : "warn"}`}>{healthState === "checking" ? "Checking…" : healthState === "ok" ? "Folder OK" : "Folder not found"}</span>
            </div>
          );})}
          <div className="row">
            <button onClick={() => setSettingsRootsDraft((prev) => [...prev, { name: `Media ${prev.length + 1}`, path: "" }])}>Add media folder</button>
          </div>
          <h4 style={{ margin: "8px 0" }}>Working folders</h4>
          <div className="settingsFolderRow">
            <div className="settingsFolderLabel">Upload</div>
            <div className="row settingsPathRow">
              <input className="settingsPathInput" value={settingsUploadDir} onChange={(e) => setSettingsUploadDir(e.target.value)} style={{ flex: 1 }} placeholder="/path/to/uploads" />
              <button className="settingsBrowseBtn" onClick={() => void browseForPath((value) => setSettingsUploadDir(value), settingsUploadDir)}>...</button>
            </div>
            {settingsHealth?.upload && <span className={`healthBadge ${settingsHealth.upload.exists && settingsHealth.upload.writable ? "ok" : "warn"}`}>{!settingsHealth.upload.exists ? "Folder missing" : settingsHealth.upload.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="settingsFolderRow">
            <div className="settingsFolderLabel">Whisper Transcripts</div>
            <div className="row settingsPathRow">
              <input className="settingsPathInput" value={settingsTranscriptDir} onChange={(e) => setSettingsTranscriptDir(e.target.value)} style={{ flex: 1 }} placeholder="/path/to/transcripts" />
              <button className="settingsBrowseBtn" onClick={() => void browseForPath((value) => setSettingsTranscriptDir(value), settingsTranscriptDir)}>...</button>
            </div>
            {settingsHealth?.transcripts && <span className={`healthBadge ${settingsHealth.transcripts.exists && settingsHealth.transcripts.writable ? "ok" : "warn"}`}>{!settingsHealth.transcripts.exists ? "Folder missing" : settingsHealth.transcripts.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="settingsFolderRow">
            <div className="settingsFolderLabel">Project Files</div>
            <div className="row settingsPathRow">
              <input className="settingsPathInput" value={settingsProjectsDir} onChange={(e) => setSettingsProjectsDir(e.target.value)} style={{ flex: 1 }} placeholder="/path/to/projects" />
              <button className="settingsBrowseBtn" onClick={() => void browseForPath((value) => setSettingsProjectsDir(value), settingsProjectsDir)}>...</button>
            </div>
            {settingsHealth?.projects && <span className={`healthBadge ${settingsHealth.projects.exists && settingsHealth.projects.writable ? "ok" : "warn"}`}>{!settingsHealth.projects.exists ? "Folder missing" : settingsHealth.projects.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="settingsFolderRow">
            <div className="settingsFolderLabel">Export Cache</div>
            <div className="row settingsPathRow">
              <input className="settingsPathInput" value={settingsExportDir} onChange={(e) => setSettingsExportDir(e.target.value)} style={{ flex: 1 }} placeholder="/path/to/export-cache" />
              <button className="settingsBrowseBtn" onClick={() => void browseForPath((value) => setSettingsExportDir(value), settingsExportDir)}>...</button>
              </div>
            {settingsHealth?.export && <span className={`healthBadge ${settingsHealth.export.exists && settingsHealth.export.writable ? "ok" : "warn"}`}>{!settingsHealth.export.exists ? "Folder missing" : settingsHealth.export.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="settingsFolderLabel">Auto-delete cache after</div>
          <div className="row settingsPathActionsRow" style={{ alignItems: "end" }}>
            <label className="settingsField settingsActionHalf" style={{ minWidth: 0 }}>
              <select value={settingsExportCacheHours} onChange={(e) => setSettingsExportCacheHours(e.target.value)} style={{ width: "100%" }}>
                <option value="0">Never</option>
                <option value="24">24h</option>
                <option value="48">48h</option>
                <option value="72">72h</option>
                <option value="168">7d</option>
                <option value="336">14d</option>
              </select>
            </label>
            <button className="settingsBrowseBtn clearCacheBtn settingsActionHalf" style={{ width: "100%", minWidth: 0, height: 36 }} title="Delete cached rendered video files from export directory" onClick={() => void clearVideoExportCache()}>Clear cache</button>
          </div>
          {settingsError && <div className="error">{settingsError}</div>
          }
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button onClick={() => {
              triggerInAppRenderNotice("Test notification from Prune.", null);
              setToast("Test notification triggered.");
            }}>Test Notification</button>
            <div className="row" style={{ marginBottom: 0 }}>
              {!settingsNeedsSetup && <button onClick={() => setShowSettings(false)}>Cancel</button>}
              <button className="saveSettingsBtn" onClick={() => void saveSettings()}>Save settings</button>
            </div>
          </div>
        </div>
      </div>
    )}
    {showDirPicker && (
      <div className="settingsOverlay" onClick={() => setShowDirPicker(false)}>
        <div ref={dirPickerModalRef} className="settingsModal" style={desktopModalStyle(dirPickerModalOffset)} onClick={(e) => e.stopPropagation()}>
          <div className="row" onMouseDown={(e) => beginModalDrag("dirPicker", e)} style={{ justifyContent: "space-between", alignItems: "center", cursor: isMobileLayout ? "default" : "move" }}>
            <h3 style={{ margin: 0 }}>Select folder</h3>
            <button title="Close" onClick={() => setShowDirPicker(false)}>✕</button>
          </div>
          <div className="hint">Current: {dirPickerPath}</div>
          <div className="row">
            <button onClick={() => { if (dirPickerParent) void loadDirPicker(dirPickerParent); }} disabled={!dirPickerParent}>Up</button>
            <button onClick={() => { dirPickerOnPick?.(dirPickerPath); setShowDirPicker(false); }}>Use this folder</button>
            <button onClick={() => setShowDirPicker(false)}>Cancel</button>
            <label className="toggleRow" style={{ margin: 0 }}><input type="checkbox" checked={dirPickerShowHidden} onChange={(e) => setDirPickerShowHidden(e.target.checked)} />Show hidden folders</label>
          </div>
          <div className="row">
            <input placeholder="New folder name" value={dirPickerNewFolderName} onChange={(e) => setDirPickerNewFolderName(e.target.value)} />
            <button onClick={() => void createDirInPicker()} disabled={!dirPickerNewFolderName.trim()}>Create folder</button>
          </div>
          {dirPickerError && <div className="error">{dirPickerError}</div>}
          <div className="treeRootWrap" style={{ maxHeight: 420 }}>
            <ul className="treeList">
              {dirPickerDirs.map((dir) => (
                <li key={dir.path}>
                  <button className="treeNode" onClick={() => void loadDirPicker(dir.path)}>📁 {dir.name}</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
