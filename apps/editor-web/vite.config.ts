import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const FILE_ROOTS = {
  inbox: "/home/bit/.openclaw/workspace/inbox",
  archive: "/mnt/video-archive",
} as const;

type RootName = keyof typeof FILE_ROOTS;

function safeResolve(root: RootName, relPath: string): string | null {
  const base = path.resolve(FILE_ROOTS[root]);
  const target = path.resolve(base, relPath || ".");
  if (target === base || target.startsWith(`${base}${path.sep}`)) {
    return target;
  }
  return null;
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
        } catch (error) {
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
    },
  };
}

export default defineConfig({
  plugins: [react(), studioApiPlugin()],
});
