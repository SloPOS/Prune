import { useMemo, useState } from "react";
import { cutRangesFromDeletedTokens, keepRangesFromCuts } from "@bit-cut/core";
import { mockTranscript } from "./mockTranscript";

const MOCK_DURATION_SEC = 8;

export function App() {
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  const cuts = useMemo(
    () => cutRangesFromDeletedTokens(mockTranscript, deleted),
    [deleted],
  );
  const keeps = useMemo(() => keepRangesFromCuts(MOCK_DURATION_SEC, cuts), [cuts]);

  function toggle(id: string) {
    setDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="page">
      <div className="pane videoPane">
        <h2>Video</h2>
        <video controls width={640} src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" />
      </div>

      <div className="pane transcriptPane">
        <h2>Transcript (click words to cut)</h2>
        <div className="tokens">
          {mockTranscript.map((t) => {
            const isDeleted = deleted.has(t.id);
            return (
              <button key={t.id} onClick={() => toggle(t.id)} className={isDeleted ? "token deleted" : "token"}>
                {t.text}
              </button>
            );
          })}
        </div>

        <h3>Computed cut ranges</h3>
        <pre>{JSON.stringify(cuts, null, 2)}</pre>

        <h3>Computed keep ranges</h3>
        <pre>{JSON.stringify(keeps, null, 2)}</pre>
      </div>
    </div>
  );
}
