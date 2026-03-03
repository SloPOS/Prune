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

function parseTimecodeToFrames(timecode: string, rate: Rate): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode);
  if (!match) return 0;

  const [, hh, mm, ss, ff] = match;
  const hours = Number(hh);
  const mins = Number(mm);
  const secs = Number(ss);
  const frames = Number(ff);

  const fpsInt = Math.round(rate.fpsNum / rate.fpsDen);
  return (((hours * 60 + mins) * 60 + secs) * fpsInt) + frames;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pathToFileUrl(path: string): string {
  if (path.startsWith("file://")) return path;
  const normalized = path.replaceAll("\\", "/");
  return `file://${encodeURI(normalized)}`;
}

export function exportFcpxmlV1(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: FcpxmlV1ExportOptions = {},
): string {
  const rate = normalizeRate(source.fps);
  const mediaName = source.name ?? source.path.split("/").pop() ?? "source-media";
  const eventName = options.eventName ?? "prune";
  const projectName = options.projectName ?? "Bit Cut Timeline";
  const sequenceName = options.sequenceName ?? projectName;

  const inferredDurationSec = Math.max(0, ...keepRanges.map((r) => r.sourceEndSec));
  const durationSec = source.durationSec ?? inferredDurationSec;

  const tcStartFrames = parseTimecodeToFrames(source.timecode, rate);
  const sequenceTcStart = fromFrames(tcStartFrames, rate);
  const mediaDuration = fromFrames(toFrames(durationSec, rate), rate);
  const frameDuration = `${rate.fpsDen}/${rate.fpsNum}s`;

  const clips = keepRanges
    .filter((r) => r.sourceEndSec > r.sourceStartSec)
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
