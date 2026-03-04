import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { exportFcpxmlV1, type KeepRange } from "../../packages/export/src/fcpxmlV1";
import { exportEdlCmx3600 } from "../../packages/export/src/edlCmx3600";
import { exportPremiereXml } from "../../packages/export/src/premiereXml";
import { buildAafBridgeManifest, aafBridgeImporterScript } from "../../packages/export/src/aafBridge";

const REPO_ROOT = path.resolve(__dirname, "../..");
type RootName = string;
type StudioSettings = {
  roots: Array<{ id: string; name: string; path: string }>;
  uploadDir: string;
  exportDir?: string;
  transcriptDir?: string;
  projectsDir?: string;
  exportCacheHours?: number;
};

const SETTINGS_PATH = path.resolve((process.env.PRUNE_SETTINGS_PATH) || path.join(REPO_ROOT, "data", "config.json"));
const DEFAULT_SETTINGS: StudioSettings = {
  roots: [
    { id: "root-1", name: "Media", path: path.resolve((process.env.PRUNE_INBOX_ROOT) || path.resolve(REPO_ROOT, "inbox")) },
    { id: "root-2", name: "Archive", path: path.resolve((process.env.PRUNE_ARCHIVE_ROOT) || path.resolve(REPO_ROOT, "data", "archive")) },
  ],
  uploadDir: path.resolve((process.env.PRUNE_UPLOAD_DIR) || path.resolve(REPO_ROOT, "data", "uploads")),
  exportDir: (process.env.PRUNE_EXPORT_DIR),
  transcriptDir: path.resolve((process.env.PRUNE_TRANSCRIPT_DIR) || path.resolve(REPO_ROOT, "data", "transcripts")),
  projectsDir: path.resolve((process.env.PRUNE_PROJECTS_DIR) || path.resolve(REPO_ROOT, "data", "projects")),
  exportCacheHours: Number((process.env.PRUNE_EXPORT_CACHE_HOURS) || 72),
};

let studioSettings: StudioSettings = loadSettings();

function ensureManagedDirs() {
  const dirs = [
    studioSettings.uploadDir,
    studioSettings.exportDir,
    studioSettings.transcriptDir,
    studioSettings.projectsDir,
  ].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    try { fs.mkdirSync(path.resolve(dir), { recursive: true }); } catch {}
  }
}

ensureManagedDirs();

type TranscribeJob = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  root: RootName;
  relPath: string;
  transcriptRelPath: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  log: string[];
  mediaDurationSec?: number;
  phase: "queued" | "extracting" | "transcribing" | "finalizing" | "done" | "error";
  extractionProgressSec?: number;
  transcribedSec?: number;
  phaseStartedAt?: number;
  model?: string;
  device?: string;
};

type ExportJob = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  root: RootName;
  relPath: string;
  outputName: string;
  outputPath: string;
  encoder?: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  log: string[];
  expectedDurationSec?: number;
  progressSec?: number;
};

type RenderStatusSnapshot = {
  jobId: string | null;
  status: "idle" | "running" | "done" | "error";
  startedAt?: number;
  endedAt?: number;
  outputPath?: string;
  outputName?: string;
  relPath?: string;
  expectedDurationSec?: number;
  progressSec?: number;
  percent?: number | null;
  etaSec?: number | null;
  error?: string;
  lastLog?: string;
};

