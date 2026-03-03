import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  exportFcpxmlV1,
  exportEdlCmx3600,
  exportPremiereXml,
  buildAafBridgeManifest,
  aafBridgeImporterScript,
} from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseRationalSec(value) {
  const m = /^(\d+)\/(\d+)s$/.exec(value || "");
  if (!m) return 0;
  return Number(m[1]) / Number(m[2]);
}

function toFrames(sec, fps) {
  return Math.max(0, Math.round(sec * fps));
}

function tcToFrames(tc, fps) {
  const m = /^(\d\d):(\d\d):(\d\d):(\d\d)$/.exec(tc || "");
  if (!m) return 0;
  return ((((Number(m[1]) * 60) + Number(m[2])) * 60) + Number(m[3])) * fps + Number(m[4]);
}

function framesToTc(totalFrames, fps) {
  const hh = Math.floor(totalFrames / (fps * 3600));
  const mm = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
  const ss = Math.floor((totalFrames % (fps * 60)) / fps);
  const ff = totalFrames % fps;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

function canonicalFromKeepRanges(keepRanges, fps) {
  return keepRanges
    .filter((r) => r.sourceEndSec > r.sourceStartSec)
    .map((r, i) => {
      const srcIn = toFrames(r.sourceStartSec, fps);
      const srcOut = toFrames(r.sourceEndSec, fps);
      const recIn = toFrames(r.outputStartSec, fps);
      return {
        index: i + 1,
        srcIn,
        srcOut,
        recIn,
        recOut: recIn + Math.max(0, srcOut - srcIn),
      };
    });
}

function parseFcpxmlSegments(xml, sourceTcFrames, fps) {
  const clips = [...xml.matchAll(/<asset-clip[^>]+\/>/g)].map((m) => m[0]);
  return clips.map((tag, i) => {
    const attr = (name) => (new RegExp(`${name}="([^"]+)"`).exec(tag) || [])[1] || "0/1s";
    const recIn = toFrames(parseRationalSec(attr("offset")), fps);
    const srcWithTc = toFrames(parseRationalSec(attr("start")), fps);
    const dur = toFrames(parseRationalSec(attr("duration")), fps);
    const srcIn = srcWithTc - sourceTcFrames;
    return { index: i + 1, srcIn, srcOut: srcIn + dur, recIn, recOut: recIn + dur };
  });
}

function parseEdlSegments(edl, fps) {
  const lines = edl.split(/\r?\n/).filter((l) => /^\d{3}\s+/.test(l));
  return lines.map((line, i) => {
    const tc = line.match(/(\d\d:\d\d:\d\d:\d\d)/g) || [];
    return {
      index: i + 1,
      srcIn: tcToFrames(tc[0], fps),
      srcOut: tcToFrames(tc[1], fps),
      recIn: tcToFrames(tc[2], fps),
      recOut: tcToFrames(tc[3], fps),
    };
  });
}

function parsePremiereSegments(xml) {
  const chunks = [...xml.matchAll(/<clipitem id="clipitem-\d+">([\s\S]*?)<\/clipitem>/g)].map((m) => m[1]);
  return chunks.map((chunk, i) => {
    const v = (tag) => Number((new RegExp(`<${tag}>(\\d+)<\\/${tag}>`).exec(chunk) || [])[1] || 0);
    return { index: i + 1, srcIn: v("in"), srcOut: v("out"), recIn: v("start"), recOut: v("end") };
  });
}

function buildAeMarkersLikeServer(keepRanges) {
  let outputCursor = 0;
  const markers = [];
  for (let i = 0; i < keepRanges.length; i += 1) {
    const range = keepRanges[i];
    const durationSec = Math.max(0, range.sourceEndSec - range.sourceStartSec);
    const clipIndex = i + 1;
    markers.push({
      id: `clip-${clipIndex}-in`,
      sourceTimeSec: Number(range.sourceStartSec.toFixed(6)),
      outputTimeSec: Number(outputCursor.toFixed(6)),
    });
    markers.push({
      id: `clip-${clipIndex}-out`,
      sourceTimeSec: Number(range.sourceEndSec.toFixed(6)),
      outputTimeSec: Number((outputCursor + durationSec).toFixed(6)),
    });
    outputCursor += durationSec;
  }
  return markers;
}

function aeMarkersToSegments(markers, fps) {
  const segments = [];
  for (let i = 0; i < markers.length; i += 2) {
    const a = markers[i];
    const b = markers[i + 1];
    if (!a || !b) continue;
    segments.push({
      index: Math.floor(i / 2) + 1,
      srcIn: toFrames(a.sourceTimeSec, fps),
      srcOut: toFrames(b.sourceTimeSec, fps),
      recIn: toFrames(a.outputTimeSec, fps),
      recOut: toFrames(b.outputTimeSec, fps),
    });
  }
  return segments;
}

function assertNoOverlapAndContinuity(label, segments) {
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    assert.ok(s.srcOut >= s.srcIn, `${label}: negative source duration at ${i + 1}`);
    assert.ok(s.recOut >= s.recIn, `${label}: negative record duration at ${i + 1}`);
    if (i > 0) {
      assert.ok(segments[i - 1].recOut <= s.recIn, `${label}: overlapping output between ${i} and ${i + 1}`);
      assert.equal(segments[i - 1].recOut, s.recIn, `${label}: non-contiguous output between ${i} and ${i + 1}`);
    }
  }
}

