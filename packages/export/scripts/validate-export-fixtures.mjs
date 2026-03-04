import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as exporters from "../dist/index.js";

const { exportFcpxmlV1, exportEdlCmx3600, exportPremiereXml } = exporters;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, "../fixtures/validation");

function getAttr(tag, name) {
  const match = new RegExp(`${name}="([^"]+)"`).exec(tag);
  return match ? match[1] : null;
}

function parseFcpxml(xml) {
  const frameDuration = getAttr(xml.match(/<format[^>]+>/)?.[0] || "", "frameDuration");
  const sequenceTag = xml.match(/<sequence[^>]+>/)?.[0] || "";
  const sequenceTcStart = getAttr(sequenceTag, "tcStart");
  const tcFormat = getAttr(sequenceTag, "tcFormat");
  const clipMatches = [...xml.matchAll(/<asset-clip[^>]+\/>/g)].map((m) => m[0]);
  const clips = clipMatches.map((tag) => ({
    offset: getAttr(tag, "offset"),
    start: getAttr(tag, "start"),
    duration: getAttr(tag, "duration"),
  }));
  return { frameDuration, sequenceTcStart, tcFormat, clips };
}

function parseEdl(edl) {
  const lines = edl.split(/\r?\n/).map((line) => line.trimEnd());
  const title = lines.find((l) => l.startsWith("TITLE:"))?.replace("TITLE:", "").trim() ?? "";
  const eventLines = lines.filter((l) => /^\d{3}\s+/.test(l));
  const events = eventLines.map((line) => {
    const tc = line.match(/(\d\d:\d\d:\d\d:\d\d)/g) || [];
    return {
      srcIn: tc[0],
      srcOut: tc[1],
      recIn: tc[2],
      recOut: tc[3],
    };
  });
  return { title, events };
}

function parsePremiereXml(xml) {
  const sequenceDuration = Number((xml.match(/<sequence id="sequence-1">[\s\S]*?<duration>(\d+)<\/duration>/) || [])[1] || 0);
  const timebase = Number((xml.match(/<sequence id="sequence-1">[\s\S]*?<timebase>(\d+)<\/timebase>/) || [])[1] || 0);
  const sequenceNtsc = (xml.match(/<sequence id="sequence-1">[\s\S]*?<ntsc>(TRUE|FALSE)<\/ntsc>/) || [])[1] || null;
  const tcFrame = Number((xml.match(/<sequence id="sequence-1">[\s\S]*?<frame>(\d+)<\/frame>/) || [])[1] || 0);
  const tcDisplayFormat = (xml.match(/<sequence id="sequence-1">[\s\S]*?<displayformat>(DF|NDF)<\/displayformat>/) || [])[1] || null;

  const clipChunks = [...xml.matchAll(/<clipitem id="clipitem-\d+">([\s\S]*?)<\/clipitem>/g)].map((m) => m[1]);
  const clips = clipChunks.map((chunk) => ({
    start: Number((chunk.match(/<start>(\d+)<\/start>/) || [])[1] || 0),
    end: Number((chunk.match(/<end>(\d+)<\/end>/) || [])[1] || 0),
    in: Number((chunk.match(/<in>(\d+)<\/in>/) || [])[1] || 0),
    out: Number((chunk.match(/<out>(\d+)<\/out>/) || [])[1] || 0),
    hasFileNode: /<file id="file-1"\s*(?:\/>|><\/file>)/.test(chunk),
    hasEscapedFileNode: /&lt;file\b/.test(chunk),
  }));

  const masterClipChunk = (xml.match(/<clipitem id="masterclipitem-1">([\s\S]*?)<\/clipitem>/) || [])[1] || "";

  return {
    sequenceDuration,
    timebase,
    sequenceNtsc,
    tcFrame,
    tcDisplayFormat,
    clips,
    hasEscapedFileAnywhere: /&lt;file\b/.test(xml),
    hasMasterFileNode: /<file id="file-1"\s*(?:\/>|><\/file>)/.test(masterClipChunk),
  };
}

