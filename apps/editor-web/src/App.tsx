import { useEffect, useMemo, useRef, useState } from "react";
import { cutRangesFromDeletedTokens, keepRangesFromCuts, type WordToken } from "@bit-cut/core";
import { mockTranscript } from "./mockTranscript";

type RootName = "inbox" | "archive";
type BrowserEntry = {
  name: string;
  type: "dir" | "file";
  relPath: string;
  sizeBytes: number | null;
};

type BrowserState = {
  relDir: string;
  entries: BrowserEntry[];
  loading: boolean;
  error: string | null;
};

type SelectedMedia = { root: RootName; path: string; name: string } | null;

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

type PhraseMatch = {
  phrase: string;
  normalizedPhrase: string;
  tokenIds: string[];
  count: number;
};

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];
const FIXED_SMART_CLEANUP_PHRASES = [
  // Auditory
  "um",
  "uh",
  "ah",
  "er",
  "mm-hmm",
  // Crutch
  "like",
  "basically",
  "actually",
  "literally",
  "seriously",
  "honestly",
  "obviously",
  // Transitional
  "so",
  "and",
  "but",
  "anyway",
  "well",
  "now",
  // Validation
  "right?",
  "you know?",
  "okay?",
  "make sense?",
  "you see?",
  // Phrasal
  "i mean",
  "at the end of the day",
  "to be honest with you",
  "for all intents and purposes",
  "as a matter of fact",
  "it is what it is",
  // Jacob-specific frequent fillers
  "go ahead",
  "gone ahead",
  "let's go ahead",
  "we're gonna",
  "we're going to",
] as const;

function isVideoFile(name: string) {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function sanitizeBaseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

function buildPhraseMatches(tokens: WordToken[]): PhraseMatch[] {
  if (tokens.length === 0) return [];

  const normalizedTokens = tokens.map((token) => ({ token, normalized: normalizeText(token.text) })).filter((t) => t.normalized.length > 0);
  if (normalizedTokens.length === 0) return [];

  const fixedPhrases = FIXED_SMART_CLEANUP_PHRASES.map((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    return {
      phrase,
      normalizedPhrase,
      phraseParts: normalizedPhrase.split(" ").filter(Boolean),
    };
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
        for (let j = 0; j < entry.phraseParts.length; j += 1) {
          tokenIds.push(normalizedTokens[i + j]!.token.id);
        }
      }
    }

    const count = tokenIds.length / entry.phraseParts.length;
    if (count > 0) {
      results.push({
        phrase: entry.phrase,
        normalizedPhrase: entry.normalizedPhrase,
        tokenIds,
        count,
      });
    }
  }

  return results.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

function normalizeTranscript(input: unknown): WordToken[] {
  const asArray = Array.isArray(input)
    ? input
    : typeof input === "object" && input && Array.isArray((input as { tokens?: unknown[] }).tokens)
      ? (input as { tokens: unknown[] }).tokens
      : [];

  const normalized = asArray
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const token = item as Record<string, unknown>;
      const text = String(token.text ?? token.word ?? "").trim();
      const startSec = Number(token.startSec ?? token.start ?? token.start_time ?? token.startTime);
      const endSec = Number(token.endSec ?? token.end ?? token.end_time ?? token.endTime);

      if (!text || Number.isNaN(startSec) || Number.isNaN(endSec) || endSec <= startSec) {
        return null;
      }

      return {
        id: String(token.id ?? `tok-${index}`),
        text,
        startSec,
        endSec,
      } satisfies WordToken;
    })
    .filter((t): t is WordToken => Boolean(t));

  return normalized;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }
  return `${mins}m ${secs}s`;
}

function tokenAtTime(tokens: WordToken[], timeSec: number): number {
  if (tokens.length === 0) return -1;
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
    if (!out) {
      out = text;
      continue;
    }
    if (punctNoLeadSpace.test(text)) {
      out += text;
    } else if (openersNoTrailSpace.test(out.slice(-1))) {
      out += text;
    } else {
      out += ` ${text}`;
    }
  }
  return out.replace(/\s+\n/g, "\n").trim();
}

