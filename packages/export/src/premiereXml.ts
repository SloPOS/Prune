import type { KeepRange, SourceMediaMetadata } from "./types.js";
import { fpsToInt, inferTimecodeFormat, isNtscFrameRate, keepRangesToFrameRanges, maxEndFrames, mediaNameFromSource, normalizeKeepRanges, parseTimecodeToFrames, pathToFileUrl, resolveSourceDurationSec, secondsToFrames, xmlEscape } from "./utils.js";

export interface PremiereXmlExportOptions {
  projectName?: string;
  sequenceName?: string;
  width?: number;
  height?: number;
}

function xmlRateBlock(fps: number, ntsc: boolean): string {
  return `<rate>
            <timebase>${fps}</timebase>
            <ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc>
          </rate>`;
}

function buildClipItem(
  id: number,
  name: string,
  inFrames: number,
  outFrames: number,
  startFrames: number,
  endFrames: number,
): string {
  return `            <clipitem id="clipitem-${id}">
              <name>${xmlEscape(name)}</name>
              <enabled>TRUE</enabled>
              <start>${startFrames}</start>
              <end>${endFrames}</end>
              <in>${inFrames}</in>
              <out>${outFrames}</out>
              <file id="file-1"></file>
            </clipitem>`;
}

// frame conversion helpers are centralized in utils.ts

export function exportPremiereXml(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: PremiereXmlExportOptions = {},
): string {
  const fps = fpsToInt(source.fps);
  const mediaName = mediaNameFromSource(source);
  const sequenceName = options.sequenceName ?? options.projectName ?? "Bit Cut Timeline";
  const projectName = options.projectName ?? sequenceName;

  const filtered = normalizeKeepRanges(keepRanges);
  const durationSec = resolveSourceDurationSec(source, filtered);

  const sourceDurationFrames = secondsToFrames(durationSec, fps);
  const sourceTcFrames = parseTimecodeToFrames(source.timecode, fps);
  const ntsc = isNtscFrameRate(source.fps);
  const timecodeFormat = inferTimecodeFormat(source.timecode);

  const clipFrameRanges = keepRangesToFrameRanges(filtered, fps, { alreadyNormalized: true });

  const clipItems = clipFrameRanges
    .map(({ inFrames, outFrames, startFrames, endFrames }, i) => {
      const name = `${mediaName} seg ${i + 1}`;
      return buildClipItem(i + 1, name, inFrames, outFrames, startFrames, endFrames);
    })
    .join("\n");

  const sequenceDurationFrames = maxEndFrames(clipFrameRanges);

  return `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <project>
    <name>${xmlEscape(projectName)}</name>
    <children>
      <sequence id="sequence-1">
        <name>${xmlEscape(sequenceName)}</name>
        <duration>${sequenceDurationFrames}</duration>
        ${xmlRateBlock(fps, ntsc)}
        <timecode>
          ${xmlRateBlock(fps, ntsc)}
          <frame>${sourceTcFrames}</frame>
          <displayformat>${timecodeFormat.displayFormat}</displayformat>
        </timecode>
        <media>
          <video>
            <format>
              <samplecharacteristics>
                ${xmlRateBlock(fps, ntsc)}
                <width>${options.width ?? 1920}</width>
                <height>${options.height ?? 1080}</height>
              </samplecharacteristics>
            </format>
            <track>
${clipItems}
            </track>
          </video>
        </media>
      </sequence>
      <clip id="masterclip-1">
        <name>${xmlEscape(mediaName)}</name>
        <duration>${sourceDurationFrames}</duration>
        ${xmlRateBlock(fps, ntsc)}
        <timecode>
          ${xmlRateBlock(fps, ntsc)}
          <frame>${sourceTcFrames}</frame>
          <displayformat>${timecodeFormat.displayFormat}</displayformat>
        </timecode>
        <media>
          <video>
            <track>
              <clipitem id="masterclipitem-1">
                <name>${xmlEscape(mediaName)}</name>
                <file id="file-1"></file>
              </clipitem>
            </track>
          </video>
        </media>
      </clip>
      <file id="file-1">
        <name>${xmlEscape(mediaName)}</name>
        <pathurl>${xmlEscape(pathToFileUrl(source.path))}</pathurl>
        <duration>${sourceDurationFrames}</duration>
        ${xmlRateBlock(fps, ntsc)}
      </file>
    </children>
  </project>
</xmeml>
`;
}
