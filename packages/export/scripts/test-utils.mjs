import assert from "node:assert/strict";
import {
  createTimecodeFormatter,
  framesToTimecode,
  parseTimecodeToFrames,
} from "../dist/utils.js";

function runParseTimecodeValidationChecks() {
  assert.equal(parseTimecodeToFrames("00:10:59:29", 30), 19799, "valid NDF parse should pass");
  assert.equal(parseTimecodeToFrames("00:00:00;00", 30), 0, "valid DF parse should pass");

  assert.equal(parseTimecodeToFrames("00:60:00:00", 30), 0, "invalid minute should be rejected");
  assert.equal(parseTimecodeToFrames("00:00:60:00", 30), 0, "invalid second should be rejected");
  assert.equal(parseTimecodeToFrames("00:00:00:30", 30), 0, "invalid frame index should be rejected");
}

function runFormatterParityChecks() {
  const formatter = createTimecodeFormatter(29.97, { dropFrame: true, maxCacheEntries: 32 });
  const frames = [0, 1, 2, 1798, 17982, 100001];

  for (const totalFrames of frames) {
    assert.equal(
      formatter(totalFrames),
      framesToTimecode(totalFrames, 29.97, { dropFrame: true }),
      `formatter parity for ${totalFrames} frames`,
    );
  }

  // Re-run a cached value to ensure cache path parity stays correct.
  assert.equal(formatter(17982), framesToTimecode(17982, 29.97, { dropFrame: true }));
}

runParseTimecodeValidationChecks();
runFormatterParityChecks();

console.log("Utils suite passed: parse validation + formatter parity.");
