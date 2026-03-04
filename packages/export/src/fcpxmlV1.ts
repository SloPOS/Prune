import type { KeepRange, SourceMediaMetadata } from "./types.js";
import { inferTimecodeFormat, keepRangesToRateFrameRanges, mediaNameFromSource, normalizeFrameRate, normalizeKeepRanges, parseTimecodeToFrames, pathToFileUrl, rateFramesToFractionSeconds, resolveSourceDurationSec, secondsToRateFrames, xmlEscape } from "./utils.js";

export interface FcpxmlV1ExportOptions {
  projectName?: string;
  eventName?: string;
  sequenceName?: string;
  width?: number;
  height?: number;
}

export function exportFcpxmlV1(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: FcpxmlV1ExportOptions = {},
): string {
  const rate = normalizeFrameRate(source.fps);
  const mediaName = mediaNameFromSource(source);
  const eventName = options.eventName ?? "prune";
  const projectName = options.projectName ?? "Bit Cut Timeline";
  const sequenceName = options.sequenceName ?? projectName;

  const filtered = normalizeKeepRanges(keepRanges);
  const durationSec = resolveSourceDurationSec(source, filtered);

  const tcStartFrames = parseTimecodeToFrames(source.timecode, Math.round(rate.fpsNum / rate.fpsDen));
  const timecodeFormat = inferTimecodeFormat(source.timecode);
  const sequenceTcStart = rateFramesToFractionSeconds(tcStartFrames, rate);
  const mediaDuration = rateFramesToFractionSeconds(secondsToRateFrames(durationSec, rate), rate);
  const frameDuration = `${rate.fpsDen}/${rate.fpsNum}s`;

  const frameRanges = keepRangesToRateFrameRanges(filtered, rate, { alreadyNormalized: true });

  const clips = frameRanges
    .map((range, i) => {
      const clipDurationFrames = Math.max(0, range.outFrames - range.inFrames);
      const startFramesWithTc = tcStartFrames + range.inFrames;

      return `        <asset-clip name="${xmlEscape(mediaName)} seg ${i + 1}" ref="r2" offset="${rateFramesToFractionSeconds(range.startFrames, rate)}" start="${rateFramesToFractionSeconds(startFramesWithTc, rate)}" duration="${rateFramesToFractionSeconds(clipDurationFrames, rate)}" />`;
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
        <sequence format="r1" tcStart="${sequenceTcStart}" tcFormat="${timecodeFormat.displayFormat}" audioLayout="stereo" audioRate="48k">
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
