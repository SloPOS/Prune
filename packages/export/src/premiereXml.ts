import type { KeepRange, SourceMediaMetadata } from "./types.js";
import { mediaNameFromSource, normalizeKeepRanges, parseTimecodeToFrames, pathToFileUrl, xmlEscape } from "./utils.js";

export interface PremiereXmlExportOptions {
  projectName?: string;
  sequenceName?: string;
  width?: number;
  height?: number;
}

function toFrames(sec: number, fps: number): number {
  const fpsInt = Math.max(1, Math.round(fps));
  return Math.max(0, Math.round(sec * fpsInt));
}

export function exportPremiereXml(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: PremiereXmlExportOptions = {},
): string {
  const fps = Math.max(1, Math.round(source.fps));
  const mediaName = mediaNameFromSource(source);
  const sequenceName = options.sequenceName ?? options.projectName ?? "Bit Cut Timeline";
  const projectName = options.projectName ?? sequenceName;

  const filtered = normalizeKeepRanges(keepRanges);
  const inferredDurationSec = Math.max(0, ...filtered.map((r) => r.sourceEndSec));
  const durationSec = source.durationSec ?? inferredDurationSec;

  const sourceDurationFrames = toFrames(durationSec, fps);
  const sourceTcFrames = parseTimecodeToFrames(source.timecode, fps);

  const clipFrameRanges = filtered.map((range) => {
    const inFrames = toFrames(range.sourceStartSec, fps);
    const outFrames = toFrames(range.sourceEndSec, fps);
    const startFrames = toFrames(range.outputStartSec, fps);
    const endFrames = startFrames + Math.max(0, outFrames - inFrames);
    return { inFrames, outFrames, startFrames, endFrames };
  });

  const clipItems = clipFrameRanges
    .map(({ inFrames, outFrames, startFrames, endFrames }, i) => {
      const name = `${mediaName} seg ${i + 1}`;

      return `            <clipitem id="clipitem-${i + 1}">
              <name>${xmlEscape(name)}</name>
              <enabled>TRUE</enabled>
              <start>${startFrames}</start>
              <end>${endFrames}</end>
              <in>${inFrames}</in>
              <out>${outFrames}</out>
              <file id="file-1"></file>
            </clipitem>`;
    })
    .join("\n");

  const sequenceDurationFrames = clipFrameRanges.length > 0
    ? Math.max(...clipFrameRanges.map((clip) => clip.endFrames))
    : 0;

  return `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <project>
    <name>${xmlEscape(projectName)}</name>
    <children>
      <sequence id="sequence-1">
        <name>${xmlEscape(sequenceName)}</name>
        <duration>${sequenceDurationFrames}</duration>
        <rate>
          <timebase>${fps}</timebase>
          <ntsc>FALSE</ntsc>
        </rate>
        <timecode>
          <rate>
            <timebase>${fps}</timebase>
            <ntsc>FALSE</ntsc>
          </rate>
          <frame>${sourceTcFrames}</frame>
          <displayformat>NDF</displayformat>
        </timecode>
        <media>
          <video>
            <format>
              <samplecharacteristics>
                <rate>
                  <timebase>${fps}</timebase>
                  <ntsc>FALSE</ntsc>
                </rate>
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
        <rate>
          <timebase>${fps}</timebase>
          <ntsc>FALSE</ntsc>
        </rate>
        <timecode>
          <rate>
            <timebase>${fps}</timebase>
            <ntsc>FALSE</ntsc>
          </rate>
          <frame>${sourceTcFrames}</frame>
          <displayformat>NDF</displayformat>
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
        <rate>
          <timebase>${fps}</timebase>
          <ntsc>FALSE</ntsc>
        </rate>
      </file>
    </children>
  </project>
</xmeml>
`;
}
