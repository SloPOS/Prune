export interface KeepRange {
  sourceStartSec: number;
  sourceEndSec: number;
  outputStartSec: number;
}

export interface SourceMediaMetadata {
  path: string;
  fps: number;
  timecode: string;
  durationSec?: number;
  name?: string;
}

export interface PremiereXmlExportOptions {
  projectName?: string;
  sequenceName?: string;
  width?: number;
  height?: number;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toFrames(sec: number, fps: number): number {
  const fpsInt = Math.max(1, Math.round(fps));
  return Math.max(0, Math.round(sec * fpsInt));
}

function parseTimecodeToFrames(timecode: string, fps: number): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode);
  if (!match) return 0;

  const [, hh, mm, ss, ff] = match;
  const fpsInt = Math.max(1, Math.round(fps));

  return (((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * fpsInt) + Number(ff);
}

function pathToUrl(path: string): string {
  if (path.startsWith("file://")) return path;
  return `file://${encodeURI(path.replaceAll("\\", "/"))}`;
}

export function exportPremiereXml(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: PremiereXmlExportOptions = {},
): string {
  const fps = Math.max(1, Math.round(source.fps));
  const mediaName = source.name ?? source.path.split("/").pop() ?? "source-media";
  const sequenceName = options.sequenceName ?? options.projectName ?? "Bit Cut Timeline";
  const projectName = options.projectName ?? sequenceName;

  const filtered = keepRanges.filter((r) => r.sourceEndSec > r.sourceStartSec);
  const inferredDurationSec = Math.max(0, ...filtered.map((r) => r.sourceEndSec));
  const durationSec = source.durationSec ?? inferredDurationSec;

  const sourceDurationFrames = toFrames(durationSec, fps);
  const sourceTcFrames = parseTimecodeToFrames(source.timecode, fps);

  const clipItems = filtered
    .map((range, i) => {
      const inFrames = toFrames(range.sourceStartSec, fps);
      const outFrames = toFrames(range.sourceEndSec, fps);
      const startFrames = toFrames(range.outputStartSec, fps);
      const endFrames = startFrames + Math.max(0, outFrames - inFrames);
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

  const sequenceDurationFrames = filtered.length > 0
    ? Math.max(...filtered.map((r) => toFrames(r.outputStartSec, fps) + Math.max(0, toFrames(r.sourceEndSec, fps) - toFrames(r.sourceStartSec, fps))))
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
        <pathurl>${xmlEscape(pathToUrl(source.path))}</pathurl>
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
