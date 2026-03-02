import { useEffect, useMemo, useState } from "react";
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
  const [transcribe, setTranscribe] = useState<TranscribeState>({
    jobId: null,
    status: "idle",
    log: [],
    transcriptRelPath: null,
    error: null,
  });

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
      }));
    }, 1200);

    return () => window.clearInterval(timer);
  }, [transcribe.jobId, transcribe.status]);

  const cuts = useMemo(() => cutRangesFromDeletedTokens(tokens, deleted), [deleted, tokens]);
  const durationSec = useMemo(() => tokens.reduce((max, t) => Math.max(max, t.endSec), 0), [tokens]);
  const keeps = useMemo(() => keepRangesFromCuts(durationSec, cuts), [cuts, durationSec]);

  const totalCutSec = useMemo(() => cuts.reduce((sum, c) => sum + (c.endSec - c.startSec), 0), [cuts]);
  const totalKeepSec = useMemo(() => keeps.reduce((sum, k) => sum + (k.sourceEndSec - k.sourceStartSec), 0), [keeps]);

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
      setTranscribe({ jobId: null, status: "idle", log: [], transcriptRelPath: null, error: null });
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

  async function loadLatestTranscript() {
    if (!selectedMedia) return;
    const pathGuess = `data/transcripts/${selectedMedia.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
    await loadTranscript("inbox", pathGuess);
  }

  function toggle(id: string) {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="page">
      <div className="pane videoPane">
        <h2>Video</h2>
        <div className="hint">Selected: {videoLabel}</div>
        <video controls width={640} src={videoSrc} />

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
        <div className="hint">Status: {transcribe.status}{transcribe.error ? ` — ${transcribe.error}` : ""}</div>
        {transcribe.transcriptRelPath && <div className="hint">Output: {transcribe.transcriptRelPath}</div>}
        {transcribe.log.length > 0 && <pre>{transcribe.log.join("")}</pre>}

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
        <div className="tokens">
          {tokens.map((t) => {
            const isDeleted = deleted.has(t.id);
            return (
              <button key={t.id} onClick={() => toggle(t.id)} className={isDeleted ? "token deleted" : "token"}>
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
