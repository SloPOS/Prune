import type { KeepRange, SourceMediaMetadata } from "./types.js";
import { mediaNameFromSource, parseTimecodeToFrames, pathToFileUrl, validKeepRanges, xmlEscape } from "./utils.js";

export interface FcpxmlV1ExportOptions {
  projectName?: string;
  eventName?: string;
  sequenceName?: string;
  width?: number;
  height?: number;
}

interface Rate {
  fpsNum: number;
  fpsDen: number;
}

const NTSC_RATES: Array<{ fps: number; rate: Rate }> = [
  { fps: 23.976, rate: { fpsNum: 24000, fpsDen: 1001 } },
  { fps: 29.97, rate: { fpsNum: 30000, fpsDen: 1001 } },
  { fps: 59.94, rate: { fpsNum: 60000, fpsDen: 1001 } },
];

function normalizeRate(fps: number): Rate {
  const ntsc = NTSC_RATES.find((r) => Math.abs(r.fps - fps) < 0.001);
  if (ntsc) return ntsc.rate;

  const rounded = Math.round(fps);
  if (Math.abs(rounded - fps) < 0.001 && rounded > 0) {
    return { fpsNum: rounded, fpsDen: 1 };
  }

  const scale = 1000;
  return { fpsNum: Math.round(fps * scale), fpsDen: scale };
}

function toFrames(sec: number, rate: Rate): number {
  return Math.max(0, Math.round((sec * rate.fpsNum) / rate.fpsDen));
}

function fromFrames(frames: number, rate: Rate): string {
  const num = frames * rate.fpsDen;
  const den = rate.fpsNum;
  return `${num}/${den}s`;
}

export function exportFcpxmlV1(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: FcpxmlV1ExportOptions = {},
): string {
  const rate = normalizeRate(source.fps);
  const mediaName = mediaNameFromSource(source);
  const eventName = options.eventName ?? "prune";
  const projectName = options.projectName ?? "Bit Cut Timeline";
  const sequenceName = options.sequenceName ?? projectName;

  const filtered = validKeepRanges(keepRanges);
  const inferredDurationSec = Math.max(0, ...filtered.map((r) => r.sourceEndSec));
  const durationSec = source.durationSec ?? inferredDurationSec;

  const tcStartFrames = parseTimecodeToFrames(source.timecode, Math.round(rate.fpsNum / rate.fpsDen));
  const sequenceTcStart = fromFrames(tcStartFrames, rate);
  const mediaDuration = fromFrames(toFrames(durationSec, rate), rate);
  const frameDuration = `${rate.fpsDen}/${rate.fpsNum}s`;

  const clips = filtered
    .map((r, i) => {
      const sourceStartFrames = toFrames(r.sourceStartSec, rate);
      const sourceEndFrames = toFrames(r.sourceEndSec, rate);
      const outputStartFrames = toFrames(r.outputStartSec, rate);
      const clipDurationFrames = Math.max(0, sourceEndFrames - sourceStartFrames);
      const startFramesWithTc = tcStartFrames + sourceStartFrames;

      return `        <asset-clip name="${xmlEscape(mediaName)} seg ${i + 1}" ref="r2" offset="${fromFrames(outputStartFrames, rate)}" start="${fromFrames(startFramesWithTc, rate)}" duration="${fromFrames(clipDurationFrames, rate)}" />`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormatRateUndefined" frameDuration="${frameDuration}" width="${options.width ?? 1920}" height="${options.height ?? 1080}" colorSpace="1-1-1 (Rec. 709)" />
    <asset id="r2" name="${xmlEscape(mediaName)}" src="${xmlEscape(pathToFileUrl(source.path))}" start="${sequenceTcStart}" duration="${mediaDuration}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000" />
  </resources>
  <library>
    <event name="${xmlEscape(eventName)}">
      <project name="${xmlEscape(projectName)}">
        <sequence format="r1" tcStart="${sequenceTcStart}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
