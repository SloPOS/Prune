import path from "node:path";
import fs from "node:fs";
import { probeMediaDetails, probeFcpxmlMetadata, probeDurationSec } from "../lib/probe.js";

export async function infoCommand(mediaPath: string): Promise<void> {
  const absMedia = path.resolve(mediaPath);
  if (!fs.existsSync(absMedia)) {
    console.error(`Error: File not found: ${mediaPath}`);
    process.exit(1);
  }

  const details = probeMediaDetails(absMedia);
  const fcpxmlMeta = probeFcpxmlMetadata(absMedia);
  const duration = probeDurationSec(absMedia) ?? details?.durationSec ?? 0;

  console.log(`File: ${absMedia}`);
  console.log(`Container: ${details?.container ?? "unknown"}`);
  console.log(`Duration: ${duration.toFixed(2)}s`);

  if (details && details.width && details.height) {
    console.log(`Video: ${details.videoCodec} ${details.width}x${details.height} @ ${details.fps}fps`);
  } else {
    console.log("Video: none");
  }

  if (details && details.audioCodec !== "none") {
    console.log(`Audio: ${details.audioCodec} ${details.audioSampleRate}Hz ${details.audioChannels}ch`);
  } else {
    console.log("Audio: none");
  }

  if (fcpxmlMeta.timecode) {
    console.log(`Timecode: ${fcpxmlMeta.timecode}`);
  }

  if (details && details.bitRate) {
    console.log(`Bitrate: ${(details.bitRate / 1000).toFixed(0)} kbps`);
  }
}