type RangeInput = {
  startSec?: number;
  endSec?: number;
  sourceStartSec?: number;
  sourceEndSec?: number;
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

type SubtitleTokenInput = {
  id?: string;
  text?: string;
  startSec?: number;
  endSec?: number;
};

const jobs = new Map<string, TranscribeJob>();
const exportJobs = new Map<string, ExportJob>();
const fcpxmlJobs = new Map<string, FcpxmlExportJob>();

const RENDER_STATUS_PATH = path.resolve(REPO_ROOT, "data", "render-status.json");
let latestRenderStatus: RenderStatusSnapshot = (() => {
  try {
    if (fs.existsSync(RENDER_STATUS_PATH)) {
      const raw = fs.readFileSync(RENDER_STATUS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as RenderStatusSnapshot;
    }
  } catch {}
  return { jobId: null, status: "idle" };
})();

function persistRenderStatus() {
  try {
    fs.mkdirSync(path.dirname(RENDER_STATUS_PATH), { recursive: true });
    fs.writeFileSync(RENDER_STATUS_PATH, JSON.stringify(latestRenderStatus, null, 2));
  } catch {}
}

function updateRenderStatus(patch: Partial<RenderStatusSnapshot>) {
  latestRenderStatus = { ...latestRenderStatus, ...patch };
  persistRenderStatus();
}


type FcpxmlExportJob = {
  id: string;
  status: "done" | "error";
  root: RootName;
  relPath: string;
  outputPath?: string;
  outputName: string;
  error?: string;
  fps?: number;
  timecode?: string;
  createdAt: number;
};

type EdlExportJob = {
  id: string;
  status: "done" | "error";
  root: RootName;
  relPath: string;
  outputPath?: string;
  outputName: string;
  error?: string;
  fps?: number;
  timecode?: string;
  createdAt: number;
};

type PremiereXmlExportJob = {
  id: string;
  status: "done" | "error";
  root: RootName;
  relPath: string;
  outputPath?: string;
  outputName: string;
  error?: string;
  fps?: number;
  timecode?: string;
  createdAt: number;
};

type MarkerExportJob = {
  id: string;
  status: "done" | "error";
  root: RootName;
  relPath: string;
  outputPath?: string;
  outputName: string;
  error?: string;
  createdAt: number;
};

type AafBridgeExportJob = {
  id: string;
  status: "done" | "error";
  root: RootName;
  relPath: string;
  outputPath?: string;
  outputName: string;
  error?: string;
  createdAt: number;
};

function loadSettings(): StudioSettings {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return DEFAULT_SETTINGS;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const roots = Array.isArray(raw.roots)
      ? raw.roots
        .map((r: any, idx: number) => ({ id: String(r.id || `root-${idx + 1}`), name: String(r.name || `Root ${idx + 1}`), path: path.resolve(String(r.path || "")) }))
        .filter((r: any) => r.path)
      : DEFAULT_SETTINGS.roots;
    return {
      roots: roots.length > 0 ? roots : DEFAULT_SETTINGS.roots,
      uploadDir: path.resolve(String(raw.uploadDir || DEFAULT_SETTINGS.uploadDir)),
      exportDir: raw.exportDir ? path.resolve(String(raw.exportDir)) : DEFAULT_SETTINGS.exportDir,
      transcriptDir: raw.transcriptDir ? path.resolve(String(raw.transcriptDir)) : DEFAULT_SETTINGS.transcriptDir,
      projectsDir: raw.projectsDir ? path.resolve(String(raw.projectsDir)) : DEFAULT_SETTINGS.projectsDir,
      exportCacheHours: Number(raw.exportCacheHours ?? DEFAULT_SETTINGS.exportCacheHours ?? 72),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(next: StudioSettings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  studioSettings = next;
  ensureManagedDirs();
}

function pathHealth(targetPath: string) {
  const abs = path.resolve(targetPath);
  const exists = fs.existsSync(abs);
  const isDir = exists ? fs.statSync(abs).isDirectory() : false;
  let readable = false;
  let writable = false;
  if (exists) {
    try { fs.accessSync(abs, fs.constants.R_OK); readable = true; } catch {}
    try { fs.accessSync(abs, fs.constants.W_OK); writable = true; } catch {}
  }
  return { path: abs, exists, isDir, readable, writable };
}

function getRootMap(): Record<string, string> {
  const map = Object.fromEntries(studioSettings.roots.map((r) => [r.id, path.resolve(r.path)]));
  if (studioSettings.uploadDir) map["__upload__"] = path.resolve(studioSettings.uploadDir);
  if (studioSettings.transcriptDir) map["__transcripts__"] = path.resolve(studioSettings.transcriptDir);
  map["__exports__"] = resolveExportDir();
  return map;
}

function needsSetup(): boolean {
  if (studioSettings.roots.length === 0) return true;
  return studioSettings.roots.every((r) => {
    try {
      return !(fs.existsSync(r.path) && fs.statSync(r.path).isDirectory());
    } catch {
      return true;
    }
  });
}

function safeResolve(root: RootName, relPath: string): string | null {
  const rootMap = getRootMap();
  const baseRaw = rootMap[root];
  if (!baseRaw) return null;
  const base = path.resolve(baseRaw);
  const target = path.resolve(base, relPath || ".");
  if (target === base || target.startsWith(`${base}${path.sep}`)) {
    return target;
  }
  return null;
}

function pushLog(job: { log: string[] }, line: string) {
  job.log.push(line);
  if (job.log.length > 250) job.log.shift();
}

function probeDurationSec(absInput: string): number | undefined {
  try {
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", absInput], {
      encoding: "utf-8",
    });
    const raw = (probe.stdout || "").trim();
    const duration = Number(raw);
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

function parseFfmpegTimeSec(text: string): number | undefined {
  const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return undefined;
  return hh * 3600 + mm * 60 + ss;
}

function parseWhisperProgressSec(text: string): number | undefined {
  const matches = [...text.matchAll(/\[(\d+(?::\d{2}){0,2}(?:\.\d+)?)\s*->\s*(\d+(?::\d{2}){0,2}(?:\.\d+)?)\]/g)];
  if (matches.length === 0) return undefined;
  const toSec = (stamp: string) => {
    const parts = stamp.split(":").map((v) => Number(v));
    if (parts.some((v) => !Number.isFinite(v))) return undefined;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return undefined;
  };
  let maxSec = 0;
  for (const m of matches) {
    const sec = toSec(m[2]);
    if (sec !== undefined && Number.isFinite(sec)) maxSec = Math.max(maxSec, sec);
  }
  return maxSec > 0 ? maxSec : undefined;
}

function transcribeExpectedSpeed(device: string, model: string): number {
  const d = device.toLowerCase();
  const m = model.toLowerCase();
  if (d.includes("cuda") || d.includes("gpu")) return 8;
  if (m.includes("tiny")) return 1.8;
  if (m.includes("base")) return 1.3;
  if (m.includes("small")) return 1.0;
  if (m.includes("medium")) return 0.65;
  if (m.includes("large")) return 0.4;
  return 0.8;
}

function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function resolveExportDir(): string {
  const firstRoot = studioSettings.roots[0]?.path || path.resolve(REPO_ROOT, "data", "archive");
  const preferred = path.resolve(studioSettings.exportDir || path.join(firstRoot, "exports"));
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.resolve(process.cwd(), "data", "exports");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function sanitizeOutputName(raw: string, sourceRelPath: string, extension = "mp4"): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = extension.replace(/[^a-zA-Z0-9]/g, "") || "mp4";
  return `${base || "edited"}.${ext}`;
}

function projectKey(root: string, relPath: string): string {
  return `${root}__${relPath}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeProjectName(raw: string): string {
  const name = String(raw || "Project").trim();
  return name.replace(/[^a-zA-Z0-9 _.-]/g, "_").slice(0, 80) || "Project";
}

function normalizeRange(input: RangeInput): { startSec: number; endSec: number } | null {
  const start = Number(input.sourceStartSec ?? input.startSec);
  const end = Number(input.sourceEndSec ?? input.endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null;
  return { startSec: start, endSec: end };
}

function toTimelineKeepRanges(keepRanges: Array<{ startSec: number; endSec: number }>): KeepRange[] {
  let outputStartSec = 0;
  return keepRanges.map((r) => {
    const mapped: KeepRange = {
      sourceStartSec: r.startSec,
      sourceEndSec: r.endSec,
      outputStartSec,
    };
    outputStartSec += Math.max(0, r.endSec - r.startSec);
    return mapped;
  });
}

function normalizeKeepRanges(body: { keepRanges?: RangeInput[]; cuts?: RangeInput[] }, options?: { preserveOrder?: boolean }): { startSec: number; endSec: number }[] {
  const preserveOrder = Boolean(options?.preserveOrder);
  const keeps = Array.isArray(body.keepRanges) ? body.keepRanges.map(normalizeRange).filter((v): v is { startSec: number; endSec: number } => Boolean(v)) : [];
  if (keeps.length > 0) {
    return preserveOrder ? keeps : keeps.sort((a, b) => a.startSec - b.startSec);
  }

  const cuts = Array.isArray(body.cuts) ? body.cuts.map(normalizeRange).filter((v): v is { startSec: number; endSec: number } => Boolean(v)) : [];
  if (cuts.length === 0) return [];

  const sortedCuts = cuts.sort((a, b) => a.startSec - b.startSec);
  const merged: { startSec: number; endSec: number }[] = [];
  for (const cut of sortedCuts) {
    const prev = merged[merged.length - 1];
    if (!prev || cut.startSec > prev.endSec) merged.push({ ...cut });
    else prev.endSec = Math.max(prev.endSec, cut.endSec);
  }

  const totalEnd = merged[merged.length - 1]!.endSec;
  const out: { startSec: number; endSec: number }[] = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.startSec > cursor) out.push({ startSec: cursor, endSec: cut.startSec });
    cursor = Math.max(cursor, cut.endSec);
  }
  if (cursor < totalEnd) out.push({ startSec: cursor, endSec: totalEnd });
  return out;
}

function ffmpegHasEncoder(name: string): boolean {
  try {
    const check = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf-8" });
    const text = `${check.stdout || ""}\n${check.stderr || ""}`;
    return text.includes(name);
  } catch {
    return false;
  }
}


function parseWavMono16(absWavPath: string): { sampleRate: number; samples: Float32Array } {
  const buf = fs.readFileSync(absWavPath);
  if (buf.length < 44) throw new Error("WAV too small");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid WAV header");

  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    if (chunkId === "fmt ") {
      const audioFormat = buf.readUInt16LE(chunkDataStart);
      channels = buf.readUInt16LE(chunkDataStart + 2);
      sampleRate = buf.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkDataStart + 14);
      if (audioFormat !== 1) throw new Error("Only PCM WAV is supported");
    } else if (chunkId === "data") {
      dataStart = chunkDataStart;
      dataSize = chunkSize;
      break;
    }
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataStart < 0) throw new Error("Missing WAV data chunk");
  if (channels !== 1 || bitsPerSample !== 16) throw new Error("Expected mono 16-bit WAV");

  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  return { sampleRate, samples };
}

function rollingRms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}

function detectBreathCandidates(samples: Float32Array, sampleRate: number, speechGaps: Array<{ startSec: number; endSec: number }>): AnalysisCandidate[] {
  const candidates: AnalysisCandidate[] = [];
  const win = Math.max(64, Math.round(sampleRate * 0.035));
  const stride = Math.max(32, Math.round(win / 2));
  const probeN = Math.max(win, Math.floor(Math.min(8, samples.length / sampleRate) * sampleRate));
  const baseline = rollingRms(samples, 0, probeN);
  const maxAmp = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  for (const gap of speechGaps) {
    const dur = gap.endSec - gap.startSec;
    if (dur < 0.2 || dur > 1.5) continue;
    const start = Math.max(0, Math.floor(gap.startSec * sampleRate));
    const end = Math.min(samples.length, Math.ceil(gap.endSec * sampleRate));
    if (end - start < win) continue;

    let best: { rms: number; peak: number; from: number; to: number } | null = null;
    for (let i = start; i + win <= end; i += stride) {
      const j = i + win;
      const rms = rollingRms(samples, i, j);
      let peak = 0;
      for (let k = i; k < j; k += 1) peak = Math.max(peak, Math.abs(samples[k] ?? 0));
      if (!best || rms > best.rms) best = { rms, peak, from: i, to: j };
    }
    if (!best) continue;

    const rmsRatio = baseline > 0 ? best.rms / baseline : 0;
    const peakRatio = maxAmp > 0 ? best.peak / maxAmp : 0;
    if (!(rmsRatio >= 1.3 && rmsRatio <= 3.5 && peakRatio < 0.42)) continue;

    const score = Math.min(1, Math.max(0, ((rmsRatio - 1.3) / 2.2) * 0.7 + ((0.42 - peakRatio) / 0.42) * 0.3));
    const confidence: AnalysisCandidate["confidence"] = score >= 0.72 ? "high" : score >= 0.52 ? "medium" : "low";
    if (confidence === "low") continue;

    candidates.push({
      id: `breath-${gap.startSec.toFixed(3)}-${gap.endSec.toFixed(3)}`,
      kind: "breath",
      startSec: best.from / sampleRate,
      endSec: best.to / sampleRate,
      confidence,
      score,
      reason: `gap=${dur.toFixed(2)}s rms×${rmsRatio.toFixed(2)} peak=${best.peak.toFixed(2)}`,
    });
  }

  return candidates;
}

function detectNoiseClickCandidates(samples: Float32Array, sampleRate: number): AnalysisCandidate[] {
  const absVals = new Float32Array(samples.length);
  let maxAmp = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i] ?? 0);
    absVals[i] = a;
    if (a > maxAmp) maxAmp = a;
  }
  if (maxAmp < 0.1) return [];

  const localWin = Math.max(32, Math.floor(sampleRate * 0.004));
  const candidates: AnalysisCandidate[] = [];
  for (let i = localWin; i < samples.length - localWin; i += 1) {
    const v = absVals[i] ?? 0;
    if (v < 0.55) continue;

    let localMean = 0;
    for (let j = i - localWin; j < i + localWin; j += 1) localMean += absVals[j] ?? 0;
    localMean /= localWin * 2;
    const ratio = localMean > 0 ? v / localMean : 0;
    if (ratio < 5.5) continue;

    const startSec = Math.max(0, i - Math.floor(sampleRate * 0.01)) / sampleRate;
    const endSec = Math.min(samples.length, i + Math.floor(sampleRate * 0.01)) / sampleRate;
    const score = Math.min(1, Math.max(0, ((v - 0.55) / 0.45) * 0.6 + ((ratio - 5.5) / 8) * 0.4));
    const confidence: AnalysisCandidate["confidence"] = score >= 0.8 ? "high" : score >= 0.62 ? "medium" : "low";
    if (confidence === "low") continue;

    const prev = candidates[candidates.length - 1];
    if (prev && startSec <= prev.endSec + 0.03) {
      prev.endSec = Math.max(prev.endSec, endSec);
      prev.score = Math.max(prev.score, score);
      if (confidence === "high") prev.confidence = "high";
      continue;
    }

    candidates.push({ id: `click-${startSec.toFixed(3)}`, kind: "noise_click", startSec, endSec, confidence, score, reason: `peak=${v.toFixed(2)} local×${ratio.toFixed(1)}` });
  }

  return candidates;
}

function inputHasAudio(absInput: string): boolean {
  try {
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", absInput], { encoding: "utf-8" });
    return Boolean((probe.stdout || "").trim());
  } catch {
    return false;
  }
}

function pickRate(raw: string): number | undefined {
  const value = String(raw || "").trim();
  if (!value) return undefined;
  if (value.includes("/")) {
    const [a, b] = value.split("/").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function probeFcpxmlMetadata(absInput: string): { fps: number; timecode: string; durationSec?: number } {
  const durationSec = probeDurationSec(absInput);
  try {
    const probe = spawnSync(
      "ffprobe",
      [
        "-v", "error",
        "-print_format", "json",
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate:format_tags=timecode",
        absInput,
      ],
      { encoding: "utf-8" },
    );

    const payload = JSON.parse(probe.stdout || "{}");
    const stream = Array.isArray(payload.streams)
      ? payload.streams.find((s: any) => pickRate(s?.avg_frame_rate) || pickRate(s?.r_frame_rate))
      : undefined;

    const fps =
      pickRate(stream?.avg_frame_rate) ||
      pickRate(stream?.r_frame_rate) ||
      30;

    const timecode = String(payload?.format?.tags?.timecode || "").trim() || "00:00:00:00";

    return { fps, timecode, durationSec };
  } catch {
    return { fps: 30, timecode: "00:00:00:00", durationSec };
  }
}

function probeMediaDetails(absInput: string) {
  try {
    const probe = spawnSync("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_entries",
      "format=duration,bit_rate,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,bit_rate",
      absInput,
    ], { encoding: "utf-8" });
    const payload = JSON.parse(probe.stdout || "{}");
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const v = streams.find((s: any) => s.codec_type === "video") || {};
    const a = streams.find((s: any) => s.codec_type === "audio") || {};
    const ext = path.extname(absInput).replace(".", "").toLowerCase();
    const ffprobeFormat = String(payload?.format?.format_name || "unknown");
    const primaryFormat = ffprobeFormat.split(",")[0] || ffprobeFormat;
    const container = ["mp4", "mov", "webm"].includes(ext) ? ext : primaryFormat;
    return {
      container,
      durationSec: Number(payload?.format?.duration || 0) || 0,
      bitRate: Number(payload?.format?.bit_rate || 0) || 0,
      videoCodec: String(v.codec_name || "unknown"),
      width: Number(v.width || 0) || 0,
      height: Number(v.height || 0) || 0,
      fps: pickRate(v.avg_frame_rate) || pickRate(v.r_frame_rate) || 0,
      audioCodec: String(a.codec_name || "none"),
      audioSampleRate: Number(a.sample_rate || 0) || 0,
      audioChannels: Number(a.channels || 0) || 0,
      audioBitRate: Number(a.bit_rate || 0) || 0,
    };
  } catch {
    return null;
  }
}

function sanitizeFcpxmlName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}.fcpxml`;
}

function sanitizeEdlName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}.edl`;
}

function sanitizePremiereXmlName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}-premiere.xml`;
}

function sanitizeAeMarkersName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}-ae-markers.json`;
}

function sanitizeAafName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}-aaf-bridge.zip`;
}

