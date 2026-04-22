#!/usr/bin/env node
import { parseArgs } from "node:util";
import { transcribeCommand } from "./commands/transcribe.js";
import { editCommand } from "./commands/edit.js";
import { exportCommand, type ExportFormat } from "./commands/export.js";
import { renderCommand, type RenderCodec } from "./commands/render.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { previewCommand } from "./commands/preview.js";
import { infoCommand } from "./commands/info.js";

const usage = `
Prune CLI - Transcript-first video editor

Usage:
  prune transcribe <media-file> [--model small] [--language en] [--device cpu]
  prune edit <transcript.txt> [--output-dir .]
  prune export <transcript.txt> [--format fcpxml,edl,xml,srt,vtt,txt,all] [--output-dir .]
  prune render <transcript.txt> [--codec h264|h265|prores|copy] [--container mp4|mov|webm]
  prune cleanup <transcript.txt> [--fillers] [--silence <sec>] [--breaths] [--clicks]
  prune preview <transcript.txt> [--timestamps]
  prune info <media-file>

Commands:
  transcribe   Extract audio and transcribe with Whisper
  edit         Reconcile transcript edits and write FCPXML
  export       Export to interchange formats (FCPXML, EDL, Premiere, SRT, VTT, etc.)
  render       Render edited video with FFmpeg
  cleanup      Auto-mark fillers, silences, breaths, clicks for deletion
  preview      Print the kept transcript text
  info         Probe media file and show metadata
`;

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(usage);
    process.exit(0);
  }

  const command = args[0];

  // Parse global options (for now just --help)
  if (command === "--help" || command === "-h") {
    console.log(usage);
    process.exit(0);
  }

  // Parse remaining args using parseArgs where applicable
  const rest = args.slice(1);

  try {
    switch (command) {
      case "transcribe": {
        if (rest.length < 1) throw new Error("transcribe requires <media-file>");
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            model: { type: "string", default: "small" },
            language: { type: "string", default: "en" },
            device: { type: "string", default: "cpu" },
          },
          allowPositionals: true,
        });
        transcribeCommand(rest[0]!, {
          model: values.model,
          language: values.language,
          device: values.device,
        });
        break;
      }

      case "edit": {
        if (rest.length < 1) throw new Error("edit requires <transcript.txt>");
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            "output-dir": { type: "string" },
          },
          allowPositionals: true,
        });
        editCommand(rest[0]!, { outputDir: values["output-dir"] });
        break;
      }

      case "export": {
        if (rest.length < 1) throw new Error("export requires <transcript.txt>");
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            format: { type: "string", default: "fcpxml" },
            "output-dir": { type: "string" },
          },
          allowPositionals: true,
        });
        const formats = String(values.format).split(",") as ExportFormat[];
        exportCommand(rest[0]!, {
          format: formats.length === 1 ? formats[0]! : formats,
          outputDir: values["output-dir"],
        });
        break;
      }

      case "render": {
        if (rest.length < 1) throw new Error("render requires <transcript.txt>");
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            codec: { type: "string", default: "h264" },
            container: { type: "string", default: "mp4" },
            resolution: { type: "string", default: "source" },
            fps: { type: "string", default: "source" },
          },
          allowPositionals: true,
        });
        const fpsVal = values.fps === "source" ? "source" : Number(values.fps);
        renderCommand(rest[0]!, {
          codec: values.codec as RenderCodec,
          container: values.container as "mp4" | "mov" | "webm",
          resolution: values.resolution as "source" | `${number}x${number}`,
          fps: fpsVal,
        });
        break;
      }

      case "cleanup": {
        if (rest.length < 1) throw new Error("cleanup requires <transcript.txt>");
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            fillers: { type: "boolean", default: false },
            silence: { type: "string" },
            breaths: { type: "boolean", default: false },
            clicks: { type: "boolean", default: false },
          },
          allowPositionals: true,
        });
        cleanupCommand(rest[0]!, {
          fillers: values.fillers,
          silence: values.silence ? Number(values.silence) : undefined,
          breaths: values.breaths,
          clicks: values.clicks,
        });
        break;
      }

      case "preview": {
        if (rest.length < 1) throw new Error("preview requires <transcript.txt>");
        const { values } = parseArgs({
          args: rest.slice(1),
          options: {
            timestamps: { type: "boolean", default: false },
          },
          allowPositionals: true,
        });
        previewCommand(rest[0]!, { timestamps: values.timestamps });
        break;
      }

      case "info": {
        if (rest.length < 1) throw new Error("info requires <media-file>");
        infoCommand(rest[0]!);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(usage);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
