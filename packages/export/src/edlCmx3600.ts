import type { KeepRange, SourceMediaMetadata } from "./types.js";
import { createTimecodeFormatter, inferTimecodeFormat, isNtscFrameRate, keepRangesToFrameRanges, mediaNameFromSource } from "./utils.js";

export interface EdlExportOptions {
  title?: string;
  reel?: string;
}

function cleanReel(value: string): string {
  const trimmed = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (trimmed || "AX").slice(0, 8);
}

export function exportEdlCmx3600(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: EdlExportOptions = {},
): string {
  const title = (options.title || "PRUNE").replace(/[^A-Za-z0-9 _-]/g, "_").slice(0, 64);
  const clipName = mediaNameFromSource(source, "source");
  const reel = cleanReel(options.reel || source.name || source.path.split("/").pop() || "AX");
  const fps = source.fps;
  const frameRanges = keepRangesToFrameRanges(keepRanges, fps);
  const dropFrame = inferTimecodeFormat(source.timecode).dropFrame && isNtscFrameRate(source.fps);
  const formatTimecode = createTimecodeFormatter(fps, { dropFrame });

  const lines: string[] = [];
  lines.push(`TITLE: ${title}`);
  lines.push(dropFrame ? "FCM: DROP FRAME" : "FCM: NON-DROP FRAME");
  lines.push("");

  frameRanges.forEach((r, i) => {
    const event = String(i + 1).padStart(3, "0");
    lines.push(
      `${event}  ${reel.padEnd(8, " ")} V     C        ${formatTimecode(r.inFrames)} ${formatTimecode(r.outFrames)} ${formatTimecode(r.startFrames)} ${formatTimecode(r.endFrames)}`,
    );
    lines.push(`* FROM CLIP NAME: ${clipName}`);
  });

  lines.push("");
  return lines.join("\n");
}
