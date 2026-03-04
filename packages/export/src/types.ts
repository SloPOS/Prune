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