function sanitizeScriptName(raw: string): string {
  const base = String(raw || "script").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "script"}.txt`;
}

function sanitizeSubtitleName(raw: string, format: "srt" | "vtt", fallback = "subtitles"): string {
  const baseRaw = String(raw || fallback).replace(/\.[^.]+$/, "");
  const base = baseRaw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || fallback}.${format}`;
}

function createZipWithPython(outputPath: string, cwd: string, files: string[]) {
  const result = spawnSync("python3", ["-m", "zipfile", "-c", outputPath, ...files], {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to build zip package");
  }
}

function normalizeSubtitleTokens(raw: unknown): Array<{ id: string; text: string; startSec: number; endSec: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const token = item as SubtitleTokenInput;
      const text = String(token.text ?? "").trim();
      const startSec = Number(token.startSec);
      const endSec = Number(token.endSec);
      if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
      return { id: String(token.id ?? `tok-${index}`), text, startSec, endSec };
    })
    .filter((v): v is { id: string; text: string; startSec: number; endSec: number } => Boolean(v))
    .sort((a, b) => a.startSec - b.startSec);
}

function joinCaptionTokens(tokens: Array<{ text: string }>): string {
  const punctNoLeadSpace = /^[,.;:!?)]$/;
  const openersNoTrailSpace = /^[(]$/;
  let out = "";
  for (const token of tokens) {
    const text = token.text.trim();
    if (!text) continue;
    if (!out) out = text;
    else if (punctNoLeadSpace.test(text)) out += text;
    else if (openersNoTrailSpace.test(out.slice(-1))) out += text;
    else out += ` ${text}`;
  }
  return out.trim();
}

function buildCaptionChunks(tokens: Array<{ text: string; startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number; text: string }> {
  if (tokens.length === 0) return [];

  const maxGapSec = 0.9;
  const maxDurationSec = 4.8;
  const maxChars = 42;
  const chunks: Array<{ startSec: number; endSec: number; text: string }> = [];
  let current: typeof tokens = [];

  const pushCurrent = () => {
    if (current.length === 0) return;
    const text = joinCaptionTokens(current);
    if (!text) {
      current = [];
      return;
    }
    chunks.push({
      startSec: current[0]!.startSec,
      endSec: Math.max(current[current.length - 1]!.endSec, current[0]!.startSec + 0.05),
      text,
    });
    current = [];
  };

  for (const token of tokens) {
    if (current.length === 0) {
      current.push(token);
      continue;
    }

    const prev = current[current.length - 1]!;
    const withToken = [...current, token];
    const nextText = joinCaptionTokens(withToken);
    const gapSec = token.startSec - prev.endSec;
    const durationSec = token.endSec - current[0]!.startSec;
    const endsSentence = /[.!?]["')\]]?$/.test(joinCaptionTokens(current));
    const shouldSplit =
      gapSec > maxGapSec ||
      durationSec > maxDurationSec ||
      (nextText.length > maxChars && current.length >= 3) ||
      (endsSentence && durationSec >= 1.2);

    if (shouldSplit) pushCurrent();
    current.push(token);
  }
  pushCurrent();
  return chunks;
}

function formatTime(sec: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hh = Math.floor(totalMs / 3600000);
  const mm = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${separator}${pad3(ms)}`;
}

function buildSrt(chunks: Array<{ startSec: number; endSec: number; text: string }>): string {
  return chunks
    .map((c, i) => `${i + 1}\n${formatTime(c.startSec, ",")} --> ${formatTime(Math.max(c.endSec, c.startSec + 0.05), ",")}\n${c.text}\n`)
    .join("\n");
}

function buildVtt(chunks: Array<{ startSec: number; endSec: number; text: string }>): string {
  const body = chunks
    .map((c) => `${formatTime(c.startSec, ".")} --> ${formatTime(Math.max(c.endSec, c.startSec + 0.05), ".")}\n${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

function sanitizeUploadName(raw: string): string {
  const base = path.basename(String(raw || "upload.bin")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "upload.bin";
}

function parseMultipart(req: any): Promise<{ fields: Record<string, string>; file?: { name: string; data: Buffer } }> {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] || "");
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (!boundaryMatch) return reject(new Error("Missing multipart boundary"));
    const boundary = Buffer.from(`--${boundaryMatch[1]}`);

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const fields: Record<string, string> = {};
      let file: { name: string; data: Buffer } | undefined;

      let start = body.indexOf(boundary) + boundary.length + 2;
      while (start > boundary.length + 1 && start < body.length) {
        const nextBoundaryPos = body.indexOf(boundary, start);
        if (nextBoundaryPos === -1) break;

        const part = body.subarray(start, nextBoundaryPos - 2);
        const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
        if (headerEnd !== -1) {
          const headerText = part.subarray(0, headerEnd).toString("utf-8");
          const content = part.subarray(headerEnd + 4);

          const nameMatch = headerText.match(/name="([^"]+)"/);
          const filenameMatch = headerText.match(/filename="([^"]*)"/);
          const partName = nameMatch?.[1];
          if (partName) {
            if (filenameMatch && filenameMatch[1]) file = { name: sanitizeUploadName(filenameMatch[1]), data: content };
            else fields[partName] = content.toString("utf-8");
          }
        }

        start = nextBoundaryPos + boundary.length + 2;
      }

      resolve({ fields, file });
    });
    req.on("error", reject);
  });
}

function runFfmpeg(job: ExportJob, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args, { cwd: process.cwd() });
    proc.stdout.on("data", (d) => {
      const text = String(d);
      pushLog(job, text);
    });
    proc.stderr.on("data", (d) => {
      const text = String(d);
      pushLog(job, text);
      const sec = parseFfmpegTimeSec(text);
      if (sec !== undefined) {
        job.progressSec = Math.max(job.progressSec ?? 0, sec);
        const expected = job.expectedDurationSec;
        const percent = expected && expected > 0 ? clampPercent((job.progressSec / expected) * 100) : null;
        const elapsedSec = Math.max(1, Math.round((Date.now() - job.startedAt) / 1000));
        const speed = job.progressSec > 0 ? job.progressSec / elapsedSec : 0;
        const etaSec = expected && speed > 0 ? Math.max(0, Math.round((expected - Math.min(expected, job.progressSec)) / speed)) : null;
        updateRenderStatus({
          jobId: job.id,
          status: "running",
          progressSec: job.progressSec,
          expectedDurationSec: expected,
          percent,
          etaSec,
          lastLog: text.trim().slice(-220),
        });
      }
    });
    proc.on("close", (code) => resolve(code));
    proc.on("error", (err) => {
      pushLog(job, `${err.message}\n`);
      updateRenderStatus({ status: "error", error: err.message, endedAt: Date.now(), lastLog: err.message });
      resolve(1);
    });
  });
}

function estimateTranscribeStatus(job: TranscribeJob): { percent: number | null; etaSec: number | null; speedLabel: string | null } {
  if (job.status === "done") return { percent: 100, etaSec: 0, speedLabel: "complete" };
  if (job.status === "error") return { percent: null, etaSec: null, speedLabel: null };

  const duration = job.mediaDurationSec;
  const now = Date.now();

  if (job.phase === "extracting") {
    const p = duration && job.extractionProgressSec !== undefined ? clampPercent((job.extractionProgressSec / duration) * 35) : null;
    return {
      percent: p,
      etaSec: null,
      speedLabel: "extracting audio",
    };
  }

  if (job.phase === "transcribing") {
    const elapsedSec = Math.max(1, Math.round((now - (job.phaseStartedAt ?? job.startedAt)) / 1000));

    if (duration) {
      const processedSec = job.transcribedSec;
      if (processedSec !== undefined) {
        const speed = elapsedSec > 0 ? processedSec / elapsedSec : undefined;
        const percent = clampPercent(10 + (Math.min(duration, processedSec) / duration) * 90);
        const remainingMediaSec = Math.max(0, duration - Math.min(duration, processedSec));
        const etaSec = speed && speed > 0 ? Math.round(remainingMediaSec / speed) : null;
        return {
          percent,
          etaSec,
          speedLabel: speed && Number.isFinite(speed) ? `${speed.toFixed(2)}x realtime` : "transcribing",
        };
      }

      const warmupPct = clampPercent(Math.min(14, 10 + elapsedSec * 0.08));
      return {
        percent: warmupPct,
        etaSec: null,
        speedLabel: "warming up model",
      };
    }

    return {
      percent: null,
      etaSec: null,
      speedLabel: "transcribing",
    };
  }

  return {
    percent: job.status === "queued" ? 0 : null,
    etaSec: null,
    speedLabel: job.status === "queued" ? "queued" : null,
  };
}

