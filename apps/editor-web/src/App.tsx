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

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];

function isVideoFile(name: string) {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
  const [videoSrc, setVideoSrc] = useState<string>("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4");
  const [videoLabel, setVideoLabel] = useState<string>("Sample video");
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia>(null);
  const [exportName, setExportName] = useState<string>("edited-cut");
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
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [activeTokenIndex, setActiveTokenIndex] = useState<number>(-1);
  const [previewCuts, setPreviewCuts] = useState(false);
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
  }, [videoSrc]);

  const cuts = useMemo(() => cutRangesFromDeletedTokens(tokens, deleted), [deleted, tokens]);
  const durationSec = useMemo(() => tokens.reduce((max, t) => Math.max(max, t.endSec), 0), [tokens]);
  const keeps = useMemo(() => keepRangesFromCuts(durationSec, cuts), [cuts, durationSec]);

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

  async function loadTranscript(root: RootName, relPath: string) {
    const query = new URLSearchParams({ root, path: relPath }).toString();
    const response = await fetch(`/api/transcript?${query}`);
    if (!response.ok) {
      alert(`Failed to load transcript: ${await response.text()}`);
      return;
    }
    const data = await response.json();
    const nextTokens = normalizeTranscript(data);
    if (nextTokens.length === 0) {
      alert("No valid transcript tokens found in JSON.");
      return;
    }
    setTokens(nextTokens);
    setDeleted(new Set());
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
    const pathGuess = `transcripts/${selectedMedia.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
    await loadTranscript(selectedMedia.root, pathGuess);
  }

  function toggle(id: string) {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    <div className="page">
      <div className="pane videoPane">
        <h2>Video</h2>
        <div className="hint">Selected: {videoLabel}</div>
        <label className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={previewCuts} onChange={(e) => setPreviewCuts(e.target.checked)} />
          Preview Cuts (skip deleted sections during playback)
        </label>
        <video ref={videoRef} controls width={640} src={videoSrc} onTimeUpdate={onVideoTimeUpdate} />

        <h3>Speech-to-text</h3>
        <div className="hint">Select a local video, then click Start Whisper STT.</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
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
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
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

      <div className="pane transcriptPane">
        <h2>Transcript (click words to cut)</h2>
        <div className="hint">Load transcript by selecting any .json file or run Whisper above.</div>
        <div className="hint">Playback: {currentTimeSec.toFixed(2)}s</div>
        <div className="tokens">
          {tokens.map((t, index) => {
            const isDeleted = deleted.has(t.id);
            const isActive = index === activeTokenIndex;
            const className = ["token", isDeleted ? "deleted" : "", isActive ? "active" : ""].filter(Boolean).join(" ");
            return (
              <button key={t.id} onClick={() => toggle(t.id)} className={className} title={`${t.startSec.toFixed(2)}s - ${t.endSec.toFixed(2)}s`}>
                {t.text}
              </button>
            );
          })}
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