async function fetchDir(root: RootName, relDir: string): Promise<{ relDir: string; entries: BrowserEntry[] }> {
  const query = new URLSearchParams({ root, dir: relDir }).toString();
  const response = await fetch(`/api/files?${query}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export function App() {
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [tokens, setTokens] = useState<WordToken[]>(mockTranscript);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoLabel, setVideoLabel] = useState<string>("No Media Loaded");
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia>(null);
  const [exportName, setExportName] = useState<string>("edited-cut");
  const [videoDurationSec, setVideoDurationSec] = useState<number>(0);
  const [splitLeftPct, setSplitLeftPct] = useState<number>(58);
  const [isResizing, setIsResizing] = useState(false);
  const splitRef = useRef<HTMLDivElement | null>(null);

  const [transcribe, setTranscribe] = useState<TranscribeState>({
    jobId: null,
    status: "idle",
    log: [],
    transcriptRelPath: null,
    error: null,
  });
  const [exportState, setExportState] = useState<ExportState>({
    jobId: null,
    status: "idle",
    outputPath: null,
    error: null,
    log: [],
  });
  const [scriptExport, setScriptExport] = useState<ScriptExportState>({ status: "idle", outputPath: null, error: null });
  const [scriptIncludeDeleted, setScriptIncludeDeleted] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [activeTokenIndex, setActiveTokenIndex] = useState<number>(-1);
  const [previewCuts, setPreviewCuts] = useState(true);
  const [ignoredPhrases, setIgnoredPhrases] = useState<Set<string>>(new Set());
  const [highlightedPhrase, setHighlightedPhrase] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [browsers, setBrowsers] = useState<Record<RootName, BrowserState>>({
    inbox: { relDir: ".", entries: [], loading: true, error: null },
    archive: { relDir: ".", entries: [], loading: true, error: null },
  });

  useEffect(() => {
    void Promise.all([loadDir("inbox", "."), loadDir("archive", ".")]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    function onMove(event: MouseEvent) {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      setSplitLeftPct(Math.min(78, Math.max(35, pct)));
    }

    function onUp() {
      setIsResizing(false);
    }

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
      setExportState((prev) => ({
        ...prev,
        status: data.status === "running" || data.status === "queued" ? "running" : data.status,
        outputPath: data.outputPath ?? prev.outputPath,
        error: data.error ?? null,
        log: Array.isArray(data.log) ? data.log.slice(-14) : prev.log,
      }));
    }, 1200);

    return () => window.clearInterval(timer);
  }, [exportState.jobId, exportState.status]);

  useEffect(() => {
    setActiveTokenIndex(tokenAtTime(tokens, currentTimeSec));
  }, [tokens, currentTimeSec]);

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
  const visiblePhraseMatches = useMemo(
    () => phraseMatches.filter((match) => !ignoredPhrases.has(match.normalizedPhrase)),
    [phraseMatches, ignoredPhrases],
  );
  const highlightedTokenIds = useMemo(() => {
    if (!highlightedPhrase) return new Set<string>();
    const match = phraseMatches.find((item) => item.normalizedPhrase === highlightedPhrase);
    return new Set(match?.tokenIds ?? []);
  }, [highlightedPhrase, phraseMatches]);

  async function loadDir(root: RootName, relDir: string) {
    setBrowsers((prev) => ({ ...prev, [root]: { ...prev[root], loading: true, error: null } }));
    try {
      const result = await fetchDir(root, relDir);
      setBrowsers((prev) => ({
        ...prev,
        [root]: { relDir: result.relDir, entries: result.entries, loading: false, error: null },
      }));
    } catch (error) {
      setBrowsers((prev) => ({
        ...prev,
        [root]: {
          ...prev[root],
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load directory",
        },
      }));
    }
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
    const transcriptGuess = `transcripts/${sanitizeBaseName(fileName)}.json`;
    await loadTranscript(root, transcriptGuess, true);
  }

  async function onEntryClick(root: RootName, entry: BrowserEntry) {
    if (entry.type === "dir") {
      await loadDir(root, entry.relPath);
      return;
    }

    if (entry.name.toLowerCase().endsWith(".json")) {
      await loadTranscript(root, entry.relPath);
      return;
    }

    if (isVideoFile(entry.name)) {
      const query = new URLSearchParams({ root, path: entry.relPath }).toString();
      setVideoSrc(`/api/media?${query}`);
      setVideoLabel(`${root}: ${entry.relPath}`);
      setSelectedMedia({ root, path: entry.relPath, name: entry.name });
      setExportName(`${entry.name.replace(/\.[^.]+$/, "")}-edited`);
      setTranscribe({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
      setExportState({ jobId: null, status: "idle", outputPath: null, error: null, log: [] });
      await tryAutoLoadTranscript(root, entry.name);
    }
  }

  function goUp(root: RootName) {
    const current = browsers[root].relDir;
    if (current === ".") return;
    const parts = current.split("/").filter(Boolean);
    const parent = parts.length <= 1 ? "." : parts.slice(0, -1).join("/");
    void loadDir(root, parent);
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
      body: JSON.stringify({
        root: selectedMedia.root,
        path: selectedMedia.path,
        outputName: exportName,
        keepRanges: keeps,
        cuts,
      }),
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
      body: JSON.stringify({
        root: selectedMedia.root,
        path: selectedMedia.path,
        outputName: exportName,
        keepRanges: keeps,
      }),
    });

    if (!response.ok) {
      setExportState({ jobId: null, status: "error", outputPath: null, error: await response.text(), log: [] });
      return;
    }

    const data = await response.json();
    setExportState((prev) => ({
      ...prev,
      jobId: data.jobId ?? null,
      status: "done",
      outputPath: data.outputPath ?? null,
      error: null,
      log: data.downloadUrl ? [`Download: ${data.downloadUrl}\n`] : [],
    }));
  }

  async function loadLatestTranscript() {
    if (!selectedMedia) return;
    await loadTranscript(selectedMedia.root, `transcripts/${sanitizeBaseName(selectedMedia.name)}.json`);
  }


  async function exportScriptTxt() {
    const scriptBody = buildScriptBody(tokens, deleted, scriptIncludeDeleted);
    if (!scriptBody) {
      setScriptExport({ status: "error", outputPath: null, error: "Script is empty" });
      return;
    }

    const sourceMedia = selectedMedia ? `${selectedMedia.root}:${selectedMedia.path}` : "unknown";
    const durationSec = videoDurationSec > 0 ? videoDurationSec : transcriptDurationSec;
    const generatedAt = new Date().toISOString();

    const header = [
      "# Bit Cut Script Export",
      `source_media: ${sourceMedia}`,
      `duration_sec: ${durationSec.toFixed(3)}`,
      `generated_at_utc: ${generatedAt}`,
      `include_deleted_tokens: ${scriptIncludeDeleted ? "true" : "false"}`,
      "",
    ].join("\n");

    const text = `${header}\n${scriptBody}\n`;

    setScriptExport({ status: "working", outputPath: null, error: null });
    const response = await fetch("/api/script/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outputName: `${exportName || "edited"}-script`,
        text,
      }),
    });

    if (!response.ok) {
      setScriptExport({ status: "error", outputPath: null, error: await response.text() });
      return;
    }

    const data = await response.json();
    setScriptExport({ status: "done", outputPath: data.outputPath ?? null, error: null });
  }

  async function copyScriptToClipboard() {
    const text = buildScriptBody(tokens, deleted, scriptIncludeDeleted);
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }

  function toggle(id: string) {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePhraseDeletion(match: PhraseMatch) {
    setDeleted((prev) => {
      const next = new Set(prev);
      const uniqueIds = Array.from(new Set(match.tokenIds));
      const allDeleted = uniqueIds.every((id) => next.has(id));
      for (const id of uniqueIds) {
        if (allDeleted) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function ignorePhrase(match: PhraseMatch) {
    setIgnoredPhrases((prev) => {
      const next = new Set(prev);
      next.add(match.normalizedPhrase);
      return next;
    });
    setHighlightedPhrase((prev) => (prev === match.normalizedPhrase ? null : prev));
  }

  function onVideoTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const el = event.currentTarget;
    const t = el.currentTime;
    setCurrentTimeSec(t);

    const idx = tokenAtTime(tokens, t);
    setActiveTokenIndex(idx);

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

  return (
    <div className="page split" ref={splitRef} style={{ gridTemplateColumns: `${splitLeftPct}% 8px 1fr` }}>
      <div className="pane videoPane">
        <h2>Video</h2>
        <div className="hint">Selected: {videoLabel}</div>

        {videoSrc ? (
          <video
            ref={videoRef}
            controls
            src={videoSrc}
            onTimeUpdate={onVideoTimeUpdate}
            onLoadedMetadata={(e) => setVideoDurationSec(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
          />
        ) : (
          <div className="videoPlaceholder">No Media Loaded</div>
        )}

        <label className="toggleRow">
          <input type="checkbox" checked={previewCuts} onChange={(e) => setPreviewCuts(e.target.checked)} />
          Preview Cuts (skip deleted sections during playback)
        </label>

        <h3>Speech-to-text</h3>
        <div className="hint">Select a local video, then click Start Whisper STT.</div>
        <div className="row">
          <button onClick={() => void startTranscription()} disabled={!selectedMedia || transcribe.status === "running" || transcribe.status === "starting"}>
            {transcribe.status === "running" || transcribe.status === "starting" ? "Transcribing…" : "Start Whisper STT"}
          </button>
          <button onClick={() => void loadLatestTranscript()} disabled={!selectedMedia}>
            Load latest transcript
          </button>
        </div>
        <div className="hint">Status: {transcribe.status}{transcribe.phase ? ` (${transcribe.phase})` : ""}{transcribe.error ? ` — ${transcribe.error}` : ""}</div>
        {(transcribe.status === "running" || transcribe.status === "done") && (
          <>
            <progress max={100} value={transcribeProgress.pct} style={{ width: "100%", height: 12 }} />
            <div className="hint">
              {transcribeProgress.pct.toFixed(1)}% · {transcribeProgress.progressSec.toFixed(1)}s / {transcribeProgress.duration.toFixed(1)}s
              {transcribe.status === "running" && ` · ${transcribeProgress.speed.toFixed(2)}x realtime · ETA ${formatEta(transcribeProgress.remaining)}`}
            </div>
          </>
        )}
        {transcribe.transcriptRelPath && <div className="hint">Output: {transcribe.transcriptRelPath}</div>}
        {transcribe.log.length > 0 && (
          <details>
            <summary>Debug logs</summary>
            <pre>{transcribe.log.join("")}</pre>
          </details>
        )}

        <h3>Export</h3>
        <div className="row">
          <input
            value={exportName}
            onChange={(e) => setExportName(e.target.value)}
            placeholder="Output file name"
            style={{ minWidth: 220 }}
          />
          <button onClick={() => void startExport()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>
            {exportState.status === "running" || exportState.status === "starting" ? "Exporting…" : "Export Edited Video"}
          </button>
          <button onClick={() => void exportResolveFcpxml()} disabled={!selectedMedia || keeps.length === 0 || exportState.status === "running" || exportState.status === "starting"}>
            Export Resolve FCPXML
          </button>
        </div>
        <div className="hint">Status: {exportState.status}{exportState.error ? ` — ${exportState.error}` : ""}</div>
        {exportState.outputPath && <div className="hint">Output path: {exportState.outputPath}</div>}
        {exportState.log.length > 0 && (
          <details>
            <summary>Export logs</summary>
            <pre>{exportState.log.join("")}</pre>
          </details>
        )}

        <h3>Script Export</h3>
        <label className="toggleRow">
          <input type="checkbox" checked={scriptIncludeDeleted} onChange={(e) => setScriptIncludeDeleted(e.target.checked)} />
          Include deleted tokens
        </label>
        <div className="row">
          <button onClick={() => void exportScriptTxt()} disabled={scriptExport.status === "working" || tokens.length === 0}>
            {scriptExport.status === "working" ? "Exporting Script…" : "Export Script (.txt)"}
          </button>
          <button onClick={() => void copyScriptToClipboard()} disabled={tokens.length === 0}>Copy Script</button>
        </div>
        <div className="hint">Status: {scriptExport.status}{scriptExport.error ? ` — ${scriptExport.error}` : ""}</div>
        {scriptExport.outputPath && <div className="hint">Output path: {scriptExport.outputPath}</div>}

        <h3>Local file browser</h3>
        <div className="browserGrid">
          {(["inbox", "archive"] as RootName[]).map((root) => {
            const state = browsers[root];
            return (
              <div key={root} className="browserCol">
                <div className="browserHeader">
                  <strong>{root}</strong>
                  <button onClick={() => goUp(root)} disabled={state.relDir === "."}>Up</button>
                </div>
                <div className="path">/{state.relDir === "." ? "" : state.relDir}</div>
                {state.loading && <div className="hint">Loading…</div>}
                {state.error && <div className="error">{state.error}</div>}
                <ul className="fileList">
                  {state.entries.map((entry) => (
                    <li key={`${entry.type}:${entry.relPath}`}>
                      <button className="fileBtn" onClick={() => void onEntryClick(root, entry)}>
                        {entry.type === "dir" ? "📁" : "📄"} {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      <div className={`splitHandle ${isResizing ? "active" : ""}`} onMouseDown={() => setIsResizing(true)} role="separator" aria-orientation="vertical" />

      <div className="pane transcriptPane">
        <h2>Transcript</h2>
        <div className="hint">Click words in-line to mark/remove cuts. Manual transcript selection from browser remains available.</div>
        <div className="hint">Playback: {currentTimeSec.toFixed(2)}s</div>
        <div className={`timingBadge ${timingMatch ? "ok" : "warn"}`}>
          {timingValid
            ? timingMatch
              ? `Timing match ✓ (video ${videoDurationSec.toFixed(2)}s vs transcript ${transcriptDurationSec.toFixed(2)}s)`
              : `Timing warning ⚠ (Δ ${timingDiffSec.toFixed(2)}s · video ${videoDurationSec.toFixed(2)}s vs transcript ${transcriptDurationSec.toFixed(2)}s)`
            : "Timing check pending: load video + transcript"}
        </div>

        <div className="transcriptLayout">
          <p className="transcriptParagraph">
            {tokens.map((t, index) => {
              const isDeleted = deleted.has(t.id);
              const isActive = index === activeTokenIndex;
              const isHighlighted = highlightedTokenIds.has(t.id);
              const className = ["tokenInline", isDeleted ? "deleted" : "", isActive ? "active" : "", isHighlighted ? "highlighted" : ""]
                .filter(Boolean)
                .join(" ");
              return (
                <span key={t.id}>
                  <button onClick={() => toggle(t.id)} className={className} title={`${t.startSec.toFixed(2)}s - ${t.endSec.toFixed(2)}s`}>
                    {t.text}
                  </button>{" "}
                </span>
              );
            })}
          </p>

          <aside className="cleanupPanel">
            <h3>Smart Cleanup</h3>
            <div className="hint">Fixed filler words & phrases matched from transcript.</div>
            {visiblePhraseMatches.length === 0 ? (
              <div className="hint">No cleanup phrases found.</div>
            ) : (
              <ul className="cleanupList">
                {visiblePhraseMatches.map((match) => {
                  const uniqueIds = Array.from(new Set(match.tokenIds));
                  const allDeleted = uniqueIds.length > 0 && uniqueIds.every((id) => deleted.has(id));
                  const isHighlighted = highlightedPhrase === match.normalizedPhrase;
                  return (
                    <li key={match.normalizedPhrase} className="cleanupItem">
                      <div className="cleanupTitle">
                        <span>“{match.phrase}”</span>
                        <span className="count">×{match.count}</span>
                      </div>
                      <div className="cleanupActions">
                        <button onClick={() => setHighlightedPhrase((prev) => (prev === match.normalizedPhrase ? null : match.normalizedPhrase))}>
                          {isHighlighted ? "Clear highlight" : "Highlight matches"}
                        </button>
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

        <h3>Cut/keep summary</h3>
        <ul>
          <li>Tokens: {tokens.length}</li>
          <li>Deleted tokens: {deleted.size}</li>
          <li>Cut ranges: {cuts.length} ({totalCutSec.toFixed(2)}s)</li>
          <li>Keep ranges: {keeps.length} ({totalKeepSec.toFixed(2)}s)</li>
        </ul>

        <h3>Computed cut ranges</h3>
        <pre>{JSON.stringify(cuts, null, 2)}</pre>

        <h3>Computed keep ranges</h3>
        <pre>{JSON.stringify(keeps, null, 2)}</pre>
      </div>
    </div>
  );
}
