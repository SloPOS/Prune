import { useEffect, useMemo, useRef, useState } from "react";
import { cutRangesFromDeletedTokens, keepRangesFromCuts, type TimeRange, type WordToken } from "@bit-cut/core";

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


type GapSuggestion = {
  id: string;
  startSec: number;
  endSec: number;
  gapSec: number;
  trimStartSec: number;
  trimEndSec: number;
  trimSec: number;
};

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"];
const FIXED_SMART_CLEANUP_PHRASES = [
  "um", "uh", "ah", "er", "mm-hmm",
  "like", "basically", "actually", "literally", "seriously", "honestly", "obviously",
  "anyway", "well", "now",
  "right?", "you know?", "okay?", "make sense?", "you see?",
  "i mean", "at the end of the day", "to be honest with you", "for all intents and purposes", "as a matter of fact", "it is what it is",
  "go ahead", "gone ahead", "let's go ahead", "we're gonna", "we're going to",
] as const;

function isVideoFile(name: string) {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isAudioFile(name: string) {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function sanitizeBaseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

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

function normalizeTranscript(input: unknown): WordToken[] {
  const asArray = Array.isArray(input)
    ? input
    : typeof input === "object" && input && Array.isArray((input as { tokens?: unknown[] }).tokens)
      ? (input as { tokens: unknown[] }).tokens
      : [];

  return asArray
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const token = item as Record<string, unknown>;
      const text = String(token.text ?? token.word ?? "").trim();
      const startSec = Number(token.startSec ?? token.start ?? token.start_time ?? token.startTime);
      const endSec = Number(token.endSec ?? token.end ?? token.end_time ?? token.endTime);
      if (!text || Number.isNaN(startSec) || Number.isNaN(endSec) || endSec <= startSec) return null;
      return { id: String(token.id ?? `tok-${index}`), text, startSec, endSec } satisfies WordToken;
    })
    .filter((t): t is WordToken => Boolean(t));
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m ${secs}s`;
}

function tokenAtTime(tokens: WordToken[], timeSec: number): number {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (timeSec >= t.startSec && timeSec <= t.endSec) return i;
  }
  return -1;
}

function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = ranges
    .filter((r) => Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  if (sorted.length === 0) return [];
  const merged: TimeRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1]!;
    const curr = sorted[i]!;
    if (curr.startSec <= prev.endSec) prev.endSec = Math.max(prev.endSec, curr.endSec);
    else merged.push({ ...curr });
  }
  return merged;
}

function buildScriptBody(tokens: WordToken[], deleted: Set<string>, includeDeleted = false): string {
  const filtered = includeDeleted ? tokens : tokens.filter((t) => !deleted.has(t.id));
  if (filtered.length === 0) return "";
  const punctNoLeadSpace = /^[,.;:!?)]$/;
  const openersNoTrailSpace = /^[(]$/;
  let out = "";
  for (const token of filtered) {
    const text = token.text.trim();
    if (!text) continue;
    if (!out) out = text;
    else if (punctNoLeadSpace.test(text)) out += text;
    else if (openersNoTrailSpace.test(out.slice(-1))) out += text;
    else out += ` ${text}`;
  }
  return out.replace(/\s+\n/g, "\n").trim();
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
  const [mobileTab, setMobileTab] = useState<"media" | "transcript" | "tools" | "export">("media");
  const splitRef = useRef<HTMLDivElement | null>(null);

  const [roots, setRoots] = useState<RootConfig[]>([]);
  const [transcriptPickerRoot, setTranscriptPickerRoot] = useState<RootConfig | null>(null);
  const [pickerEntriesByDir, setPickerEntriesByDir] = useState<Record<string, BrowserEntry[]>>({});
  const [pickerLoadingDirs, setPickerLoadingDirs] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TreeSelection>(null);
  const [uploadStatus, setUploadStatus] = useState<string>("idle");
  const [showSettings, setShowSettings] = useState(false);
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
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [filePickerIntent, setFilePickerIntent] = useState<"media" | "json">("media");
  const [filePickerShowAll, setFilePickerShowAll] = useState(false);
  const [showTranscriptPrompt, setShowTranscriptPrompt] = useState(false);
  const [showTranscribeModal, setShowTranscribeModal] = useState(false);
  const [sttPreset, setSttPreset] = useState<"fast" | "balanced" | "quality">("balanced");
  const [showSttPresetMenu, setShowSttPresetMenu] = useState(false);
  const [showSttPresetMenuInline, setShowSttPresetMenuInline] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
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
  const [openLeftPanel, setOpenLeftPanel] = useState<"noise" | "stt" | null>(null);
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

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("bitcut-theme");
    if (savedTheme === "light") setIsLightMode(true);
    void loadSettingsAndRoots();
    void loadExportCapabilities();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", isLightMode ? "light" : "dark");
    window.localStorage.setItem("bitcut-theme", isLightMode ? "light" : "dark");
  }, [isLightMode]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px), (orientation: portrait) and (max-width: 1100px)");
    const apply = () => setIsMobileLayout(query.matches);
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
    if (!transcribe.jobId || (transcribe.status !== "running" && transcribe.status !== "starting")) return;
    const timer = window.setInterval(async () => {
      const query = new URLSearchParams({ jobId: transcribe.jobId! }).toString();
      const response = await fetch(`/api/transcribe/status?${query}`);
      if (!response.ok) return;
      const data = await response.json();
      setTranscribe((prev) => ({
        ...prev,
        status: data.status === "running" || data.status === "queued" ? "running" : data.status,
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
    return () => window.clearInterval(timer);
  }, [transcribe.jobId, transcribe.status]);

  useEffect(() => {
    if (!exportState.jobId || (exportState.status !== "running" && exportState.status !== "starting")) return;
    const timer = window.setInterval(async () => {
      const query = new URLSearchParams({ jobId: exportState.jobId! }).toString();
      const response = await fetch(`/api/export/status?${query}`);
      if (!response.ok) return;
      const data = await response.json();
      setExportState((prev) => ({ ...prev, status: data.status === "running" || data.status === "queued" ? "running" : data.status, outputPath: data.outputPath ?? prev.outputPath, error: data.error ?? null, log: Array.isArray(data.log) ? data.log.slice(-14) : prev.log }));
      if (data.status === "done" && data.downloadUrl && exportState.jobId && !downloadedExportJobs.has(exportState.jobId)) {
        window.open(data.downloadUrl, "_blank");
        setDownloadedExportJobs((prev) => new Set(prev).add(exportState.jobId!));
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [exportState.jobId, exportState.status, downloadedExportJobs]);

  useEffect(() => {
    if (transcribe.status !== "done" || !transcribe.jobId || !transcribe.transcriptRelPath) return;
    if (!transcriptPickerRoot) return;
    if (lastAutoLoadedTranscriptJobId === transcribe.jobId) return;
    setLastAutoLoadedTranscriptJobId(transcribe.jobId);
    void loadTranscript(transcriptPickerRoot.id, transcribe.transcriptRelPath, true);
  }, [transcribe.status, transcribe.jobId, transcribe.transcriptRelPath, transcriptPickerRoot, lastAutoLoadedTranscriptJobId]);

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

  const timingDiffSec = Math.abs(videoDurationSec - transcriptDurationSec);
  const timingValid = videoDurationSec > 0 && transcriptDurationSec > 0;
  const timingMatch = timingValid && (timingDiffSec <= 1.25 || timingDiffSec / Math.max(videoDurationSec, 1) < 0.03);

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
    if (loaded) setShowTranscriptPrompt(false);
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
      setVideoSrc(`/api/media?${query}`);
      setActiveMediaKind(isAudioFile(entryName) ? "audio" : "video");
      setVideoLabel(`${root}: ${relPath}`);
      setSelectedMedia({ root, path: relPath, name: entryName });
      setExportName(`${entryName.replace(/\.[^.]+$/, "")}-edited`);
      setTranscribe({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
      setExportState({ jobId: null, status: "idle", outputPath: null, error: null, log: [] });
      if (!opts?.skipPrompt) setShowTranscriptPrompt(true);
      if (!opts?.skipAutoTranscript) await tryAutoLoadTranscript(root, entryName);
      await loadSavedProject(root, relPath);
      return;
    }

    setToast("Selected file is not a supported media/transcript file.");
  }

  async function openSelectedFile() {
    if (!selectedEntry || selectedEntry.type !== "file") return;
    await openFileEntry(selectedEntry.root, selectedEntry.relPath);
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
    setExportState({ jobId: null, status: "starting", outputPath: null, error: null, log: [] });
    const response = await fetch("/api/export/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, outputName: exportName, keepRanges: keeps, cuts }),
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
    if (text) await navigator.clipboard.writeText(text);
  }

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

  async function uploadFile(file: File | null) {
    if (!file) return;
    setUploadStatus("uploading");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/files/upload", { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setUploadStatus(`uploaded: ${data.savedPath ?? data.relPath}`);
      const uploadRoot = String(data.root ?? roots[0]?.id ?? "");
      const uploadDir = String(data.relPath ?? "").split("/").slice(0, -1).join("/") || ".";
      await Promise.all(roots.map((r) => loadDir(r.id, ".")));
      if (uploadRoot) {
        await loadDir(uploadRoot, uploadDir);
        setExpandedDirs((prev) => new Set(prev).add(`${uploadRoot}:${uploadDir}`));
        const relPath = String(data.relPath || "");
        setSelectedEntry({ root: uploadRoot, relPath, type: "file" });
        if (relPath.toLowerCase().endsWith(".json")) {
          await loadTranscript(uploadRoot, relPath);
          setShowTranscriptPrompt(false);
        } else {
          await openFileEntry(uploadRoot, relPath);
          setShowTranscriptPrompt(true);
        }
      }
    } catch (error) {
      setUploadStatus(`error: ${error instanceof Error ? error.message : "upload failed"}`);
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
                {open ? "▾" : "▸"} 📁 {entry.name}
              </button>
              {open && renderTree(root, entry.relPath, depth + 1)}
            </li>
          );
        })}
        {files.map((entry) => (
          <li key={`${root}:${entry.relPath}`}>
            <div className="row" style={{ marginBottom: 0, alignItems: "center", gap: 6 }}>
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
                📄 {entry.name}
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
          <button className={mobileTab === "export" ? "active" : ""} onClick={() => setMobileTab("export")}>Export</button>
          <div className="appMenuWrap">
            <button className="appMenuBtn" title="Project and settings menu" onClick={() => setShowAppMenu((v) => !v)}>☰</button>
            {showAppMenu && (
              <div className="appMenuDropdown">
                <button className="themeIconOnlyBtn" title="Toggle light/dark theme" onClick={() => { setIsLightMode((v) => !v); setShowAppMenu(false); }}>{isLightMode ? "🌙" : "☀️"}</button>
                <button title="Open app settings" onClick={() => { setShowSettings(true); void loadSettingsHealth(); setShowAppMenu(false); }}>Settings</button>
                <button title="Save current cut decisions for this media" onClick={() => { void saveProject(); setShowAppMenu(false); }} disabled={!selectedMedia}>Save project</button>
                <button title="Load a previously saved project" onClick={() => { setShowLoadProjectModal(true); void refreshSavedProjects(); setShowAppMenu(false); }}>Load project</button>
                <button title="Clear current project and start fresh" onClick={() => { clearProject(); setShowAppMenu(false); }}>Clear project</button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="pane videoPane">
        <div className="mobileMediaSection">
        <h2>Video</h2>
        <div className="hint">Selected: {videoLabel}</div>
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
        {isMobileLayout && (
          <div className="mobileWhisperRow row">
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
          </div>
        )}
        </div>

        <details className="collapsedPanel mobileToolsSection" open={openLeftPanel === "noise"}>
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

        <details className="collapsedPanel sttPanel mobileToolsSection" open={openLeftPanel === "stt"}>
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

        <div className="exportButtonWrap mobileExportSection">
          {isMobileLayout ? (
            <div className="mobileExportPanel">
              <div className="hint">Final review and export options.</div>
              {videoSrc && (activeMediaKind === "video" ? <video controls src={videoSrc} /> : <audio controls src={videoSrc} style={{ width: "100%", marginBottom: 10 }} />)}
              <div className="row">
                <input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="Output file name" style={{ minWidth: 220, flex: 1 }} title="Base file name for exports" />
              </div>
              <div className="row">
                <button title="Render cut media file" onClick={() => void startExport()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Edited Video/Audio</button>
                <button title="Export Resolve-compatible FCPXML timeline" onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Resolve FCPXML</button>
                <button title="Export CMX3600 EDL timeline" onClick={() => void exportEdl()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export EDL (CMX3600)</button>
                <button title="Export Premiere-friendly XML timeline" onClick={() => void exportPremiereTimelineXml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Premiere XML</button>
              </div>
              <div className="row">
                <button title="Export JSON markers for After Effects scripting workflows" onClick={() => void exportAfterEffectsMarkersJson()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export After Effects markers (JSON)</button>
                <button title="Export AAF bridge package (includes importer script + fallback timelines)" onClick={() => void exportAafBridgePackage()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export AAF bridge package</button>
              </div>
              <div className="row">
                <button onClick={() => void exportSubtitles("srt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .srt</button>
                <button onClick={() => void exportSubtitles("vtt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .vtt</button>
                <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>Export Script (.txt)</button>
                <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
              </div>
              <div className="hint">Export status: {exportState.status}{exportState.error ? ` — ${exportState.error}` : ""}</div>
              {exportState.outputPath && <div className="hint">Output path: {exportState.outputPath}</div>}
            </div>
          ) : (
            <button className="exportBigButton" title="Review final cut preview and export options" onClick={() => setShowExportModal(true)}>Export</button>
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

        <p className="transcriptParagraph">
          {tokens.map((t, index) => {
            const className = ["tokenInline", deleted.has(t.id) ? "deleted" : "", index === activeTokenIndex ? "active" : "", highlightedTokenIds.has(t.id) ? "highlighted" : "", isDraggingTokens && dragSelectedTokenIds.has(t.id) ? "dragSelected" : ""].filter(Boolean).join(" ");
            return <span key={t.id}><button data-token-index={index} onMouseDown={() => beginTokenDrag(index)} onMouseEnter={() => continueTokenDrag(index)} onMouseUp={() => endTokenDrag()} onClick={() => { if (suppressNextTokenClick) { setSuppressNextTokenClick(false); return; } if (rangeSelectMode) { if (rangeSelectAnchor === null) { setRangeSelectAnchor(index); setToast(`Range anchor set at word ${index + 1}`); } else { toggleRangeByIndex(rangeSelectAnchor, index); setRangeSelectAnchor(null); } return; } toggle(t.id); }} onDoubleClick={() => playFromToken(t)} className={className} title={`${t.startSec.toFixed(2)}s - ${t.endSec.toFixed(2)}s (double-click to play from here)`}>{t.text}</button>{" "}</span>;
          })}
        </p>
        </div>

        <div className="toolsStack mobileToolsSection">
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

          <details className="collapsedPanel" open={openToolPanel === "gap"}>
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
              <span className="hint">Tokens {tokens.length} · Deleted {deleted.size} · Cuts {cuts.length} ({totalCutSec.toFixed(2)}s) · Keeps {keeps.length} ({totalKeepSec.toFixed(2)}s)</span>
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
    {showTranscriptSearchModal && (
      <div className="settingsOverlay" onClick={() => setShowTranscriptSearchModal(false)}>
        <div className="settingsModal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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

    {showFilePickerModal && (
      <div className="settingsOverlay" onClick={() => { setShowFilePickerModal(false); setFilePickerFromTranscriptPrompt(false); }}>
        <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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

    {showTranscriptPrompt && selectedMedia && (
      <div className="settingsOverlay" onClick={() => { setShowTranscriptPrompt(false); setShowSttPresetMenu(false); }}>
        <div className="settingsModal transcriptSetupModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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

    {showTranscribeModal && (transcribe.status === "running" || transcribe.status === "starting") && (
      <div className="settingsOverlay" onClick={() => setShowTranscribeModal(false)}>
        <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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

    {showExportModal && (
      <div className="settingsOverlay" onClick={() => setShowExportModal(false)}>
        <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Export</h3>
            <button title="Close" onClick={() => setShowExportModal(false)}>✕</button>
          </div>
          <div className="hint">Final review and export options.</div>
          {videoSrc && (activeMediaKind === "video" ? <video controls src={videoSrc} /> : <audio controls src={videoSrc} style={{ width: "100%", marginBottom: 10 }} />)}
          <div className="row">
            <input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="Output file name" style={{ minWidth: 220 }} title="Base file name for exports" />
            <button title="Render cut media file" onClick={() => void startExport()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Edited Video/Audio</button>
            <button title="Export Resolve-compatible FCPXML timeline" onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Resolve FCPXML</button>
            <button title="Export CMX3600 EDL timeline" onClick={() => void exportEdl()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export EDL (CMX3600)</button>
            <button title="Export Premiere-friendly XML timeline" onClick={() => void exportPremiereTimelineXml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Premiere XML</button>
          </div>
          <div className="hint">Detected export options (fast → slow): {exportCapabilities.length === 0 ? "Loading…" : exportCapabilities.map((o) => `${o.format}${o.videoEncoder ? ` (${o.videoEncoder}, ${o.speed})` : " (audio)"}`).join(" • ")}</div>
          <div className="row">
            <button title="Export JSON markers for After Effects scripting workflows" onClick={() => void exportAfterEffectsMarkersJson()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export After Effects markers (JSON)</button>
            <button title="Export AAF bridge package (includes importer script + fallback timelines)" onClick={() => void exportAafBridgePackage()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export AAF bridge package</button>
          </div>
          <h4>Subtitles & Script</h4>
          <div className="row">
            <button onClick={() => void exportSubtitles("srt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .srt</button>
            <button onClick={() => void exportSubtitles("vtt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>Export .vtt</button>
            <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>Export Script (.txt)</button>
            <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
          </div>
          <div className="hint">Export status: {exportState.status}{exportState.error ? ` — ${exportState.error}` : ""}</div>
          {exportState.outputPath && <div className="hint">Output path: {exportState.outputPath}</div>}
        </div>
      </div>
    )}

    {showLoadProjectModal && (
      <div className="settingsOverlay" onClick={() => setShowLoadProjectModal(false)}>
        <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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
        <div className="settingsModal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
          <h3>Delete file?</h3>
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
        <div className="settingsModal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
          <h3>Save project</h3>
          <div className="hint">Choose a project name:</div>
          <input value={projectNameDraft} onChange={(e) => setProjectNameDraft(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
          <div className="row">
            <button onClick={() => setShowProjectNameModal(false)}>Cancel</button>
            <button onClick={() => void saveProject(projectNameDraft)}>Save</button>
          </div>
        </div>
      </div>
    )}

    {toast && <div className="toastNotice">{toast}</div>}

    {showSettings && (
      <div className="settingsOverlay" onClick={() => { if (!settingsNeedsSetup) setShowSettings(false); }}>
        <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>{settingsNeedsSetup ? "First-run setup" : "Settings"}</h3>
            {!settingsNeedsSetup && <button title="Close" onClick={() => setShowSettings(false)}>✕</button>}
          </div>
          <div className="hint">Set where your media, transcripts, and project files live. Use plain folder names—no technical setup needed.</div>
          <h4 style={{ margin: "8px 0" }}>Media folders</h4>
          {settingsRootsDraft.map((root, index) => {
            const healthState = settingsDraftRootHealth[index] ?? "checking";
            return (
            <div key={`root-${index}`} className="row">
              <input placeholder="Media folder name" value={root.name} onChange={(e) => setSettingsRootsDraft((prev) => prev.map((r, i) => i === index ? { ...r, name: e.target.value } : r))} />
              <input placeholder="Folder path" style={{ minWidth: 320, flex: 1 }} value={root.path} onChange={(e) => setSettingsRootsDraft((prev) => prev.map((r, i) => i === index ? { ...r, path: e.target.value } : r))} />
              <button onClick={() => void browseForPath((value) => setSettingsRootsDraft((prev) => prev.map((r, i) => i === index ? { ...r, path: value } : r)), root.path)}>Browse…</button>
              <button onClick={() => setSettingsRootsDraft((prev) => prev.filter((_, i) => i !== index))} disabled={settingsRootsDraft.length <= 1}>Remove</button>
              <span className={`healthBadge ${healthState === "ok" ? "ok" : "warn"}`}>{healthState === "checking" ? "Checking…" : healthState === "ok" ? "Folder OK" : "Folder not found"}</span>
            </div>
          );})}
          <div className="row">
            <button onClick={() => setSettingsRootsDraft((prev) => [...prev, { name: `Media ${prev.length + 1}`, path: "" }])}>Add media folder</button>
          </div>
          <h4 style={{ margin: "8px 0" }}>Working folders</h4>
          <div className="row settingsFolderRow">
            <input value="Upload" disabled className="settingsKindInput" />
            <input className="settingsPathInput" value={settingsUploadDir} onChange={(e) => setSettingsUploadDir(e.target.value)} style={{ minWidth: 320, flex: 1 }} placeholder="/path/to/uploads" />
            <button className="settingsBrowseBtn settingsBrowseWide" onClick={() => void browseForPath((value) => setSettingsUploadDir(value), settingsUploadDir)}>Browse…</button>
            {settingsHealth?.upload && <span className={`healthBadge ${settingsHealth.upload.exists && settingsHealth.upload.writable ? "ok" : "warn"}`}>{!settingsHealth.upload.exists ? "Folder missing" : settingsHealth.upload.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="row settingsFolderRow">
            <input value="Whisper Transcripts" disabled className="settingsKindInput" />
            <input className="settingsPathInput" value={settingsTranscriptDir} onChange={(e) => setSettingsTranscriptDir(e.target.value)} style={{ minWidth: 320, flex: 1 }} placeholder="/path/to/transcripts" />
            <button className="settingsBrowseBtn settingsBrowseWide" onClick={() => void browseForPath((value) => setSettingsTranscriptDir(value), settingsTranscriptDir)}>Browse…</button>
            {settingsHealth?.transcripts && <span className={`healthBadge ${settingsHealth.transcripts.exists && settingsHealth.transcripts.writable ? "ok" : "warn"}`}>{!settingsHealth.transcripts.exists ? "Folder missing" : settingsHealth.transcripts.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="row settingsFolderRow">
            <input value="Project Files" disabled className="settingsKindInput" />
            <input className="settingsPathInput" value={settingsProjectsDir} onChange={(e) => setSettingsProjectsDir(e.target.value)} style={{ minWidth: 320, flex: 1 }} placeholder="/path/to/projects" />
            <button className="settingsBrowseBtn settingsBrowseWide" onClick={() => void browseForPath((value) => setSettingsProjectsDir(value), settingsProjectsDir)}>Browse…</button>
            {settingsHealth?.projects && <span className={`healthBadge ${settingsHealth.projects.exists && settingsHealth.projects.writable ? "ok" : "warn"}`}>{!settingsHealth.projects.exists ? "Folder missing" : settingsHealth.projects.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="row settingsFolderRow">
            <input value="Export Cache" disabled className="settingsKindInput" />
            <input className="settingsPathInput" value={settingsExportDir} onChange={(e) => setSettingsExportDir(e.target.value)} style={{ minWidth: 320, flex: 1 }} placeholder="/path/to/export-cache" />
            <button className="settingsBrowseBtn" onClick={() => void browseForPath((value) => setSettingsExportDir(value), settingsExportDir)}>Browse…</button>
            <button className="settingsBrowseBtn clearCacheBtn" title="Delete cached rendered video files from export directory" onClick={() => void clearVideoExportCache()}>Clear cache</button>
            {settingsHealth?.export && <span className={`healthBadge ${settingsHealth.export.exists && settingsHealth.export.writable ? "ok" : "warn"}`}>{!settingsHealth.export.exists ? "Folder missing" : settingsHealth.export.writable ? "Folder OK" : "Write protected"}</span>}
          </div>
          <div className="row" style={{ alignItems: "center" }}>
            <label className="settingsField" style={{ minWidth: 240 }}>Auto-delete cache after<select value={settingsExportCacheHours} onChange={(e) => setSettingsExportCacheHours(e.target.value)}>
                <option value="0">Never</option>
                <option value="24">24h</option>
                <option value="48">48h</option>
                <option value="72">72h</option>
                <option value="168">7d</option>
                <option value="336">14d</option>
              </select>
            </label>
          </div>
          {settingsError && <div className="error">{settingsError}</div>
          }
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {!settingsNeedsSetup && <button onClick={() => setShowSettings(false)}>Cancel</button>}
            <button className="saveSettingsBtn" onClick={() => void saveSettings()}>Save settings</button>
          </div>
        </div>
      </div>
    )}
    {showDirPicker && (
      <div className="settingsOverlay" onClick={() => setShowDirPicker(false)}>
        <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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
