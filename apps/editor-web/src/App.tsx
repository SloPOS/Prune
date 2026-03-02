import { useEffect, useMemo, useRef, useState } from "react";
import { cutRangesFromDeletedTokens, keepRangesFromCuts, type WordToken } from "@bit-cut/core";

type RootName = "inbox" | "archive";
type BrowserEntry = {
  name: string;
  type: "dir" | "file";
  relPath: string;
  sizeBytes: number | null;
};

type SelectedMedia = { root: RootName; path: string; name: string } | null;
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

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];
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
  const [videoLabel, setVideoLabel] = useState<string>("No Media Loaded");
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia>(null);
  const [exportName, setExportName] = useState<string>("edited-cut");
  const [videoDurationSec, setVideoDurationSec] = useState<number>(0);
  const [splitLeftPct, setSplitLeftPct] = useState<number>(58);
  const [isResizing, setIsResizing] = useState(false);
  const splitRef = useRef<HTMLDivElement | null>(null);

  const [pickerEntriesByDir, setPickerEntriesByDir] = useState<Record<string, BrowserEntry[]>>({});
  const [pickerLoadingDirs, setPickerLoadingDirs] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(["inbox:.", "archive:."]));
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TreeSelection>(null);
  const [uploadStatus, setUploadStatus] = useState<string>("idle");

  const [transcribe, setTranscribe] = useState<TranscribeState>({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
  const [exportState, setExportState] = useState<ExportState>({ jobId: null, status: "idle", outputPath: null, error: null, log: [] });
  const [scriptExport, setScriptExport] = useState<ScriptExportState>({ status: "idle", outputPath: null, error: null });
  const [subtitleExport, setSubtitleExport] = useState<SubtitleExportState>({ status: "idle", outputPath: null, error: null, format: null });
  const [scriptIncludeDeleted, setScriptIncludeDeleted] = useState(false);
  const [subtitleIncludeDeleted, setSubtitleIncludeDeleted] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [activeTokenIndex, setActiveTokenIndex] = useState<number>(-1);
  const [previewCuts, setPreviewCuts] = useState(true);
  const [ignoredPhrases, setIgnoredPhrases] = useState<Set<string>>(new Set());
  const [highlightedPhrase, setHighlightedPhrase] = useState<string | null>(null);
  const [searchPhrase, setSearchPhrase] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    void Promise.all([loadDir("inbox", "."), loadDir("archive", ".")]);
  }, []);
  useEffect(() => {
    if (!isResizing) return;
    function onMove(event: MouseEvent) {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      setSplitLeftPct(Math.min(78, Math.max(35, pct)));
    }
    function onUp() { setIsResizing(false); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing]);

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
    }, 1200);
    return () => window.clearInterval(timer);
  }, [exportState.jobId, exportState.status]);

  useEffect(() => { setActiveTokenIndex(tokenAtTime(tokens, currentTimeSec)); }, [tokens, currentTimeSec]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = 0;
    setCurrentTimeSec(0);
    setActiveTokenIndex(-1);
    setVideoDurationSec(0);
  }, [videoSrc]);

  const cuts = useMemo(() => cutRangesFromDeletedTokens(tokens, deleted), [deleted, tokens]);
  const transcriptDurationSec = useMemo(() => tokens.reduce((max, t) => Math.max(max, t.endSec), 0), [tokens]);
  const keeps = useMemo(() => keepRangesFromCuts(transcriptDurationSec, cuts), [cuts, transcriptDurationSec]);
  const totalCutSec = useMemo(() => cuts.reduce((sum, c) => sum + (c.endSec - c.startSec), 0), [cuts]);
  const totalKeepSec = useMemo(() => keeps.reduce((sum, k) => sum + (k.sourceEndSec - k.sourceStartSec), 0), [keeps]);

  const transcribeProgress = useMemo(() => {
    const duration = transcribe.mediaDurationSec ?? 0;
    const progressSec = transcribe.transcribedSec ?? 0;
    const pct = duration > 0 ? Math.min(100, Math.max(0, (progressSec / duration) * 100)) : transcribe.status === "done" ? 100 : 0;
    const elapsedSec = transcribe.startedAt ? Math.max(0, (Date.now() - transcribe.startedAt) / 1000) : 0;
    const speed = elapsedSec > 0 ? progressSec / elapsedSec : 0;
    const remaining = duration > progressSec && speed > 0 ? (duration - progressSec) / speed : 0;
    return { pct, speed, remaining, duration, progressSec };
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
      if (!silent) alert(`Failed to load transcript: ${await response.text()}`);
      return false;
    }
    const data = await response.json();
    const nextTokens = normalizeTranscript(data);
    if (nextTokens.length === 0) {
      if (!silent) alert("No valid transcript tokens found in JSON.");
      return false;
    }
    setTokens(nextTokens);
    setDeleted(new Set());
    setIgnoredPhrases(new Set());
    setHighlightedPhrase(null);
    return true;
  }

  async function tryAutoLoadTranscript(root: RootName, fileName: string) {
    await loadTranscript(root, `transcripts/${sanitizeBaseName(fileName)}.json`, true);
  }

  async function openSelectedFile() {
    if (!selectedEntry || selectedEntry.type !== "file") return;
    const entryName = selectedEntry.relPath.split("/").filter(Boolean).at(-1) ?? selectedEntry.relPath;

    if (entryName.toLowerCase().endsWith(".json")) {
      await loadTranscript(selectedEntry.root, selectedEntry.relPath);
      return;
    }

    if (isVideoFile(entryName)) {
      const query = new URLSearchParams({ root: selectedEntry.root, path: selectedEntry.relPath }).toString();
      setVideoSrc(`/api/media?${query}`);
      setVideoLabel(`${selectedEntry.root}: ${selectedEntry.relPath}`);
      setSelectedMedia({ root: selectedEntry.root, path: selectedEntry.relPath, name: entryName });
      setExportName(`${entryName.replace(/\.[^.]+$/, "")}-edited`);
      setTranscribe({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
      setExportState({ jobId: null, status: "idle", outputPath: null, error: null, log: [] });
      await tryAutoLoadTranscript(selectedEntry.root, entryName);
      return;
    }

    alert("Selected file is not a supported media/transcript file.");
  }

  async function startTranscription() {
    if (!selectedMedia) return;
    setTranscribe({ jobId: null, status: "starting", log: [], transcriptRelPath: null, error: null });
    const response = await fetch("/api/transcribe/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: selectedMedia.root, path: selectedMedia.path, model: "small", device: "cpu" }),
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
    setExportState((prev) => ({ ...prev, jobId: data.jobId ?? null, status: "done", outputPath: data.outputPath ?? null, error: null, log: data.downloadUrl ? [`Download: ${data.downloadUrl}\n`] : [] }));
  }

  async function loadLatestTranscript() {
    if (!selectedMedia) return;
    await loadTranscript(selectedMedia.root, `transcripts/${sanitizeBaseName(selectedMedia.name)}.json`);
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
    const data = await response.json();
    setScriptExport({ status: "done", outputPath: data.outputPath ?? null, error: null });
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

    const data = await response.json();
    setSubtitleExport({ status: "done", outputPath: data.outputPath ?? null, error: null, format });
  }

  async function copyScriptToClipboard() {
    const text = buildScriptBody(tokens, deleted, scriptIncludeDeleted);
    if (text) await navigator.clipboard.writeText(text);
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
      await Promise.all([loadDir("archive", "."), loadDir("archive", "incoming/uploads")]);
      setExpandedDirs((prev) => new Set(prev).add("archive:incoming/uploads"));
      setSelectedEntry({ root: "archive", relPath: data.relPath, type: "file" });
    } catch (error) {
      setUploadStatus(`error: ${error instanceof Error ? error.message : "upload failed"}`);
    }
  }

  function removeSearchedMatches() {
    if (searchedTokenIds.length === 0) return;
    const unique = Array.from(new Set(searchedTokenIds));
    const allDeleted = unique.every((id) => deleted.has(id));
    setDeleted((prev) => {
      const next = new Set(prev);
      for (const id of unique) allDeleted ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggle(id: string) {
    setDeleted((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function togglePhraseDeletion(match: PhraseMatch) {
    setDeleted((prev) => {
      const next = new Set(prev);
      const uniqueIds = Array.from(new Set(match.tokenIds));
      const allDeleted = uniqueIds.length > 0 && uniqueIds.every((id) => next.has(id));
      for (const id of uniqueIds) allDeleted ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function ignorePhrase(match: PhraseMatch) {
    setIgnoredPhrases((prev) => new Set(prev).add(match.normalizedPhrase));
    setHighlightedPhrase((prev) => (prev === match.normalizedPhrase ? null : prev));
  }

  function onVideoTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
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

  function renderTree(root: RootName, relDir: string, depth = 0): React.ReactNode {
    const key = `${root}:${relDir}`;
    const entries = pickerEntriesByDir[key] ?? [];
    const dirs = entries.filter((e) => e.type === "dir");
    const files = entries.filter((e) => e.type === "file");
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
            <button className={`treeNode ${selectedEntry?.root === root && selectedEntry?.relPath === entry.relPath && selectedEntry?.type === "file" ? "active" : ""}`} onClick={() => setSelectedEntry({ root, relPath: entry.relPath, type: "file" })}>
              📄 {entry.name}
            </button>
          </li>
        ))}
        {loading && <li className="hint">Loading…</li>}
      </ul>
    );
  }

  return (
    <div className="page split" ref={splitRef} style={{ gridTemplateColumns: `${splitLeftPct}% 8px 1fr` }}>
      <div className="pane videoPane">
        <h2>Video</h2>
        <div className="hint">Selected: {videoLabel}</div>
        {videoSrc ? <video ref={videoRef} controls src={videoSrc} onTimeUpdate={onVideoTimeUpdate} onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} /> : <div className="videoPlaceholder">No Media Loaded</div>}

        <label className="toggleRow"><input type="checkbox" checked={previewCuts} onChange={(e) => setPreviewCuts(e.target.checked)} />Preview Cuts (skip deleted sections during playback)</label>

        <h3>Speech-to-text</h3>
        <div className="hint">Select a local video, then click Start Whisper STT.</div>
        <div className="row">
          <button onClick={() => void startTranscription()} disabled={!selectedMedia || transcribe.status === "running" || transcribe.status === "starting"}>{transcribe.status === "running" || transcribe.status === "starting" ? "Transcribing…" : "Start Whisper STT"}</button>
          <button onClick={() => void loadLatestTranscript()} disabled={!selectedMedia}>Load latest transcript</button>
        </div>
        <div className="hint">Status: {transcribe.status}{transcribe.phase ? ` (${transcribe.phase})` : ""}{transcribe.error ? ` — ${transcribe.error}` : ""}</div>
        {(transcribe.status === "running" || transcribe.status === "done") && <><progress max={100} value={transcribeProgress.pct} style={{ width: "100%", height: 12 }} /><div className="hint">{transcribeProgress.pct.toFixed(1)}% · {transcribeProgress.progressSec.toFixed(1)}s / {transcribeProgress.duration.toFixed(1)}s{transcribe.status === "running" && ` · ${transcribeProgress.speed.toFixed(2)}x realtime · ETA ${formatEta(transcribeProgress.remaining)}`}</div></>}
        {transcribe.transcriptRelPath && <div className="hint">Output: {transcribe.transcriptRelPath}</div>}

        <h3>Export</h3>
        <div className="row">
          <input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="Output file name" style={{ minWidth: 220 }} />
          <button onClick={() => void startExport()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>{exportState.status === "running" || exportState.status === "starting" ? "Exporting…" : "Export Edited Video"}</button>
          <button onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>Export Resolve FCPXML</button>
        </div>
        <div className="hint">Status: {exportState.status}{exportState.error ? ` — ${exportState.error}` : ""}</div>
        {exportState.outputPath && <div className="hint">Output path: {exportState.outputPath}</div>}

        <h3>Script Export</h3>
        <label className="toggleRow"><input type="checkbox" checked={scriptIncludeDeleted} onChange={(e) => setScriptIncludeDeleted(e.target.checked)} />Include deleted tokens</label>
        <div className="row">
          <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>{scriptExport.status === "working" ? "Exporting Script…" : "Export Script (.txt)"}</button>
          <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
        </div>
        <div className="hint">Status: {scriptExport.status}{scriptExport.error ? ` — ${scriptExport.error}` : ""}</div>
        {scriptExport.outputPath && <div className="hint">Output path: {scriptExport.outputPath}</div>}

        <h3>Subtitle Export</h3>
        <label className="toggleRow"><input type="checkbox" checked={subtitleIncludeDeleted} onChange={(e) => setSubtitleIncludeDeleted(e.target.checked)} />Include deleted tokens</label>
        <div className="row">
          <button onClick={() => void exportSubtitles("srt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>{subtitleExport.status === "working" && subtitleExport.format === "srt" ? "Exporting .srt…" : "Export .srt"}</button>
          <button onClick={() => void exportSubtitles("vtt")} disabled={subtitleExport.status === "working" || tokens.length === 0}>{subtitleExport.status === "working" && subtitleExport.format === "vtt" ? "Exporting .vtt…" : "Export .vtt"}</button>
        </div>
        <div className="hint">Status: {subtitleExport.status}{subtitleExport.format ? ` (${subtitleExport.format.toUpperCase()})` : ""}{subtitleExport.error ? ` — ${subtitleExport.error}` : ""}</div>
        {subtitleExport.outputPath && <div className="hint">Output path: {subtitleExport.outputPath}</div>}

        <h3>Local file picker</h3>
        <div className="pickerPanel">
          <div className="row">
            <button onClick={() => void Promise.all([loadDir("inbox", "."), loadDir("archive", ".")])}>Refresh roots</button>
            <button onClick={() => void openSelectedFile()} disabled={!selectedEntry || selectedEntry.type !== "file"}>Open selected file</button>
          </div>
          <div className="path">Selected: {selectedEntry ? `${selectedEntry.root}:/${selectedEntry.relPath === "." ? "" : selectedEntry.relPath}` : "none"}</div>
          <div className="treeRootWrap">
            <div className="treeRootHeader">📦 inbox</div>
            {renderTree("inbox", ".")}
            <div className="treeRootHeader">🗄️ archive</div>
            {renderTree("archive", ".")}
          </div>
          <div className="row">
            <label>Upload media/transcript to archive:/incoming/uploads:&nbsp;
              <input type="file" accept="video/*,.json,.txt,.vtt,.srt" onChange={(e) => void uploadFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          {pickerError && <div className="error">{pickerError}</div>}
          {uploadStatus !== "idle" && <div className="hint">Upload: {uploadStatus}</div>}
          <div className="hint">Unified explorer spans inbox + archive. Uploads are always stored in /mnt/video-archive/incoming/uploads.</div>
        </div>
      </div>

      <div className={`splitHandle ${isResizing ? "active" : ""}`} onMouseDown={() => setIsResizing(true)} role="separator" aria-orientation="vertical" />

      <div className="pane transcriptPane">
        <h2>Transcript</h2>
        <div className="hint">Click words in-line to mark/remove cuts.</div>
        <div className="hint">Playback: {currentTimeSec.toFixed(2)}s</div>
        <div className={`timingBadge ${timingMatch ? "ok" : "warn"}`}>
          {timingValid ? (timingMatch ? `Timing match ✓ (video ${videoDurationSec.toFixed(2)}s vs transcript ${transcriptDurationSec.toFixed(2)}s)` : `Timing warning ⚠ (Δ ${timingDiffSec.toFixed(2)}s · video ${videoDurationSec.toFixed(2)}s vs transcript ${transcriptDurationSec.toFixed(2)}s)`) : "Timing check pending: load video + transcript"}
        </div>

        <div className="row transcriptSearchRow">
          <input value={searchPhrase} onChange={(e) => setSearchPhrase(e.target.value)} placeholder="Search phrase in transcript" style={{ minWidth: 260, flex: 1 }} />
          <div className="hint">Matches: {Math.floor(searchedTokenIds.length / Math.max(1, normalizeText(searchPhrase).split(" ").filter(Boolean).length || 1))}</div>
          <button onClick={() => setSearchPhrase("")} disabled={!searchPhrase}>Clear</button>
          <button onClick={() => removeSearchedMatches()} disabled={searchedTokenIds.length === 0}>Toggle remove matches</button>
        </div>

        <div className="summaryCleanupRow">
          <div>
            <h3>Cut/keep summary</h3>
            <ul>
              <li>Tokens: {tokens.length}</li>
              <li>Deleted tokens: {deleted.size}</li>
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
          </div>
          <aside className="cleanupPanel">
            <h3>Smart Cleanup</h3>
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
        </div>

        <p className="transcriptParagraph">
          {tokens.map((t, index) => {
            const className = ["tokenInline", deleted.has(t.id) ? "deleted" : "", index === activeTokenIndex ? "active" : "", highlightedTokenIds.has(t.id) ? "highlighted" : ""].filter(Boolean).join(" ");
            return <span key={t.id}><button onClick={() => toggle(t.id)} className={className} title={`${t.startSec.toFixed(2)}s - ${t.endSec.toFixed(2)}s`}>{t.text}</button>{" "}</span>;
          })}
        </p>
      </div>
    </div>
  );
}