type RenderOptions = {
  encoder: string;
  container: "mp4" | "mov" | "webm";
  fps?: number;
  width?: number;
  height?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

function ffmpegArgsForRanges(absInput: string, outputPath: string, keepRanges: { startSec: number; endSec: number }[], opts: RenderOptions, hasAudio: boolean): string[] {
  const trim = (n: number) => Number(n.toFixed(3));
  const size = opts.width && opts.height ? `${Math.max(2, Math.round(opts.width))}x${Math.max(2, Math.round(opts.height))}` : null;
  const audioCodec = opts.container === "webm" ? "libopus" : "aac";
  const fadeIn = Math.max(0, Number(opts.fadeInSec || 0));
  const fadeOut = Math.max(0, Number(opts.fadeOutSec || 0));
  const hasFades = fadeIn > 0 || fadeOut > 0;

  if (keepRanges.length === 1 && !hasFades) {
    const r = keepRanges[0];
    const args = ["-y", "-hide_banner", "-i", absInput, "-ss", `${trim(r.startSec)}`, "-to", `${trim(r.endSec)}`, "-c:v", opts.encoder];
    if (opts.encoder === "libx264" || opts.encoder === "libx265") args.push("-preset", "veryfast");
    if (opts.fps && opts.fps > 0) args.push("-r", `${opts.fps}`);
    if (size) args.push("-s", size);
    if (hasAudio) args.push("-c:a", audioCodec);
    else args.push("-an");
    if (opts.container === "mp4" || opts.container === "mov") args.push("-movflags", "+faststart");
    args.push(outputPath);
    return args;
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = trim(r.startSec);
    const e = trim(r.endSec);
    const duration = Math.max(0.001, e - s);
    const fadeInDur = Math.min(fadeIn, duration / 2);
    const fadeOutDur = Math.min(fadeOut, duration / 2);

    const vFilters = [`trim=start=${s}:end=${e}`, "setpts=PTS-STARTPTS"];
    if (fadeInDur > 0) vFilters.push(`fade=t=in:st=0:d=${trim(fadeInDur)}`);
    if (fadeOutDur > 0) vFilters.push(`fade=t=out:st=${trim(Math.max(0, duration - fadeOutDur))}:d=${trim(fadeOutDur)}`);
    filterParts.push(`[0:v]${vFilters.join(",")}[v${i}]`);
    concatInputs.push(`[v${i}]`);

    if (hasAudio) {
      const aFilters = [`atrim=start=${s}:end=${e}`, "asetpts=PTS-STARTPTS"];
      if (fadeInDur > 0) aFilters.push(`afade=t=in:st=0:d=${trim(fadeInDur)}`);
      if (fadeOutDur > 0) aFilters.push(`afade=t=out:st=${trim(Math.max(0, duration - fadeOutDur))}:d=${trim(fadeOutDur)}`);
      filterParts.push(`[0:a]${aFilters.join(",")}[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }
  });

  const videoConcatLabel = "vcat";
  filterParts.push(`${concatInputs.join("")}concat=n=${keepRanges.length}:v=1:a=${hasAudio ? 1 : 0}[${videoConcatLabel}]${hasAudio ? "[aout]" : ""}`);

  let videoOut = videoConcatLabel;
  if (size) {
    filterParts.push(`[${videoConcatLabel}]scale=${Math.max(2, Math.round(opts.width!))}:${Math.max(2, Math.round(opts.height!))}[vout]`);
    videoOut = "vout";
  }

  const args = ["-y", "-hide_banner", "-i", absInput, "-filter_complex", filterParts.join(";"), "-map", `[${videoOut}]`, "-c:v", opts.encoder];
  if (opts.encoder === "libx264" || opts.encoder === "libx265") args.push("-preset", "veryfast");
  if (opts.fps && opts.fps > 0) args.push("-r", `${opts.fps}`);
  if (hasAudio) {
    args.push("-map", "[aout]", "-c:a", audioCodec);
  } else {
    args.push("-an");
  }
  if (opts.container === "mp4" || opts.container === "mov") args.push("-movflags", "+faststart");
  args.push(outputPath);
  return args;
}

function studioApiPlugin(): Plugin {
  return {
    name: "studio-local-api",
    configureServer(server) {
      server.middlewares.use("/api/settings", async (req, res) => {
        try {
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ...studioSettings, needsSetup: needsSetup() }));
            return;
          }
          if (req.method === "POST") {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            await new Promise((resolve) => req.on("end", resolve));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const roots = Array.isArray(body.roots)
              ? body.roots
                .map((r: any, idx: number) => ({ id: `root-${idx + 1}`, name: String(r.name || `Root ${idx + 1}`), path: path.resolve(String(r.path || "")) }))
                .filter((r: any) => r.path)
              : [];
            if (roots.length === 0) {
              res.statusCode = 400;
              res.end("At least one root is required");
              return;
            }
            for (const root of roots) {
              if (!fs.existsSync(root.path) || !fs.statSync(root.path).isDirectory()) {
                res.statusCode = 400;
                res.end(`Root not found or not a directory: ${root.path}`);
                return;
              }
            }
            const next: StudioSettings = {
              roots,
              uploadDir: path.resolve(String(body.uploadDir || DEFAULT_SETTINGS.uploadDir)),
              exportDir: body.exportDir ? path.resolve(String(body.exportDir)) : undefined,
              transcriptDir: body.transcriptDir ? path.resolve(String(body.transcriptDir)) : undefined,
              projectsDir: body.projectsDir ? path.resolve(String(body.projectsDir)) : undefined,
              exportCacheHours: Number(body.exportCacheHours || 72),
            };
            saveSettings(next);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, ...studioSettings, needsSetup: needsSetup() }));
            return;
          }
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method not allowed" }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to read/save settings" }));
        }
      });

      server.middlewares.use("/api/settings/health", async (_req, res) => {
        try {
          const roots = studioSettings.roots.map((r) => ({ id: r.id, name: r.name, ...pathHealth(r.path) }));
          const firstRoot = studioSettings.roots[0]?.path || process.cwd();
          const uploadPath = studioSettings.uploadDir || path.join(firstRoot, "uploads");
          const exportPath = studioSettings.exportDir || path.join(firstRoot, "exports");
          const transcriptPath = studioSettings.transcriptDir || path.join(firstRoot, "transcripts");
          const projectsPath = studioSettings.projectsDir || path.join(firstRoot, "projects");
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ roots, upload: pathHealth(uploadPath), export: pathHealth(exportPath), transcripts: pathHealth(transcriptPath), projects: pathHealth(projectsPath) }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed health check" }));
        }
      });

      server.middlewares.use("/api/system/dirs", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const requested = url.searchParams.get("path") || "/";
          const includeHidden = ["1", "true", "yes"].includes(String(url.searchParams.get("hidden") || "").toLowerCase());
          const abs = path.resolve(requested);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }

          const entries = fs.readdirSync(abs, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && (includeHidden || !entry.name.startsWith(".")))
            .map((entry) => ({
              name: entry.name,
              path: path.join(abs, entry.name),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

          const parent = abs === path.parse(abs).root ? null : path.dirname(abs);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ path: abs, parent, dirs: entries }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to list directories" }));
        }
      });

      server.middlewares.use("/api/system/mkdir", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const basePath = path.resolve(String(body.path || "/"));
          const name = String(body.name || "").trim();
          if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid folder name" }));
            return;
          }
          if (!fs.existsSync(basePath) || !fs.statSync(basePath).isDirectory()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Base directory not found" }));
            return;
          }
          const target = path.join(basePath, name);
          fs.mkdirSync(target, { recursive: false });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, path: target }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to create folder" }));
        }
      });

      server.middlewares.use("/api/project/save", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const root = String(body.root || "");
          const relPath = String(body.path || "");
          if (!root || !relPath) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing root/path" }));
            return;
          }
          const key = projectKey(root, relPath);
          fs.mkdirSync(projectsDir(), { recursive: true });
          const id = String(body.projectId || crypto.randomUUID());
          const projectName = sanitizeProjectName(String(body.projectName || path.basename(relPath)));
          const payload = {
            ...body,
            projectId: id,
            projectName,
            root,
            path: relPath,
            key,
            updatedAt: new Date().toISOString(),
          };
          const out = path.join(projectsDir(), `${id}.json`);
          fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf-8");
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, projectId: id, projectName, outputPath: out }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to save project" }));
        }
      });

      server.middlewares.use("/api/project/list", async (_req, res) => {
        try {
          fs.mkdirSync(projectsDir(), { recursive: true });
          const files = fs.readdirSync(projectsDir()).filter((n) => n.endsWith(".json"));
          const projects = files.map((name) => {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(projectsDir(), name), "utf-8"));
              return {
                projectId: data.projectId || path.basename(name, ".json"),
                projectName: data.projectName || "Project",
                root: data.root,
                path: data.path,
                updatedAt: data.updatedAt || null,
              };
            } catch {
              return null;
            }
          }).filter(Boolean).sort((a: any, b: any) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ projects }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to list projects" }));
        }
      });

      server.middlewares.use("/api/project/delete", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const projectId = String(body.projectId || "");
          if (!projectId) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing projectId" }));
            return;
          }
          const file = path.join(projectsDir(), `${projectId}.json`);
          if (fs.existsSync(file)) fs.unlinkSync(file);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to delete project" }));
        }
      });

      server.middlewares.use("/api/project/load", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const projectId = String(url.searchParams.get("projectId") || "");
          if (projectId) {
            const file = path.join(projectsDir(), `${projectId}.json`);
            if (!fs.existsSync(file)) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "Project not found" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(fs.readFileSync(file, "utf-8"));
            return;
          }

          const root = String(url.searchParams.get("root") || "");
          const relPath = String(url.searchParams.get("path") || "");
          if (!root || !relPath) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing root/path" }));
            return;
          }

          fs.mkdirSync(projectsDir(), { recursive: true });
          const files = fs.readdirSync(projectsDir()).filter((n) => n.endsWith(".json"));
          for (const name of files) {
            const file = path.join(projectsDir(), name);
            try {
              const data = JSON.parse(fs.readFileSync(file, "utf-8"));
              if (String(data.root) === root && String(data.path) === relPath) {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(data));
                return;
              }
            } catch {}
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Project not found" }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to load project" }));
        }
      });

      server.middlewares.use("/api/files", async (req, res, next) => {
        try {
          if (req.method !== "GET") {
            next();
            return;
          }
          const url = new URL(req.url ?? "", "http://localhost");
          const root = (url.searchParams.get("root") ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relDir = url.searchParams.get("dir") ?? ".";
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          const absDir = safeResolve(root, relDir);
          if (root === "__upload__" && absDir && !fs.existsSync(absDir)) {
            try { fs.mkdirSync(absDir, { recursive: true }); } catch {}
          }
          if (!absDir || !fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }

          const entries = fs
            .readdirSync(absDir, { withFileTypes: true })
            .map((entry) => {
              const absPath = path.join(absDir, entry.name);
              const stat = fs.statSync(absPath);
              return {
                name: entry.name,
                type: entry.isDirectory() ? "dir" : "file",
                relPath: path.relative(rootMap[root]!, absPath) || ".",
                sizeBytes: entry.isDirectory() ? null : stat.size,
              };
            })
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ root, relDir, entries }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to list files" }));
        }
      });

      server.middlewares.use("/api/files/delete", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const root = String(body.root || "") as RootName;
          const relPath = String(body.path || "");
          const absPath = safeResolve(root, relPath);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "File not found" }));
            return;
          }
          fs.unlinkSync(absPath);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to delete file" }));
        }
      });

      server.middlewares.use("/api/files/upload", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const { file } = await parseMultipart(req);
          const root: RootName = "__upload__";
          const rootMap = getRootMap();

          if (!file) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing upload file" }));
            return;
          }

          if (!rootMap[root]) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No upload root configured" }));
            return;
          }

          const uploadTargetDir = path.resolve(studioSettings.uploadDir || path.join(rootMap[root]!, "uploads"));
          fs.mkdirSync(uploadTargetDir, { recursive: true });
          let outputName = file.name;
          let outputPath = path.join(uploadTargetDir, outputName);
          let count = 1;
          while (fs.existsSync(outputPath)) {
            const ext = path.extname(file.name);
            const base = path.basename(file.name, ext);
            outputName = `${base}-${count}${ext}`;
            outputPath = path.join(uploadTargetDir, outputName);
            count += 1;
          }

          fs.writeFileSync(outputPath, file.data);
          const relPath = path.relative(rootMap[root]!, outputPath) || outputName;
          const relDir = path.dirname(relPath) === "." ? "." : path.dirname(relPath);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ root, relDir, relPath, savedPath: outputPath, sizeBytes: file.data.length }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed upload" }));
        }
      });

      server.middlewares.use("/api/transcript", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = (url.searchParams.get("root") ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = url.searchParams.get("path") ?? "";
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          const absPath = safeResolve(root, relPath);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Transcript not found" }));
            return;
          }

          const content = fs.readFileSync(absPath, "utf-8");
          const json = JSON.parse(content);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(json));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to load transcript JSON" }));
        }
      });

      server.middlewares.use("/api/analyze/suggest-cuts", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const detectBreaths = Boolean(body.detectBreaths ?? true);
          const detectNoiseClicks = Boolean(body.detectNoiseClicks ?? true);
          const tokenGaps = Array.isArray(body.tokenGaps) ? body.tokenGaps : [];
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (!detectBreaths && !detectNoiseClicks) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ candidates: [] }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const baseName = path.basename(relPath, path.extname(relPath)).replace(/[^a-zA-Z0-9._-]/g, "_");
          const wavPath = path.resolve(REPO_ROOT, "data", "audio", `${baseName}.analysis.wav`);
          fs.mkdirSync(path.dirname(wavPath), { recursive: true });

          if (!fs.existsSync(wavPath) || fs.statSync(wavPath).mtimeMs < fs.statSync(absMedia).mtimeMs) {
            const extractScript = path.resolve(REPO_ROOT, "scripts", "extract-audio-wav.sh");
            const ff = spawnSync("bash", [extractScript, absMedia, wavPath], { cwd: REPO_ROOT, encoding: "utf-8" });
            if (ff.status !== 0) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: "Audio extraction failed", detail: String(ff.stderr || ff.stdout || "") }));
              return;
            }
          }

          const { sampleRate, samples } = parseWavMono16(wavPath);
          const gaps = tokenGaps
            .map((gap: any) => ({ startSec: Number(gap.startSec), endSec: Number(gap.endSec) }))
            .filter((g: any) => Number.isFinite(g.startSec) && Number.isFinite(g.endSec) && g.endSec > g.startSec);

          const candidates: AnalysisCandidate[] = [];
          if (detectBreaths) candidates.push(...detectBreathCandidates(samples, sampleRate, gaps));
          if (detectNoiseClicks) candidates.push(...detectNoiseClickCandidates(samples, sampleRate));

          const sorted = candidates
            .sort((a, b) => a.startSec - b.startSec || b.score - a.score)
            .slice(0, 300);

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            candidates: sorted,
            summary: {
              breaths: sorted.filter((c) => c.kind === "breath").length,
              noiseClicks: sorted.filter((c) => c.kind === "noise_click").length,
            },
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to run analysis" }));
        }
      });

      server.middlewares.use("/api/media/probe", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = String(url.searchParams.get("root") || "");
          const relPath = String(url.searchParams.get("path") || "");
          const rootMap = getRootMap();
          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }
          const absPath = safeResolve(root, relPath);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "File not found" }));
            return;
          }
          const details = probeMediaDetails(absPath);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ details }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to probe media" }));
        }
      });

      server.middlewares.use("/api/gallery/list", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const scope = String(url.searchParams.get("scope") || "both");
          const showAll = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("showAll") || "").toLowerCase());
          const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
          const sort = String(url.searchParams.get("sort") || "date_desc");
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 20), 5000);

          const rootMap = getRootMap();
          const targets: Array<{ root: string; dir: string; kind: "original" | "export" }> = [];
          if (scope === "originals" || scope === "both") {
            if (rootMap["__upload__"]) targets.push({ root: "__upload__", dir: rootMap["__upload__"], kind: "original" });
          }
          if (scope === "exports" || scope === "both") {
            if (rootMap["__exports__"]) targets.push({ root: "__exports__", dir: rootMap["__exports__"], kind: "export" });
          }

          const mediaExt = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"]);
          const walk = (start: string): string[] => {
            const out: string[] = [];
            const queue = [start];
            while (queue.length > 0) {
              const current = queue.shift()!;
              let entries: fs.Dirent[] = [];
              try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
              for (const entry of entries) {
                if (entry.name.startsWith(".")) continue;
                const abs = path.join(current, entry.name);
                if (entry.isDirectory()) {
                  queue.push(abs);
                  continue;
                }
                if (!entry.isFile()) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (!showAll && !mediaExt.has(ext)) continue;
                out.push(abs);
                if (out.length >= limit) return out;
              }
            }
            return out;
          };

          const items: Array<any> = [];
          for (const target of targets) {
            const files = walk(target.dir);
            for (const absPath of files) {
              try {
                const relPath = path.relative(target.dir, absPath);
                const stat = fs.statSync(absPath);
                const ext = path.extname(absPath).toLowerCase();
                const isVideo = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext);
                const isAudio = [".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"].includes(ext);
                const durationSec = (isVideo || isAudio) ? (probeDurationSec(absPath) ?? null) : null;
                items.push({
                  id: `${target.root}:${relPath}`,
                  root: target.root,
                  relPath,
                  name: path.basename(absPath),
                  kind: target.kind,
                  sizeBytes: stat.size,
                  modifiedAt: stat.mtime.toISOString(),
                  durationSec,
                  isVideo,
                  isAudio,
                  mediaUrl: `/api/media?${new URLSearchParams({ root: target.root, path: relPath }).toString()}`,
                  thumbUrl: isVideo
                    ? `/api/gallery/thumb?${new URLSearchParams({ root: target.root, path: relPath, v: String(stat.mtimeMs) }).toString()}`
                    : null,
                });
              } catch {
                // skip files that disappear or fail to probe while listing
                continue;
              }
            }
          }

          let filtered = items;
          if (query) filtered = filtered.filter((item) => item.name.toLowerCase().includes(query));
          filtered.sort((a, b) => {
            if (sort === "name_asc") return a.name.localeCompare(b.name);
            if (sort === "name_desc") return b.name.localeCompare(a.name);
            if (sort === "duration_desc") return Number(b.durationSec || 0) - Number(a.durationSec || 0);
            if (sort === "duration_asc") return Number(a.durationSec || 0) - Number(b.durationSec || 0);
            if (sort === "size_desc") return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
            if (sort === "size_asc") return Number(a.sizeBytes || 0) - Number(b.sizeBytes || 0);
            if (sort === "date_asc") return new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
            return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
          });

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ items: filtered.slice(0, limit) }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to load gallery" }));
        }
      });

      server.middlewares.use("/api/gallery/thumb", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = String(url.searchParams.get("root") || "");
          const relPath = String(url.searchParams.get("path") || "");
          const rootMap = getRootMap();
          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end("Invalid root");
            return;
          }
          const absPath = safeResolve(root as RootName, relPath);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.statusCode = 404;
            res.end("File not found");
            return;
          }

          const thumbsDir = path.resolve(REPO_ROOT, "data", "thumbs");
          fs.mkdirSync(thumbsDir, { recursive: true });
          const stat = fs.statSync(absPath);
          const hash = crypto.createHash("sha1").update(`${root}:${relPath}:${stat.mtimeMs}`).digest("hex").slice(0, 20);
          const thumbPath = path.join(thumbsDir, `${hash}.jpg`);

          if (!fs.existsSync(thumbPath)) {
            const firstTry = spawnSync("ffmpeg", [
              "-y", "-hide_banner", "-loglevel", "error",
              "-ss", "0.8",
              "-i", absPath,
              "-frames:v", "1",
              "-vf", "scale=480:-1",
              thumbPath,
            ], { encoding: "utf-8" });
            if (firstTry.status !== 0 || !fs.existsSync(thumbPath)) {
              const fallbackTry = spawnSync("ffmpeg", [
                "-y", "-hide_banner", "-loglevel", "error",
                "-i", absPath,
                "-frames:v", "1",
                "-vf", "scale=480:-1",
                thumbPath,
              ], { encoding: "utf-8" });
              if (fallbackTry.status !== 0 || !fs.existsSync(thumbPath)) {
                res.statusCode = 404;
                res.end("Thumbnail unavailable");
                return;
              }
            }
          }

          const thumbStat = fs.statSync(thumbPath);
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": thumbStat.size,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          fs.createReadStream(thumbPath).pipe(res);
        } catch {
          res.statusCode = 500;
          res.end("Failed to load thumbnail");
        }
      });

      server.middlewares.use("/api/media", async (req, res) => {
        const send = (code: number, msg: string) => {
          res.statusCode = code;
          res.end(msg);
        };

        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = (url.searchParams.get("root") ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = url.searchParams.get("path") ?? "";
          const rootMap = getRootMap();

          if (!(root in rootMap)) return send(400, "Invalid root");

          const absPath = safeResolve(root, relPath);
          if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return send(404, "File not found");

          const stat = fs.statSync(absPath);
          const range = req.headers.range;
          const contentType =
            path.extname(absPath).toLowerCase() === ".mp4" ? "video/mp4" : "application/octet-stream";

          if (range) {
            const [startText, endText] = range.replace(/bytes=/, "").split("-");
            const start = Number.parseInt(startText, 10);
            const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;
            const chunkSize = end - start + 1;
            const stream = fs.createReadStream(absPath, { start, end });
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${stat.size}`,
              "Accept-Ranges": "bytes",
              "Content-Length": chunkSize,
              "Content-Type": contentType,
            });
            stream.pipe(res);
            return;
          }

          res.writeHead(200, {
            "Content-Length": stat.size,
            "Content-Type": contentType,
            "Accept-Ranges": "bytes",
          });
          fs.createReadStream(absPath).pipe(res);
        } catch {
          send(500, "Failed to read media");
        }
      });

      server.middlewares.use("/api/transcribe/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const model = String(body.model ?? "small");
          const device = String(body.device ?? "cpu");
          const computeType = String(body.computeType ?? "int8");
          const language = String(body.language ?? "en");
          const beamSize = Math.max(1, Number(body.beamSize ?? 1));
          const vadFilter = Boolean(body.vadFilter ?? false);
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const baseName = path.basename(relPath, path.extname(relPath));
          const cleanName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
          const transcriptRoot = path.resolve(studioSettings.transcriptDir || DEFAULT_SETTINGS.transcriptDir || path.resolve(REPO_ROOT, "data", "transcripts"));
          const transcriptRelPath = `${cleanName}.json`;
          const transcriptAbsPath = path.resolve(transcriptRoot, transcriptRelPath);

          const id = crypto.randomUUID();
          const job: TranscribeJob = {
            id,
            status: "queued",
            root,
            relPath,
            transcriptRelPath,
            startedAt: Date.now(),
            log: [],
            phase: "queued",
            model,
            device,
          };
          jobs.set(id, job);

          const venvPython = path.resolve(REPO_ROOT, ".venv", "bin", "python3");
          const hasVenv = fs.existsSync(venvPython);
          const transcribeScript = path.resolve(REPO_ROOT, "scripts", "transcribe_whisper.py");
          const command = hasVenv ? `${venvPython} ${transcribeScript}` : `python3 ${transcribeScript}`;

          const wavPath = path.resolve(REPO_ROOT, "data", "audio", `${cleanName}.wav`);
          fs.mkdirSync(path.dirname(wavPath), { recursive: true });
          fs.mkdirSync(path.dirname(transcriptAbsPath), { recursive: true });

          job.status = "running";
          job.phase = "extracting";
          job.phaseStartedAt = Date.now();
          job.mediaDurationSec = probeDurationSec(absMedia);
          pushLog(job, `Extracting audio from ${relPath}\n`);

          const extractScript = path.resolve(REPO_ROOT, "scripts", "extract-audio-wav.sh");
          const ff = spawn("bash", [extractScript, absMedia, wavPath], {
            cwd: REPO_ROOT,
          });

          ff.stdout.on("data", (d) => {
            const text = String(d);
            const sec = parseFfmpegTimeSec(text);
            if (sec !== undefined) {
              job.extractionProgressSec = Math.max(job.extractionProgressSec ?? 0, sec);
            }
            pushLog(job, text);
          });
          ff.stderr.on("data", (d) => {
            const text = String(d);
            const sec = parseFfmpegTimeSec(text);
            if (sec !== undefined) {
              job.extractionProgressSec = Math.max(job.extractionProgressSec ?? 0, sec);
            }
            pushLog(job, text);
          });

          ff.on("close", (ffCode) => {
            if (ffCode !== 0) {
              job.status = "error";
              job.phase = "error";
              job.exitCode = ffCode;
              job.error = `Audio extraction failed (${ffCode})`;
              job.endedAt = Date.now();
              return;
            }

            job.phase = "transcribing";
            job.phaseStartedAt = Date.now();
            if (job.mediaDurationSec !== undefined) {
              job.extractionProgressSec = job.mediaDurationSec;
            }
            pushLog(job, `Running Whisper (${model}, ${device}, ${computeType}, beam=${beamSize}${vadFilter ? ", vad" : ""})`);

            const tr = spawn("bash", ["-lc", `${command} "${wavPath}" --model "${model}" --device "${device}" --compute-type "${computeType}" --beam-size "${beamSize}" ${vadFilter ? "--vad-filter" : ""} --language "${language}" --out "${transcriptAbsPath}"`], {
              cwd: REPO_ROOT,
            });

            tr.stdout.on("data", (d) => {
              const text = String(d);
              const sec = parseWhisperProgressSec(text);
              if (sec !== undefined) {
                job.transcribedSec = Math.max(job.transcribedSec ?? 0, sec);
              }
              pushLog(job, text);
            });
            tr.stderr.on("data", (d) => {
              const text = String(d);
              const sec = parseWhisperProgressSec(text);
              if (sec !== undefined) {
                job.transcribedSec = Math.max(job.transcribedSec ?? 0, sec);
              }
              pushLog(job, text);
            });
            tr.on("close", (trCode) => {
              job.exitCode = trCode;
              job.endedAt = Date.now();
              if (trCode === 0) {
                job.status = "done";
                job.phase = "done";
                if (job.mediaDurationSec !== undefined) job.transcribedSec = job.mediaDurationSec;
                pushLog(job, `Done: ${transcriptRelPath}`);
              } else {
                job.status = "error";
                job.phase = "error";
                job.error = `Whisper failed (${trCode})`;
              }
            });
          });

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ jobId: id, status: job.status }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to start transcription" }));
        }
      });

      server.middlewares.use("/api/transcribe/status", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = jobs.get(id);
          if (!job) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Job not found" }));
            return;
          }
          const progress = estimateTranscribeStatus(job);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ...job, percent: progress.percent, etaSec: progress.etaSec, speedLabel: progress.speedLabel }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to fetch status" }));
        }
      });

      server.middlewares.use("/api/export/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const render = body.render || {};
          const container = ["mp4", "mov", "webm"].includes(String(render.container || "").toLowerCase()) ? String(render.container).toLowerCase() as "mp4" | "mov" | "webm" : "mp4";
          const codec = String(render.codec || "h264").toLowerCase();
          const fps = Number(render.fps || 0);
          const width = Number(render.width || 0);
          const height = Number(render.height || 0);
          const outputName = sanitizeOutputName(String(body.outputName ?? ""), relPath, container);
          const sequenceMode = String(body.sequenceMode || "timeline").toLowerCase();
          const keepRanges = normalizeKeepRanges(body, { preserveOrder: sequenceMode === "fun" });
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (keepRanges.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid keepRanges/cuts provided" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const exportDir = resolveExportDir();
          const id = crypto.randomUUID();
          const outputPath = path.join(exportDir, outputName);

          const expectedDurationSec = Math.max(0, keepRanges.reduce((sum, r) => sum + Math.max(0, r.endSec - r.startSec), 0));
          const job: ExportJob = {
            id,
            status: "queued",
            root,
            relPath,
            outputName,
            outputPath,
            startedAt: Date.now(),
            log: [],
            expectedDurationSec,
            progressSec: 0,
          };
          exportJobs.set(id, job);

          job.status = "running";
          updateRenderStatus({
            jobId: id,
            status: "running",
            startedAt: job.startedAt,
            endedAt: undefined,
            outputPath,
            outputName,
            relPath,
            expectedDurationSec,
            progressSec: 0,
            percent: 0,
            etaSec: null,
            error: undefined,
            lastLog: `Rendering ${relPath}`,
          });
          const hasAudio = inputHasAudio(absMedia);
          pushLog(job, `Rendering ${relPath} -> ${outputPath}\n`);
          pushLog(job, `Detected audio stream: ${hasAudio ? "yes" : "no"}\n`);

          const encoderCandidates: string[] = codec === "h264"
            ? [ffmpegHasEncoder("h264_qsv") ? "h264_qsv" : "", "libx264"]
            : codec === "h265"
              ? [ffmpegHasEncoder("hevc_qsv") ? "hevc_qsv" : "", "libx265"]
              : codec === "vp8"
                ? ["libvpx"]
                : codec === "vp9"
                  ? ["libvpx-vp9"]
                  : ["prores_ks"];

          let finalCode: number | null = 1;
          for (const enc of encoderCandidates.filter(Boolean)) {
            job.encoder = enc;
            pushLog(job, `Encoder attempt: ${enc}\n`);
            const code = await runFfmpeg(job, ffmpegArgsForRanges(absMedia, outputPath, keepRanges, {
              encoder: enc,
              container,
              fps: fps > 0 ? fps : undefined,
              width: width > 0 ? width : undefined,
              height: height > 0 ? height : undefined,
              fadeInSec: Math.max(0, Number(render.fadeInSec || 0)),
              fadeOutSec: Math.max(0, Number(render.fadeOutSec || 0)),
            }, hasAudio));
            finalCode = code;
            if (code === 0) break;
            pushLog(job, `${enc} failed (${code})\n`);
          }

          job.exitCode = finalCode;
          job.endedAt = Date.now();
          if (finalCode === 0) {
            job.status = "done";
            pushLog(job, `Done: ${outputPath}\n`);
            updateRenderStatus({
              jobId: id,
              status: "done",
              endedAt: job.endedAt,
              outputPath,
              outputName,
              relPath,
              expectedDurationSec,
              progressSec: expectedDurationSec,
              percent: 100,
              etaSec: 0,
              error: undefined,
              lastLog: `Done: ${path.basename(outputPath)}`,
            });
          } else {
            job.status = "error";
            job.error = `ffmpeg failed (${finalCode})`;
            updateRenderStatus({
              jobId: id,
              status: "error",
              endedAt: job.endedAt,
              outputPath,
              outputName,
              relPath,
              expectedDurationSec,
              progressSec: job.progressSec ?? 0,
              percent: expectedDurationSec > 0 ? clampPercent(((job.progressSec ?? 0) / expectedDurationSec) * 100) : null,
              etaSec: null,
              error: job.error,
              lastLog: job.log.length ? String(job.log[job.log.length - 1]).trim().slice(-220) : job.error,
            });
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ jobId: id, status: job.status, outputPath: job.outputPath }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to start export" }));
        }
      });

      server.middlewares.use("/api/export/fcpxml/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizeFcpxmlName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (keepRanges.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid keepRanges/cuts provided" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const exportDir = resolveExportDir();
          const outputPath = path.join(exportDir, outputName);
          const sourceMetadata = probeFcpxmlMetadata(absMedia);

          const fcpxml = exportFcpxmlV1(
            toTimelineKeepRanges(keepRanges),
            {
              path: absMedia,
              fps: sourceMetadata.fps,
              timecode: sourceMetadata.timecode,
              durationSec: sourceMetadata.durationSec,
              name: path.basename(absMedia),
            },
            {
              projectName: path.basename(outputName, ".fcpxml"),
              sequenceName: path.basename(outputName, ".fcpxml"),
              eventName: "prune",
            },
          );

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, fcpxml, "utf-8");

          const id = crypto.randomUUID();
          const job: FcpxmlExportJob = {
            id,
            status: "done",
            root,
            relPath,
            outputPath,
            outputName,
            createdAt: Date.now(),
            fps: sourceMetadata.fps,
            timecode: sourceMetadata.timecode,
          };
          fcpxmlJobs.set(id, job);

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            jobId: id,
            status: job.status,
            outputPath: outputPath,
            downloadUrl: `/api/export/fcpxml/download?jobId=${id}`,
            metadata: { fps: sourceMetadata.fps, timecode: sourceMetadata.timecode },
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to export FCPXML" }));
        }
      });

      server.middlewares.use("/api/export/fcpxml/download", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = fcpxmlJobs.get(id);
          if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Export not found" }));
            return;
          }

          const content = fs.readFileSync(job.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/xml; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.outputPath)}"`);
          res.end(content);
          try { fs.unlinkSync(job.outputPath); } catch {}
          fcpxmlJobs.delete(id);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download FCPXML" }));
        }
      });

      server.middlewares.use("/api/export/edl/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizeEdlName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (keepRanges.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid keepRanges/cuts provided" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const exportDir = resolveExportDir();
          const outputPath = path.join(exportDir, outputName);
          const sourceMetadata = probeFcpxmlMetadata(absMedia);

          const edl = exportEdlCmx3600(
            toTimelineKeepRanges(keepRanges),
            {
              path: absMedia,
              fps: sourceMetadata.fps,
              timecode: sourceMetadata.timecode,
              durationSec: sourceMetadata.durationSec,
              name: path.basename(absMedia),
            },
            {
              title: path.basename(outputName, ".edl"),
              reel: path.basename(absMedia, path.extname(absMedia)),
            },
          );

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, edl, "utf-8");

          const id = crypto.randomUUID();
          const job: EdlExportJob = {
            id,
            status: "done",
            root,
            relPath,
            outputPath,
            outputName,
            createdAt: Date.now(),
            fps: sourceMetadata.fps,
            timecode: sourceMetadata.timecode,
          };
          edlJobs.set(id, job);

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            jobId: id,
            status: job.status,
            outputPath,
            downloadUrl: `/api/export/edl/download?jobId=${id}`,
            metadata: { fps: sourceMetadata.fps, timecode: sourceMetadata.timecode },
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to export EDL" }));
        }
      });

      server.middlewares.use("/api/export/edl/download", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = edlJobs.get(id);
          if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Export not found" }));
            return;
          }

          const content = fs.readFileSync(job.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.outputPath)}"`);
          res.end(content);
          try { fs.unlinkSync(job.outputPath); } catch {}
          edlJobs.delete(id);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download EDL" }));
        }
      });

      server.middlewares.use("/api/export/premiere/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizePremiereXmlName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (keepRanges.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid keepRanges/cuts provided" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const exportDir = resolveExportDir();
          const outputPath = path.join(exportDir, outputName);
          const sourceMetadata = probeFcpxmlMetadata(absMedia);

          const premiereXml = exportPremiereXml(
            toTimelineKeepRanges(keepRanges),
            {
              path: absMedia,
              fps: sourceMetadata.fps,
              timecode: sourceMetadata.timecode,
              durationSec: sourceMetadata.durationSec,
              name: path.basename(absMedia),
            },
            {
              projectName: path.basename(outputName, ".xml"),
              sequenceName: path.basename(outputName, ".xml"),
            },
          );

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, premiereXml, "utf-8");

          const id = crypto.randomUUID();
          const job: PremiereXmlExportJob = {
            id,
            status: "done",
            root,
            relPath,
            outputPath,
            outputName,
            createdAt: Date.now(),
            fps: sourceMetadata.fps,
            timecode: sourceMetadata.timecode,
          };
          premiereXmlJobs.set(id, job);

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            jobId: id,
            status: job.status,
            outputPath,
            downloadUrl: `/api/export/premiere/download?jobId=${id}`,
            metadata: { fps: sourceMetadata.fps, timecode: sourceMetadata.timecode },
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to export Premiere XML" }));
        }
      });

      server.middlewares.use("/api/export/premiere/download", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = premiereXmlJobs.get(id);
          if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Export not found" }));
            return;
          }

          const content = fs.readFileSync(job.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/xml; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.outputPath)}"`);
          res.end(content);
          try { fs.unlinkSync(job.outputPath); } catch {}
          premiereXmlJobs.delete(id);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download Premiere XML" }));
        }
      });

      server.middlewares.use("/api/export/after-effects-markers/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizeAeMarkersName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (keepRanges.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid keepRanges/cuts provided" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const exportDir = resolveExportDir();
          const outputPath = path.join(exportDir, outputName);
          const sourceMetadata = probeFcpxmlMetadata(absMedia);

          let outputCursor = 0;
          const markers = keepRanges.flatMap((range, index) => {
            const durationSec = Math.max(0, range.endSec - range.startSec);
            const clipIndex = index + 1;
            const inMarker = {
              id: `clip-${clipIndex}-in`,
              name: `Clip ${clipIndex} In`,
              comment: `Source in for clip ${clipIndex}`,
              sourceTimeSec: Number(range.startSec.toFixed(6)),
              outputTimeSec: Number(outputCursor.toFixed(6)),
            };
            const outMarker = {
              id: `clip-${clipIndex}-out`,
              name: `Clip ${clipIndex} Out`,
              comment: `Source out for clip ${clipIndex}`,
              sourceTimeSec: Number(range.endSec.toFixed(6)),
              outputTimeSec: Number((outputCursor + durationSec).toFixed(6)),
            };
            outputCursor += durationSec;
            return [inMarker, outMarker];
          });

          const payload = {
            schemaVersion: 1,
            generatedAtUtc: new Date().toISOString(),
            source: {
              root,
              path: relPath,
              fileName: path.basename(absMedia),
              fps: sourceMetadata.fps,
              timecode: sourceMetadata.timecode,
              durationSec: sourceMetadata.durationSec,
            },
            note: "JSON marker scaffold for After Effects workflows. Import via script/automation; direct .aep injection is not supported.",
            markers,
          };

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");

          const id = crypto.randomUUID();
          const job: MarkerExportJob = {
            id,
            status: "done",
            root,
            relPath,
            outputPath,
            outputName,
            createdAt: Date.now(),
          };
          aeMarkerJobs.set(id, job);

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            jobId: id,
            status: job.status,
            outputPath,
            downloadUrl: `/api/export/after-effects-markers/download?jobId=${id}`,
            markerCount: markers.length,
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to export After Effects markers" }));
        }
      });

      server.middlewares.use("/api/export/after-effects-markers/download", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = aeMarkerJobs.get(id);
          if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Export not found" }));
            return;
          }

          const content = fs.readFileSync(job.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.outputPath)}"`);
          res.end(content);
          try { fs.unlinkSync(job.outputPath); } catch {}
          aeMarkerJobs.delete(id);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download After Effects markers" }));
        }
      });

      server.middlewares.use("/api/export/aaf/start", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const root = (body.root ?? studioSettings.roots[0]?.id ?? "") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizeAafName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);
          const rootMap = getRootMap();

          if (!(root in rootMap)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          if (keepRanges.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid keepRanges/cuts provided" }));
            return;
          }

          const absMedia = safeResolve(root, relPath);
          if (!absMedia || !fs.existsSync(absMedia) || !fs.statSync(absMedia).isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Media file not found" }));
            return;
          }

          const sourceMetadata = probeSourceMetadata(absMedia);
          const source = {
            path: absMedia,
            name: path.basename(absMedia),
            fps: sourceMetadata.fps,
            timecode: sourceMetadata.timecode,
            durationSec: sourceMetadata.durationSec,
          };

          const manifest = buildAafBridgeManifest(keepRanges as KeepRange[], source);
          const fcpxml = exportFcpxmlV1(keepRanges as KeepRange[], source, {
            projectName: outputName.replace(/-aaf-bridge\.zip$/, ""),
            sequenceName: outputName.replace(/-aaf-bridge\.zip$/, ""),
            eventName: "prune",
          });
          const edl = exportEdlCmx3600(keepRanges as KeepRange[], source, {
            title: outputName.replace(/\.zip$/, "").toUpperCase().slice(0, 64),
            reel: source.name,
          });
          const premiereXml = exportPremiereXml(keepRanges as KeepRange[], source, {
            projectName: outputName.replace(/-aaf-bridge\.zip$/, ""),
            sequenceName: outputName.replace(/-aaf-bridge\.zip$/, ""),
          });

          const readme = [
            "Prune AAF Bridge Package",
            "",
            "Contents:",
            "- manifest.json: normalized timeline ranges",
            "- import_aaf.py: bridge script to produce binary .aaf via OTIO",
            "- timeline.fcpxml / timeline.edl / timeline-premiere.xml: direct fallback interchange formats",
            "",
            "Quick start:",
            "1) python3 -m pip install opentimelineio otio-aaf-adapter",
            "2) python3 import_aaf.py --manifest manifest.json --out timeline.aaf",
            "3) Import timeline.aaf into Avid/Premiere/Resolve (AAF path depends on host NLE version)",
            "",
            "If AAF writing fails on your system, import one of the fallback timeline files.",
          ].join("\n");

          const exportDir = resolveExportDir();
          const outputPath = path.join(exportDir, outputName);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });

          const tempDir = path.join(exportDir, `.aaf-bridge-${crypto.randomUUID()}`);
          fs.mkdirSync(tempDir, { recursive: true });
          try {
            fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
            fs.writeFileSync(path.join(tempDir, "import_aaf.py"), aafBridgeImporterScript("manifest.json"), "utf-8");
            fs.writeFileSync(path.join(tempDir, "timeline.fcpxml"), fcpxml, "utf-8");
            fs.writeFileSync(path.join(tempDir, "timeline.edl"), edl, "utf-8");
            fs.writeFileSync(path.join(tempDir, "timeline-premiere.xml"), premiereXml, "utf-8");
            fs.writeFileSync(path.join(tempDir, "README.txt"), readme, "utf-8");
            createZipWithPython(outputPath, tempDir, ["manifest.json", "import_aaf.py", "timeline.fcpxml", "timeline.edl", "timeline-premiere.xml", "README.txt"]);
          } finally {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          }

          const id = crypto.randomUUID();
          aafBridgeJobs.set(id, {
            id,
            status: "done",
            root,
            relPath,
            outputPath,
            outputName,
            createdAt: Date.now(),
          });

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            jobId: id,
            status: "done",
            format: "AAF-bridge",
            outputPath,
            downloadUrl: `/api/export/aaf/download?jobId=${id}`,
            limitations: [
              "Native binary AAF writing is provided via the included Python bridge script (OpenTimelineIO + otio-aaf-adapter required).",
              "Fallback FCPXML/EDL/Premiere XML files are included for direct NLE import if AAF conversion is unavailable.",
            ],
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to create AAF bridge package" }));
        }
      });

      server.middlewares.use("/api/export/aaf/download", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = aafBridgeJobs.get(id);
          if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Export not found" }));
            return;
          }

          const content = fs.readFileSync(job.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/zip");
          res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.outputPath)}"`);
          res.end(content);
          try { fs.unlinkSync(job.outputPath); } catch {}
          aafBridgeJobs.delete(id);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download AAF bridge package" }));
        }
      });

      server.middlewares.use("/api/export/capabilities", async (_req, res) => {
        try {
          const hasQsv = ffmpegHasEncoder("h264_qsv");
          const hasNvenc = ffmpegHasEncoder("h264_nvenc");
          const hasVt = ffmpegHasEncoder("h264_videotoolbox");
          const hasX264 = ffmpegHasEncoder("libx264");
          const options = [
            hasQsv ? { format: "mp4", videoEncoder: "h264_qsv", speed: "fast" } : null,
            hasNvenc ? { format: "mp4", videoEncoder: "h264_nvenc", speed: "fast" } : null,
            hasVt ? { format: "mp4", videoEncoder: "h264_videotoolbox", speed: "fast" } : null,
            hasX264 ? { format: "mp4", videoEncoder: "libx264", speed: "medium" } : null,
            { format: "wav", videoEncoder: null, speed: "n/a" },
            { format: "mp3", videoEncoder: null, speed: "n/a" },
          ].filter(Boolean);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ options }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to read export capabilities" }));
        }
      });

      server.middlewares.use("/api/export/latest-active", async (_req, res) => {
        try {
          const active = Array.from(exportJobs.values())
            .filter((job) => job.status === "running" || job.status === "queued")
            .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(active ? { ...active, downloadUrl: null } : { job: null }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to fetch active export" }));
        }
      });

      server.middlewares.use("/api/export/render-status", async (_req, res) => {
        try {
          const active = Array.from(exportJobs.values())
            .filter((job) => job.status === "running" || job.status === "queued")
            .sort((a, b) => b.startedAt - a.startedAt)[0] || null;

          let out: RenderStatusSnapshot;
          if (active) {
            const expected = active.expectedDurationSec;
            const progress = active.progressSec ?? 0;
            const elapsedSec = Math.max(1, Math.round((Date.now() - active.startedAt) / 1000));
            const speed = progress > 0 ? progress / elapsedSec : 0;
            out = {
              jobId: active.id,
              status: "running",
              startedAt: active.startedAt,
              outputPath: active.outputPath,
              outputName: active.outputName,
              relPath: active.relPath,
              expectedDurationSec: expected,
              progressSec: progress,
              percent: expected && expected > 0 ? clampPercent((progress / expected) * 100) : null,
              etaSec: expected && speed > 0 ? Math.max(0, Math.round((expected - Math.min(expected, progress)) / speed)) : null,
              lastLog: active.log.length ? String(active.log[active.log.length - 1]).trim().slice(-220) : undefined,
            };
          } else {
            out = latestRenderStatus;
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(out));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to fetch render status" }));
        }
      });

      server.middlewares.use("/api/export/status", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = exportJobs.get(id);
          if (!job) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Job not found" }));
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ...job, downloadUrl: job.status === "done" ? `/api/export/download?jobId=${job.id}` : null }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to fetch export status" }));
        }
      });

      server.middlewares.use("/api/export/download", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const id = url.searchParams.get("jobId") ?? "";
          const job = exportJobs.get(id);
          if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Export not found" }));
            return;
          }
          const content = fs.readFileSync(job.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.outputPath)}"`);
          res.end(content);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download export" }));
        }
      });

      server.middlewares.use("/api/export/cache/clear", async (_req, res) => {
        try {
          const exportDir = resolveExportDir();
          const entries = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
          let removed = 0;
          for (const name of entries) {
            const ext = path.extname(name).toLowerCase();
            if (![".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(ext)) continue;
            try {
              fs.unlinkSync(path.join(exportDir, name));
              removed += 1;
            } catch {}
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, removed }));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to clear video cache" }));
        }
      });

      server.middlewares.use("/api/subtitles/export", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const format = String(body.format ?? "srt").toLowerCase() === "vtt" ? "vtt" : "srt";
          const includeDeleted = Boolean(body.includeDeleted);
          const deletedIds = new Set(Array.isArray(body.deletedTokenIds) ? body.deletedTokenIds.map((v: unknown) => String(v)) : []);
          const allTokens = normalizeSubtitleTokens(body.tokens);
          const tokens = includeDeleted ? allTokens : allTokens.filter((token) => !deletedIds.has(token.id));

          if (tokens.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No transcript tokens to export" }));
            return;
          }

          const captionChunks = buildCaptionChunks(tokens);
          if (captionChunks.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "No valid subtitle chunks generated" }));
            return;
          }

          const outputName = sanitizeSubtitleName(String(body.outputName ?? "subtitles"), format, "subtitles");
          const content = `${(format === "vtt" ? buildVtt(captionChunks) : buildSrt(captionChunks)).trim()}\n`;

          res.statusCode = 200;
          res.setHeader("Content-Type", format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
          res.end(content);
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to export subtitles" }));
        }
      });

      server.middlewares.use("/api/script/export", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          await new Promise((resolve) => req.on("end", resolve));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

          const text = String(body.text ?? "").trim();
          if (!text) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Script text is empty" }));
            return;
          }

          const outputName = sanitizeScriptName(String(body.outputName ?? "script"));
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
          res.end(`${text}\n`);
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to export script" }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), studioApiPlugin()],
});
