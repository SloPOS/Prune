import type { WordToken } from "@prune/core";

export const mockTranscript: WordToken[] = [
  { id: "w1", text: "Hey", startSec: 0.2, endSec: 0.4 },
  { id: "w2", text: "everyone", startSec: 0.41, endSec: 0.8 },
  { id: "w3", text: "um", startSec: 0.81, endSec: 0.92 },
  { id: "w4", text: "today", startSec: 0.93, endSec: 1.2 },
  { id: "w5", text: "we're", startSec: 1.21, endSec: 1.4 },
  { id: "w6", text: "building", startSec: 1.41, endSec: 1.8 },
  { id: "w7", text: "this", startSec: 1.81, endSec: 2.0 },
  { id: "w8", text: "thing", startSec: 2.01, endSec: 2.3 }
];
