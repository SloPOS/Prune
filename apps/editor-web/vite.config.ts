import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const FILE_ROOTS = {
  inbox: "/home/bit/.openclaw/workspace/inbox",
  archive: "/mnt/video-archive",
} as const;

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

const jobs = new Map<string, TranscribeJob>();

function safeResolve(root: RootName, relPath: string): string | null {
  const base = path.resolve(FILE_ROOTS[root]);
  const target = path.resolve(base, relPath || ".");
  if (target === base || target.startsWith(`${base}${path.sep}`)) {
    return target;
  }
  return null;
}

function pushLog(job: TranscribeJob, line: string) {
  job.log.push(line);
  if (job.log.length > 250) job.log.shift();
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
          const transcriptRelPath = path.join("data", "transcripts", `${cleanName}.json`);

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

          const venvPython = path.resolve(process.cwd(), ".venv", "bin", "python3");
          const hasVenv = fs.existsSync(venvPython);
          const command = hasVenv
            ? `${venvPython} scripts/transcribe_whisper.py`
            : "python3 scripts/transcribe_whisper.py";

          const wavPath = path.resolve(process.cwd(), "data", "audio", `${cleanName}.wav`);
          fs.mkdirSync(path.dirname(wavPath), { recursive: true });
          fs.mkdirSync(path.resolve(process.cwd(), "data", "transcripts"), { recursive: true });

          job.status = "running";
          pushLog(job, `Extracting audio from ${relPath}`);

          const ff = spawn("bash", ["scripts/extract-audio-wav.sh", absMedia, wavPath], {
            cwd: process.cwd(),
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

            const tr = spawn("bash", ["-lc", `${command} "${wavPath}" --model "${model}" --device "${device}" --compute-type "${computeType}" --language "${language}" --out "${transcriptRelPath}"`], {
              cwd: process.cwd(),
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
    },
  };
}

export default defineConfig({
  plugins: [react(), studioApiPlugin()],
});