function runGoldenParity() {
  const source = {
    path: "/media/demo.mov",
    name: "demo.mov",
    fps: 24,
    timecode: "01:00:00:00",
    durationSec: 45,
  };
  const keepRanges = [
    { sourceStartSec: 0, sourceEndSec: 2.5, outputStartSec: 0 },
    { sourceStartSec: 5, sourceEndSec: 7.25, outputStartSec: 2.5 },
    { sourceStartSec: 10, sourceEndSec: 15, outputStartSec: 4.75 },
  ];

  const expected = canonicalFromKeepRanges(keepRanges, source.fps);
  const sourceTcFrames = tcToFrames(source.timecode, source.fps);

  const fcpxml = parseFcpxmlSegments(exportFcpxmlV1(keepRanges, source), sourceTcFrames, source.fps);
  const edl = parseEdlSegments(exportEdlCmx3600(keepRanges, source), source.fps);
  const premiere = parsePremiereSegments(exportPremiereXml(keepRanges, source));

  const aeMarkers = buildAeMarkersLikeServer(keepRanges);
  const ae = aeMarkersToSegments(aeMarkers, source.fps);

  const manifest = buildAafBridgeManifest(keepRanges, source);
  const manifestSeg = canonicalFromKeepRanges(manifest.keepRanges, source.fps);

  assert.deepEqual(fcpxml, expected, "golden parity: FCPXML mismatch");
  assert.deepEqual(edl, expected, "golden parity: EDL mismatch");
  assert.deepEqual(premiere, expected, "golden parity: Premiere mismatch");
  assert.deepEqual(ae, expected, "golden parity: AE marker scaffold mismatch");
  assert.deepEqual(manifestSeg, expected, "golden parity: AAF manifest mismatch");

  assertNoOverlapAndContinuity("golden/fcpxml", fcpxml);
  assertNoOverlapAndContinuity("golden/edl", edl);
  assertNoOverlapAndContinuity("golden/premiere", premiere);
}

function generateFuzzKeepRanges(seed, fps) {
  const rand = mulberry32(seed);
  const count = 2 + Math.floor(rand() * 6);
  let sourceCursor = 0;
  let outputCursor = 0;
  const ranges = [];
  for (let i = 0; i < count; i += 1) {
    const sourceGap = Math.floor(rand() * 10);
    sourceCursor += sourceGap;
    const dur = 1 + Math.floor(rand() * 20);
    const startFrames = sourceCursor;
    const endFrames = sourceCursor + dur;
    ranges.push({
      sourceStartSec: startFrames / fps,
      sourceEndSec: endFrames / fps,
      outputStartSec: outputCursor / fps,
    });
    sourceCursor = endFrames;
    outputCursor += dur;
  }
  return ranges;
}

function runFuzz() {
  const source = {
    path: "/media/fuzz.mov",
    name: "fuzz.mov",
    fps: 30,
    timecode: "00:00:00:00",
    durationSec: 120,
  };
  for (let seed = 1; seed <= 40; seed += 1) {
    const keepRanges = generateFuzzKeepRanges(seed, source.fps);
    const expected = canonicalFromKeepRanges(keepRanges, source.fps);

    const fcpxml = parseFcpxmlSegments(exportFcpxmlV1(keepRanges, source), 0, source.fps);
    const edl = parseEdlSegments(exportEdlCmx3600(keepRanges, source), source.fps);
    const premiere = parsePremiereSegments(exportPremiereXml(keepRanges, source));

    assert.deepEqual(fcpxml, expected, `fuzz seed ${seed}: fcpxml parity`);
    assert.deepEqual(edl, expected, `fuzz seed ${seed}: edl parity`);
    assert.deepEqual(premiere, expected, `fuzz seed ${seed}: premiere parity`);

    assertNoOverlapAndContinuity(`fuzz ${seed}/fcpxml`, fcpxml);
    assertNoOverlapAndContinuity(`fuzz ${seed}/edl`, edl);
    assertNoOverlapAndContinuity(`fuzz ${seed}/premiere`, premiere);
  }
}

function sliceRouteBlock(source, routePath) {
  const routeStart = source.indexOf(`server.middlewares.use("${routePath}"`);
  assert.ok(routeStart >= 0, `route not found: ${routePath}`);
  const nextRoute = source.indexOf("server.middlewares.use(", routeStart + 1);
  return source.slice(routeStart, nextRoute > routeStart ? nextRoute : undefined);
}