function runFixture(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const { source, keepRanges, expect } = fixture;

  const fcpxml = exportFcpxmlV1(keepRanges, source, {
    projectName: fixture.name,
    sequenceName: fixture.name,
    eventName: "export-validation",
  });
  const edl = exportEdlCmx3600(keepRanges, source, {
    title: expect.edl.title,
    reel: source.name,
  });

  const premiereXml = typeof exportPremiereXml === "function"
    ? exportPremiereXml(keepRanges, source, {
      projectName: fixture.name,
      sequenceName: fixture.name,
    })
    : null;

  const fcpxmlParsed = parseFcpxml(fcpxml);
  const edlParsed = parseEdl(edl);

  assert.equal(fcpxmlParsed.frameDuration, expect.fcpxml.frameDuration, `${fixture.name}: frameDuration`);
  assert.equal(fcpxmlParsed.sequenceTcStart, expect.fcpxml.sequenceTcStart, `${fixture.name}: sequence tcStart`);
  if (expect.fcpxml.tcFormat) {
    assert.equal(fcpxmlParsed.tcFormat, expect.fcpxml.tcFormat, `${fixture.name}: FCPXML tcFormat`);
  }
  assert.deepEqual(fcpxmlParsed.clips, expect.fcpxml.clips, `${fixture.name}: FCPXML clip boundaries`);

  assert.equal(edlParsed.title, expect.edl.title, `${fixture.name}: EDL title`);
  assert.deepEqual(edlParsed.events, expect.edl.events, `${fixture.name}: EDL event/source-record timecodes`);

  for (let i = 1; i < edlParsed.events.length; i += 1) {
    const prev = edlParsed.events[i - 1];
    const next = edlParsed.events[i];
    assert.equal(prev.recOut, next.recIn, `${fixture.name}: output continuity between event ${i} and ${i + 1}`);
  }

  if (premiereXml && expect.premiere) {
    const premiereParsed = parsePremiereXml(premiereXml);
    assert.equal(premiereParsed.sequenceDuration, expect.premiere.sequenceDuration, `${fixture.name}: Premiere sequence duration`);
    assert.equal(premiereParsed.timebase, expect.premiere.timebase, `${fixture.name}: Premiere timebase`);
    if (expect.premiere.ntsc) {
      assert.equal(premiereParsed.sequenceNtsc, expect.premiere.ntsc, `${fixture.name}: Premiere ntsc flag`);
    }
    assert.equal(premiereParsed.tcFrame, expect.premiere.tcFrame, `${fixture.name}: Premiere tc frame`);
    if (expect.premiere.displayFormat) {
      assert.equal(premiereParsed.tcDisplayFormat, expect.premiere.displayFormat, `${fixture.name}: Premiere display format`);
    }
    assert.deepEqual(
      premiereParsed.clips.map((clip) => ({
        start: clip.start,
        end: clip.end,
        in: clip.in,
        out: clip.out,
      })),
      expect.premiere.clips,
      `${fixture.name}: Premiere clip boundaries`,
    );

    assert.equal(premiereParsed.hasEscapedFileAnywhere, false, `${fixture.name}: Premiere XML should not contain escaped <file> tags`);
    assert.equal(premiereParsed.hasMasterFileNode, true, `${fixture.name}: Premiere master clipitem should contain a nested <file> element`);

    for (let i = 0; i < premiereParsed.clips.length; i += 1) {
      assert.equal(premiereParsed.clips[i].hasEscapedFileNode, false, `${fixture.name}: Premiere clip ${i + 1} should not contain escaped <file> text`);
      assert.equal(premiereParsed.clips[i].hasFileNode, true, `${fixture.name}: Premiere clip ${i + 1} should contain nested <file> element`);
    }

    for (let i = 1; i < premiereParsed.clips.length; i += 1) {
      assert.equal(
        premiereParsed.clips[i - 1].end,
        premiereParsed.clips[i].start,
        `${fixture.name}: Premiere output continuity between clip ${i} and ${i + 1}`,
      );
    }
  }

  console.log(`✓ ${fixture.name}`);
}

const fixtures = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

assert.ok(fixtures.length >= 3, "Need at least 3 validation fixtures");

for (const fixture of fixtures) {
  runFixture(path.join(fixturesDir, fixture));
}

console.log(`\nValidated ${fixtures.length} export fixtures (FCPXML + EDL).`);
