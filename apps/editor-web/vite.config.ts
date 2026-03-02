import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";

const FILE_ROOTS = {
  inbox: "/home/bit/.openclaw/workspace/inbox",
  archive: "/mnt/video-archive",
} as const;

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

const jobs = new Map<string, TranscribeJob>();
const exportJobs = new Map<string, ExportJob>();

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

function inputHasAudio(absInput: string): boolean {
  try {
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", absInput], { encoding: "utf-8" });
    return Boolean((probe.stdout || "").trim());
  } catch {
    return false;
  }
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
          pushLog(job, `Extracting audio from ${relPath}\n`);

          const extractScript = path.resolve(REPO_ROOT, "scripts", "extract-audio-wav.sh");
          const ff = spawn("bash", [extractScript, absMedia, wavPath], {
            cwd: REPO_ROOT,
          });

          ff.stdout.on("data", (d) => pushLog(job, String(d)));
          ff.stderr.on("data", (d) => pushLog(job, String(d)));

          ff.on("close", (ffCode) => {
            if (ffCode !== 0) {
              job.status = "error";
              job.exitCode = ffCode;
              job.error = `Audio extraction failed (${ffCode})`;
              job.endedAt = Date.now();
              return;
            }

            pushLog(job, `Running Whisper (${model}, ${device}, ${computeType})`);

            const tr = spawn("bash", ["-lc", `${command} "${wavPath}" --model "${model}" --device "${device}" --compute-type "${computeType}" --language "${language}" --out "${transcriptAbsPath}"`], {
              cwd: REPO_ROOT,
            });

            tr.stdout.on("data", (d) => pushLog(job, String(d)));
            tr.stderr.on("data", (d) => pushLog(job, String(d)));
            tr.on("close", (trCode) => {
              job.exitCode = trCode;
              job.endedAt = Date.now();
              if (trCode === 0) {
                job.status = "done";
                pushLog(job, `Done: ${transcriptRelPath}`);
              } else {
                job.status = "error";
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
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(job));
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
    },
  };
}

export default defineConfig({
  plugins: [react(), studioApiPlugin()],
});
