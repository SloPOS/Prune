import fs from "node:fs";

export type AnalysisCandidate = {
  id: string;
  kind: "breath" | "noise_click";
  startSec: number;
  endSec: number;
  confidence: "low" | "medium" | "high";
  score: number;
  reason: string;
};

export function parseWavMono16(absWavPath: string): { sampleRate: number; samples: Float32Array } {
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

export function rollingRms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function detectBreathCandidates(samples: Float32Array, sampleRate: number, speechGaps: Array<{ startSec: number; endSec: number }>): AnalysisCandidate[] {
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

export function detectNoiseClickCandidates(samples: Float32Array, sampleRate: number): AnalysisCandidate[] {
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
