import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { exportFcpxmlV1, type KeepRange } from "../../packages/export/src/fcpxmlV1";

const FILE_ROOTS = {
  inbox: "/home/bit/.openclaw/workspace/inbox",
  archive: "/mnt/video-archive",
} as const;

const UPLOAD_TARGET_DIR = "/mnt/video-archive/incoming/uploads";

const REPO_ROOT = path.resolve(__dirname, "../..");

type RootName = keyof typeof FILE_ROOTS;

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
  encoder?: "h264_qsv" | "libx264";
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  log: string[];
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

function safeResolve(root: RootName, relPath: string): string | null {
  const base = path.resolve(FILE_ROOTS[root]);
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
  const matches = [...text.matchAll(/\[(\d{2}:\d{2}\.\d{3})\s*->\s*(\d{2}:\d{2}\.\d{3})\]/g)];
  if (matches.length === 0) return undefined;
  const toSec = (stamp: string) => {
    const [mm, rest] = stamp.split(":");
    return Number(mm) * 60 + Number(rest);
  };
  let maxSec = 0;
  for (const m of matches) {
    const sec = toSec(m[2]);
    if (Number.isFinite(sec)) maxSec = Math.max(maxSec, sec);
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
  const preferred = "/mnt/video-archive/exports";
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

function sanitizeOutputName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}.mp4`;
}

function normalizeRange(input: RangeInput): { startSec: number; endSec: number } | null {
  const start = Number(input.sourceStartSec ?? input.startSec);
  const end = Number(input.sourceEndSec ?? input.endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null;
  return { startSec: start, endSec: end };
}

function normalizeKeepRanges(body: { keepRanges?: RangeInput[]; cuts?: RangeInput[] }): { startSec: number; endSec: number }[] {
  const keeps = Array.isArray(body.keepRanges) ? body.keepRanges.map(normalizeRange).filter((v): v is { startSec: number; endSec: number } => Boolean(v)) : [];
  if (keeps.length > 0) {
    return keeps.sort((a, b) => a.startSec - b.startSec);
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

function sanitizeFcpxmlName(raw: string, sourceRelPath: string): string {
  const fallbackBase = path.basename(sourceRelPath, path.extname(sourceRelPath)) || "edited";
  const base = (raw || fallbackBase).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base || "edited"}.fcpxml`;
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
    proc.stdout.on("data", (d) => pushLog(job, String(d)));
    proc.stderr.on("data", (d) => pushLog(job, String(d)));
    proc.on("close", (code) => resolve(code));
    proc.on("error", (err) => {
      pushLog(job, `${err.message}\n`);
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
    const expectedSpeed = transcribeExpectedSpeed(job.device ?? "cpu", job.model ?? "small");
    const elapsedSec = Math.max(1, Math.round((now - (job.phaseStartedAt ?? job.startedAt)) / 1000));

    if (duration) {
      let processedSec = job.transcribedSec;
      let speed = processedSec !== undefined && elapsedSec > 0 ? processedSec / elapsedSec : undefined;
      if (processedSec === undefined) {
        processedSec = Math.min(duration, elapsedSec * expectedSpeed);
        speed = expectedSpeed;
      }
      const percent = clampPercent(35 + (Math.min(duration, processedSec) / duration) * 65);
      const remainingMediaSec = Math.max(0, duration - Math.min(duration, processedSec));
      const etaSec = speed && speed > 0 ? Math.round(remainingMediaSec / speed) : null;
      return {
        percent,
        etaSec,
        speedLabel: speed && Number.isFinite(speed) ? `${speed.toFixed(2)}x realtime` : "transcribing",
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

function ffmpegArgsForRanges(absInput: string, outputPath: string, keepRanges: { startSec: number; endSec: number }[], encoder: "h264_qsv" | "libx264", hasAudio: boolean): string[] {
  const trim = (n: number) => Number(n.toFixed(3));

  if (keepRanges.length === 1) {
    const r = keepRanges[0];
    const args = ["-y", "-hide_banner", "-i", absInput, "-ss", `${trim(r.startSec)}`, "-to", `${trim(r.endSec)}`, "-c:v", encoder, "-preset", "veryfast"];
    if (hasAudio) args.push("-c:a", "aac");
    else args.push("-an");
    args.push("-movflags", "+faststart", outputPath);
    return args;
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = trim(r.startSec);
    const e = trim(r.endSec);
    filterParts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    concatInputs.push(`[v${i}]`);
    if (hasAudio) {
      filterParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }
  });

  filterParts.push(`${concatInputs.join("")}concat=n=${keepRanges.length}:v=1:a=${hasAudio ? 1 : 0}[v${hasAudio ? "out" : ""}]${hasAudio ? "[aout]" : ""}`);

  const args = ["-y", "-hide_banner", "-i", absInput, "-filter_complex", filterParts.join(";"), "-map", hasAudio ? "[vout]" : "[v]", "-c:v", encoder, "-preset", "veryfast"];
  if (hasAudio) {
    args.push("-map", "[aout]", "-c:a", "aac");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", outputPath);
  return args;
}

function studioApiPlugin(): Plugin {
  return {
    name: "studio-local-api",
    configureServer(server) {
      server.middlewares.use("/api/files", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = (url.searchParams.get("root") ?? "inbox") as RootName;
          const relDir = url.searchParams.get("dir") ?? ".";

          if (!(root in FILE_ROOTS)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid root" }));
            return;
          }

          const absDir = safeResolve(root, relDir);
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
                relPath: path.relative(FILE_ROOTS[root], absPath) || ".",
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

      server.middlewares.use("/api/files/upload", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          const { file } = await parseMultipart(req);
          const root: RootName = "archive";
          const relDir = "incoming/uploads";

          if (!file) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing upload file" }));
            return;
          }

          fs.mkdirSync(UPLOAD_TARGET_DIR, { recursive: true });
          let outputName = file.name;
          let outputPath = path.join(UPLOAD_TARGET_DIR, outputName);
          let count = 1;
          while (fs.existsSync(outputPath)) {
            const ext = path.extname(file.name);
            const base = path.basename(file.name, ext);
            outputName = `${base}-${count}${ext}`;
            outputPath = path.join(UPLOAD_TARGET_DIR, outputName);
            count += 1;
          }

          fs.writeFileSync(outputPath, file.data);
          const relPath = path.relative(FILE_ROOTS.archive, outputPath) || outputName;
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
          const root = (url.searchParams.get("root") ?? "inbox") as RootName;
          const relPath = url.searchParams.get("path") ?? "";

          if (!(root in FILE_ROOTS)) {
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

      server.middlewares.use("/api/media", async (req, res) => {
        const send = (code: number, msg: string) => {
          res.statusCode = code;
          res.end(msg);
        };

        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = (url.searchParams.get("root") ?? "inbox") as RootName;
          const relPath = url.searchParams.get("path") ?? "";

          if (!(root in FILE_ROOTS)) return send(400, "Invalid root");

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

          const root = (body.root ?? "inbox") as RootName;
          const relPath = String(body.path ?? "");
          const model = String(body.model ?? "small");
          const device = String(body.device ?? "cpu");
          const computeType = String(body.computeType ?? "int8");
          const language = String(body.language ?? "en");

          if (!(root in FILE_ROOTS)) {
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
          const transcriptRelPath = path.join("transcripts", `${cleanName}.json`);
          const transcriptAbsPath = path.resolve(FILE_ROOTS[root], transcriptRelPath);

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
            pushLog(job, `Running Whisper (${model}, ${device}, ${computeType})`);

            const tr = spawn("bash", ["-lc", `${command} "${wavPath}" --model "${model}" --device "${device}" --compute-type "${computeType}" --language "${language}" --out "${transcriptAbsPath}"`], {
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

          const root = (body.root ?? "inbox") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizeOutputName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);

          if (!(root in FILE_ROOTS)) {
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

          const job: ExportJob = {
            id,
            status: "queued",
            root,
            relPath,
            outputName,
            outputPath,
            startedAt: Date.now(),
            log: [],
          };
          exportJobs.set(id, job);

          job.status = "running";
          const hasQsv = ffmpegHasEncoder("h264_qsv");
          const hasAudio = inputHasAudio(absMedia);
          pushLog(job, `Exporting ${relPath} -> ${outputPath}\n`);
          pushLog(job, `Detected audio stream: ${hasAudio ? "yes" : "no"}\n`);

          const preferred = hasQsv ? "h264_qsv" : "libx264";
          job.encoder = preferred;
          pushLog(job, `Encoder preference: ${preferred}\n`);

          const preferredCode = await runFfmpeg(job, ffmpegArgsForRanges(absMedia, outputPath, keepRanges, preferred, hasAudio));

          if (preferredCode !== 0 && preferred === "h264_qsv") {
            pushLog(job, `h264_qsv failed (${preferredCode}), retrying with libx264\n`);
            job.encoder = "libx264";
            const fallbackCode = await runFfmpeg(job, ffmpegArgsForRanges(absMedia, outputPath, keepRanges, "libx264", hasAudio));
            job.exitCode = fallbackCode;
            job.endedAt = Date.now();
            if (fallbackCode === 0) {
              job.status = "done";
              pushLog(job, `Done: ${outputPath}\n`);
            } else {
              job.status = "error";
              job.error = `ffmpeg failed (${fallbackCode})`;
            }
          } else {
            job.exitCode = preferredCode;
            job.endedAt = Date.now();
            if (preferredCode === 0) {
              job.status = "done";
              pushLog(job, `Done: ${outputPath}\n`);
            } else {
              job.status = "error";
              job.error = `ffmpeg failed (${preferredCode})`;
            }
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

          const root = (body.root ?? "inbox") as RootName;
          const relPath = String(body.path ?? "");
          const outputName = sanitizeFcpxmlName(String(body.outputName ?? ""), relPath);
          const keepRanges = normalizeKeepRanges(body);

          if (!(root in FILE_ROOTS)) {
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
            keepRanges.map((r, i, arr) => ({
              sourceStartSec: r.startSec,
              sourceEndSec: r.endSec,
              outputStartSec: i === 0 ? 0 : arr.slice(0, i).reduce((sum, x) => sum + (x.endSec - x.startSec), 0),
            })) as KeepRange[],
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
              eventName: "bit-cut-studio",
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
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to download FCPXML" }));
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
          res.end(JSON.stringify(job));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Failed to fetch export status" }));
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

          const exportDir = resolveExportDir();
          const outputName = sanitizeSubtitleName(String(body.outputName ?? "subtitles"), format, "subtitles");
          const outputPath = path.join(exportDir, outputName);
          const content = format === "vtt" ? buildVtt(captionChunks) : buildSrt(captionChunks);

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${content.trim()}\n`, "utf-8");

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ outputPath, format, captions: captionChunks.length }));
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

          const exportDir = resolveExportDir();
          const outputName = sanitizeScriptName(String(body.outputName ?? "script"));
          const outputPath = path.join(exportDir, outputName);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${text}\n`, "utf-8");

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ outputPath }));
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