function runDownloadContractChecks() {
  const viteConfig = fs.readFileSync(path.join(repoRoot, "apps/editor-web/vite.config.ts"), "utf-8");
  const ephemeralRoutes = [
    "/api/export/fcpxml/download",
    "/api/export/edl/download",
    "/api/export/premiere/download",
    "/api/export/after-effects-markers/download",
    "/api/export/aaf/download",
  ];

  for (const route of ephemeralRoutes) {
    const block = sliceRouteBlock(viteConfig, route);
    assert.match(block, /fs\.unlinkSync\(job\.outputPath\)/, `${route}: expected ephemeral file cleanup`);
    assert.match(block, /\.delete\(id\)/, `${route}: expected ephemeral job map cleanup`);
  }

  const videoBlock = sliceRouteBlock(viteConfig, "/api/export/download");
  assert.doesNotMatch(videoBlock, /fs\.unlinkSync\(job\.outputPath\)/, "video export: should persist file after download");
  assert.doesNotMatch(videoBlock, /exportJobs\.delete\(id\)/, "video export: should persist job record after download");
}

function runAafPackageSmoke() {
  const source = {
    path: "/media/bridge.mov",
    name: "bridge.mov",
    fps: 24,
    timecode: "01:00:00:00",
    durationSec: 30,
  };
  const keepRanges = [
    { sourceStartSec: 0, sourceEndSec: 3, outputStartSec: 0 },
    { sourceStartSec: 5, sourceEndSec: 9, outputStartSec: 3 },
  ];

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcut-interop-"));
  const zipPath = path.join(tempDir, "bridge.zip");
  try {
    fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify(buildAafBridgeManifest(keepRanges, source), null, 2));
    fs.writeFileSync(path.join(tempDir, "import_aaf.py"), aafBridgeImporterScript("manifest.json"));
    fs.writeFileSync(path.join(tempDir, "timeline.fcpxml"), exportFcpxmlV1(keepRanges, source));
    fs.writeFileSync(path.join(tempDir, "timeline.edl"), exportEdlCmx3600(keepRanges, source));
    fs.writeFileSync(path.join(tempDir, "timeline-premiere.xml"), exportPremiereXml(keepRanges, source));
    fs.writeFileSync(path.join(tempDir, "README.txt"), "AAF bridge package smoke test\n");

    execFileSync("python3", ["-c", "import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[1],'w'); d=pathlib.Path(sys.argv[2]); [z.write(str(d/n), arcname=n) for n in sys.argv[3:]]; z.close()", zipPath, tempDir, "manifest.json", "import_aaf.py", "timeline.fcpxml", "timeline.edl", "timeline-premiere.xml", "README.txt"]);

    const namesCsv = execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(','.join(sorted(z.namelist())))", zipPath], { encoding: "utf-8" }).trim();
    const names = namesCsv.split(",").filter(Boolean);
    assert.deepEqual(names, ["README.txt", "import_aaf.py", "manifest.json", "timeline-premiere.xml", "timeline.edl", "timeline.fcpxml"].sort(), "AAF bridge zip contents");

    const script = aafBridgeImporterScript("manifest.json");
    assert.match(script, /--manifest/, "import_aaf.py should accept --manifest");
    assert.match(script, /--out/, "import_aaf.py should accept --out");
    assert.match(script, /--validate-only/, "import_aaf.py should support --validate-only");
    assert.match(script, /otio\.adapters\.write_to_file\(timeline, str\(out_path\), adapter_name="AAF"\)/, "import_aaf.py should write using OTIO AAF adapter");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCrossFormatContinuityChecks() {
  const source = {
    path: "/media/continuity.mov",
    name: "continuity.mov",
    fps: 24,
    timecode: "00:00:10:00",
    durationSec: 100,
  };
  const keepRanges = [
    { sourceStartSec: 1, sourceEndSec: 2, outputStartSec: 0 },
    { sourceStartSec: 8, sourceEndSec: 11, outputStartSec: 1 },
    { sourceStartSec: 30, sourceEndSec: 33, outputStartSec: 4 },
  ];
  const expected = canonicalFromKeepRanges(keepRanges, source.fps);
  const sourceTcFrames = tcToFrames(source.timecode, source.fps);

  const formats = {
    fcpxml: parseFcpxmlSegments(exportFcpxmlV1(keepRanges, source), sourceTcFrames, source.fps),
    edl: parseEdlSegments(exportEdlCmx3600(keepRanges, source), source.fps),
    premiere: parsePremiereSegments(exportPremiereXml(keepRanges, source)),
    aafManifest: canonicalFromKeepRanges(buildAafBridgeManifest(keepRanges, source).keepRanges, source.fps),
  };

  for (const [label, segs] of Object.entries(formats)) {
    assert.deepEqual(segs, expected, `cross-format continuity/parity: ${label}`);
    assertNoOverlapAndContinuity(`cross-format/${label}`, segs);
  }

  const tailTc = framesToTc(expected.at(-1).recOut, source.fps);
  assert.match(tailTc, /^\d\d:\d\d:\d\d:\d\d$/, "continuity tail timecode formatting sanity");
}

runGoldenParity();
runFuzz();
runDownloadContractChecks();
runAafPackageSmoke();
runCrossFormatContinuityChecks();

console.log("Interop suite passed: parity, fuzz, download contracts, AAF bridge smoke, continuity.");
